// OniRoute knowledge ingestion worker.
//
// Ingestion used to run inline in the request that triggered it: up to 80
// sequential GitHub API calls followed by up to 100 sequential embedding calls,
// with no timeout on any of them. That regularly outlived the Edge Function wall
// clock, and when it did the knowledge base was left stuck in `processing`
// forever with no way to retry it.
//
// It now runs here, invoked in the background by `POST /knowledge/:id/ingest`,
// which returns 202 immediately. Progress is written back to
// `knowledge_bases.ingest_stats` so the dashboard can poll it.

import { getServiceClient, isTrustedInternalCaller } from '../_shared/auth.ts';
import { splitChunks } from '../_shared/chunking.ts';
import { embedText } from '../_shared/embedding.ts';
import { sourceFromGitHub } from '../_shared/github.ts';
import { mapWithConcurrency, messageOf } from '../_shared/runtime.ts';
import type { ApiProvider, IngestStats, KnowledgeBase } from '../_shared/types.ts';

/** How long a claimed job may run before another worker may reclaim it. */
const LEASE_SECONDS = 900;
/** Embedding calls in flight. Kept low: providers rate-limit aggressively. */
const EMBED_CONCURRENCY = 4;
/** Rows per insert. Large enough to be cheap, small enough to stay under the
 *  request size limit at 1536 floats per row. */
const INSERT_BATCH = 20;
/** Write progress back this often so the dashboard's poll has something to show. */
const PROGRESS_EVERY = 20;

interface SourceText {
  content: string;
  stats: IngestStats;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Resolve the text to embed, whatever the source type. */
async function readSource(base: KnowledgeBase): Promise<SourceText> {
  if (base.source_type === 'repo') {
    if (!base.source_url) throw new Error('This knowledge base has no repository URL.');
    const repo = await sourceFromGitHub(base.source_url);
    return {
      content: repo.content,
      stats: { files_read: repo.filesRead, files_skipped: repo.filesSkipped, warnings: repo.warnings },
    };
  }

  const content = base.source_content?.trim();
  if (!content) throw new Error('This knowledge base has no stored content to ingest.');
  return { content, stats: {} };
}

async function readProvider(base: KnowledgeBase): Promise<{ provider: ApiProvider; apiKey: string }> {
  const service = getServiceClient();
  if (!base.embedding_provider_id) throw new Error('No embedding provider is selected for this knowledge base.');

  // Ownership is re-checked here rather than trusted from the enqueuing request:
  // the provider could have been reassigned or deleted while the job was queued.
  const { data: provider } = await service
    .from('ai_providers')
    .select('*')
    .eq('id', base.embedding_provider_id)
    .eq('user_id', base.user_id)
    .maybeSingle();
  if (!provider) throw new Error('The selected embedding provider no longer exists.');

  const { data: apiKey, error } = await service.rpc('get_provider_secret', { p_provider_id: provider.id });
  if (error || !apiKey) throw new Error('The embedding provider has no stored API key.');

  return { provider: provider as ApiProvider, apiKey: apiKey as string };
}

async function saveProgress(id: string, stats: IngestStats): Promise<void> {
  await getServiceClient().from('knowledge_bases').update({ ingest_stats: stats }).eq('id', id);
}

async function fail(id: string, message: string, stats: IngestStats): Promise<void> {
  await getServiceClient().from('knowledge_bases').update({
    status: 'error',
    error_message: message.slice(0, 1000),
    ingest_completed_at: new Date().toISOString(),
    ingest_stats: stats,
  }).eq('id', id);
}

async function ingest(base: KnowledgeBase): Promise<IngestStats> {
  const service = getServiceClient();
  const stats: IngestStats = { ...(base.ingest_stats ?? {}) };

  const [{ provider, apiKey }, source] = await Promise.all([readProvider(base), readSource(base)]);
  Object.assign(stats, source.stats);

  const split = splitChunks(source.content);
  if (!split.chunks.length) throw new Error('The source produced no text long enough to embed.');

  stats.source_chars = split.sourceChars;
  stats.chunks_total = split.chunks.length;
  stats.chunks_embedded = 0;
  stats.truncated = split.truncated;
  if (split.truncationReason) stats.truncation_reason = split.truncationReason;
  await saveProgress(base.id, stats);

  // Heartbeat lease renewal: periodically touch ingest_started_at every 60s
  // so legitimate large ingestion jobs never expire prematurely while running.
  const leaseHeartbeat = setInterval(async () => {
    try {
      await service
        .from('knowledge_bases')
        .update({ ingest_started_at: new Date().toISOString() })
        .eq('id', base.id)
        .eq('status', 'processing');
    } catch {
      // Non-fatal heartbeat error
    }
  }, 60_000);

  let embedded = 0;
  let vectors: any[] = [];
  try {
    vectors = await mapWithConcurrency(split.chunks, EMBED_CONCURRENCY, async (chunk, index) => {
      const embedding = await embedText(provider, apiKey, chunk);
      embedded += 1;
      if (embedded % PROGRESS_EVERY === 0) {
        // Fire-and-forget: a failed progress write must not fail the ingestion.
        saveProgress(base.id, { ...stats, chunks_embedded: embedded }).catch(() => {});
      }
      return { content: chunk, embedding, index };
    });

    // Replace rather than append, so re-ingesting a source does not leave stale
    // chunks from the previous revision alongside the new ones.
    const { error: clearError } = await service.from('vector_chunks').delete().eq('knowledge_base_id', base.id);
    if (clearError) throw new Error(`Could not clear the previous chunks: ${clearError.message}`);

    for (let start = 0; start < vectors.length; start += INSERT_BATCH) {
      const batch = vectors.slice(start, start + INSERT_BATCH).map((vector) => ({
        knowledge_base_id: base.id,
        user_id: base.user_id,
        content: vector.content,
        metadata: { chunk_index: vector.index, source_type: base.source_type },
        embedding: vector.embedding,
      }));
      const { error } = await service.from('vector_chunks').insert(batch);
      if (error) throw new Error(`Could not store chunks ${start}–${start + batch.length}: ${error.message}`);
    }

    stats.chunks_embedded = vectors.length;
    await service.from('knowledge_bases').update({
      status: 'complete',
      error_message: null,
      chunk_count: vectors.length,
      ingest_completed_at: new Date().toISOString(),
      ingest_stats: stats,
    }).eq('id', base.id);

    return stats;
  } finally {
    clearInterval(leaseHeartbeat);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  // Only the gateway function may drive the worker. `verify_jwt` alone is not
  // enough — that would accept any signed-in user's token.
  if (!isTrustedInternalCaller(req.headers.get('Authorization'))) {
    return json({ error: 'Forbidden.' }, 403);
  }

  let knowledgeBaseId: string;
  try {
    const body = await req.json();
    knowledgeBaseId = String(body?.knowledge_base_id ?? '');
    if (!knowledgeBaseId) throw new Error('missing id');
  } catch {
    return json({ error: 'knowledge_base_id is required.' }, 400);
  }

  // Atomically take the job. A NULL result means a live worker already holds
  // the lease, which is what makes a duplicate trigger harmless rather than a
  // race that embeds everything twice.
  const { data: claimed, error: claimError } = await getServiceClient()
    .rpc('claim_knowledge_ingest', { p_knowledge_base_id: knowledgeBaseId, p_stale_seconds: LEASE_SECONDS });
  if (claimError) return json({ error: `Could not claim the job: ${claimError.message}` }, 500);
  if (!claimed) return json({ skipped: true, reason: 'Already being ingested, or not found.' }, 200);

  const base = claimed as KnowledgeBase;
  try {
    const stats = await ingest(base);
    return json({ knowledge_base_id: base.id, status: 'complete', stats });
  } catch (error) {
    const message = messageOf(error);
    // The lease is released by moving out of `processing`, so a failed job is
    // immediately retryable from the dashboard.
    await fail(base.id, message, base.ingest_stats ?? {});
    console.error(`[embed-knowledge:${base.id}]`, message);
    return json({ knowledge_base_id: base.id, status: 'error', error: message }, 200);
  }
});
