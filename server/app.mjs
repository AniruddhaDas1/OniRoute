import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { db, LOCAL_USER_ID } from './db.mjs';
import { sha256, createGatewayKey } from './crypto.mjs';
import {
  buildProviderRequest,
  normaliseMessages,
  parseProviderResponse,
  embedText,
  pruneContextToBudget,
} from './provider-client.mjs';
import { searchVectorChunks } from './vector.mjs';
import { splitChunks } from './chunking.mjs';
import { sourceFromGitHub } from './github.mjs';

export const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'apikey', 'x-client-info', 'x-oniroute-key'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

function ok(data) {
  return { data, error: null };
}
function err(message) {
  return { data: null, error: message };
}

function isFailoverError(status) {
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500;
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function sendToProvider(provider, apiKey, messages, options, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const req = buildProviderRequest(provider, apiKey, messages, options);
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, latencyMs, status: res.status, error: (await res.text()).slice(0, 600) };
    }
    const parsed = parseProviderResponse(provider, await res.json());
    if (!parsed.content) {
      return { ok: false, latencyMs, status: 502, error: 'Provider returned an empty response.' };
    }
    return { ok: true, latencyMs, parsed };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, status: 503, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function refineUserMessage(providers, userMessage, refinePrompt, timeoutMs) {
  for (const provider of providers) {
    const apiKey = db.getProviderSecret(provider.id);
    if (!apiKey) continue;
    const res = await sendToProvider(
      provider,
      apiKey,
      [
        { role: 'system', content: refinePrompt },
        { role: 'user', content: userMessage },
      ],
      { maxTokens: 512, temperature: 0.3 },
      timeoutMs,
    );
    if (res.ok && res.parsed?.content?.trim()) {
      return res.parsed.content.trim();
    }
  }
  return userMessage;
}

async function routedChat(body, userId = LOCAL_USER_ID, keyRecord = null) {
  let mode = body.mode === 'refined' ? 'refined' : 'direct';
  if (keyRecord?.gateway_mode && keyRecord.gateway_mode !== 'flexible') {
    mode = keyRecord.gateway_mode;
  }

  const config = db.getRoutingConfig(userId);
  let allProviders = db.getProviders(userId).filter((p) => p.is_active);

  let candidateProviderIds = null;
  let keyOrGroupRoutingMode = keyRecord?.routing_mode || null;

  if (keyRecord?.provider_group_id) {
    const group = db.getProviderGroupById(keyRecord.provider_group_id, userId);
    if (group) {
      candidateProviderIds = group.provider_ids || [];
      if (!keyOrGroupRoutingMode) {
        keyOrGroupRoutingMode = group.routing_mode;
      }
    }
  } else if (Array.isArray(keyRecord?.selected_provider_ids) && keyRecord.selected_provider_ids.length) {
    candidateProviderIds = keyRecord.selected_provider_ids;
  }

  let providers = allProviders;
  if (candidateProviderIds && candidateProviderIds.length) {
    const idToProvider = new Map(allProviders.map((p) => [p.id, p]));
    providers = candidateProviderIds
      .map((id) => idToProvider.get(id))
      .filter((p) => Boolean(p && p.is_active));
  }

  const effectiveRoutingMode = keyOrGroupRoutingMode || config.mode || 'priority';
  if (effectiveRoutingMode === 'random') {
    providers = shuffle(providers);
  }

  if (!providers.length) {
    throw new Error(
      keyRecord?.provider_group_id
        ? 'No active AI providers available in the assigned Provider Group.'
        : 'No active AI providers configured in OniRoute. Add one in the dashboard.'
    );
  }

  const turns = [];
  const systemBlocks = [];
  if (body.system_prompt?.trim()) systemBlocks.push(body.system_prompt.trim());

  if (Array.isArray(body.messages) && body.messages.length) {
    const normalised = normaliseMessages(body.messages);
    for (const msg of normalised) {
      if (msg.role === 'system') systemBlocks.push(msg.content);
      else turns.push(msg);
    }
  } else if (body.message?.trim()) {
    turns.push({ role: 'user', content: body.message.trim() });
  }

  if (!turns.length) throw new Error('A message or messages array is required.');

  // Refine message if configured
  const refinePrompt = body.refine_prompt?.trim() ?? config.refine_prompt?.trim();
  if (refinePrompt && turns.some((t) => t.role === 'user')) {
    const lastUserIdx = turns.map((t) => t.role).lastIndexOf('user');
    const refined = await refineUserMessage(providers, turns[lastUserIdx].content, refinePrompt, config.timeout_ms);
    turns[lastUserIdx] = { role: 'user', content: refined };
  }

  let contextUsed = [];
  if (mode === 'refined') {
    let embeddingProviderId = body.embedding_provider_id;
    if (!embeddingProviderId && body.knowledge_base_id) {
      const kb = db.getKnowledgeBaseById(body.knowledge_base_id, userId);
      embeddingProviderId = kb?.embedding_provider_id;
    }
    const embeddingProvider = providers.find((p) => p.id === embeddingProviderId) || providers[0];
    const apiKey = db.getProviderSecret(embeddingProvider.id);
    if (!apiKey) throw new Error('Embedding provider secret is missing.');

    const query = turns.filter((t) => t.role === 'user').at(-1)?.content ?? '';
    const queryEmbedding = await embedText(embeddingProvider, apiKey, query);
    const matches = searchVectorChunks(userId, queryEmbedding, body.knowledge_base_id, 6);
    contextUsed = matches.map((m) => m.content);

    if (contextUsed.length) {
      systemBlocks.push(
        'Answer using the supplied knowledge when relevant. If the knowledge does not contain the answer, say so clearly.' +
          `\n\nKnowledge:\n${contextUsed.join('\n\n---\n\n')}`,
      );
    }
  }

  // Enforce isolated context window budget if configured for this key/request
  const effectiveMaxTokens = body.max_context_tokens || keyRecord?.max_context_tokens;
  const messages = pruneContextToBudget(systemBlocks, turns, effectiveMaxTokens);
  const maxAttempts = Math.min(providers.length, (config.max_retries ?? 3) + 1);
  const failures = [];

  for (const provider of providers.slice(0, maxAttempts)) {
    const apiKey = db.getProviderSecret(provider.id);
    if (!apiKey) {
      failures.push(`${provider.name}: No API key`);
      continue;
    }
    const result = await sendToProvider(provider, apiKey, messages, body, config.timeout_ms);
    if (result.ok) {
      db.writeLog({
        user_id: userId,
        provider_id: provider.id,
        status: 'success',
        latency_ms: result.latencyMs,
        mode,
        usage: result.parsed.usage,
      });
      return {
        response: result.parsed.content,
        provider_used: provider.name,
        provider_id: provider.id,
        model: result.parsed.model,
        finish_reason: result.parsed.finishReason,
        usage: result.parsed.usage,
        latency_ms: result.latencyMs,
        mode,
        context_used: mode === 'refined' ? contextUsed : undefined,
      };
    }

    failures.push(`${provider.name}: ${result.error}`);
    db.writeLog({
      user_id: userId,
      provider_id: provider.id,
      status: isFailoverError(result.status) ? 'failover' : 'error',
      latency_ms: result.latencyMs,
      mode,
      error_message: result.error,
    });

    if (!config.failover_enabled || !isFailoverError(result.status)) break;
  }

  throw new Error(`All providers failed. ${failures.join(' | ')}`);
}

// =============================================================================
// REST Routes
// =============================================================================

// Providers
app.get('/providers', (c) => c.json(ok(db.getProviders())));
app.post('/providers', async (c) => {
  const body = await c.req.json();
  const provider = db.createProvider(body, body.api_key);
  return c.json(ok(provider), 201);
});
app.put('/providers/reorder', async (c) => {
  const { provider_ids } = await c.req.json();
  db.reorderProviders(provider_ids);
  return c.json(ok({ reordered: provider_ids }));
});
app.put('/providers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const provider = db.updateProvider(id, body, body.api_key);
  return provider ? c.json(ok(provider)) : c.json(err('Not found'), 404);
});
app.delete('/providers/:id', (c) => {
  const deleted = db.deleteProvider(c.req.param('id'));
  return c.json(ok({ deleted }));
});
app.get('/providers/:id/secret', (c) => {
  const provider = db.getProviderById(c.req.param('id'));
  if (!provider) return c.json(err('Not found'), 404);
  const secret = db.getProviderSecret(provider.id);
  return c.json(ok({ api_key: secret || '', exists: Boolean(secret) }));
});
app.post('/test-provider/:id', async (c) => {
  const provider = db.getProviderById(c.req.param('id'));
  if (!provider) return c.json(err('Not found'), 404);
  const apiKey = db.getProviderSecret(provider.id);
  const result = await sendToProvider(
    provider,
    apiKey,
    [{ role: 'user', content: 'Reply with exactly: OniRoute connection successful.' }],
    { maxTokens: 64 },
    10000,
  );
  return c.json(
    ok(
      result.ok
        ? { success: true, latency_ms: result.latencyMs, response: result.parsed.content }
        : { success: false, latency_ms: result.latencyMs, error: result.error },
    ),
  );
});

// Routing
app.get('/routing-config', (c) => c.json(ok(db.getRoutingConfig())));
app.put('/routing-config', async (c) => {
  const body = await c.req.json();
  const updated = db.updateRoutingConfig(body);
  return c.json(ok(updated));
});

// Knowledge Bases
app.get('/knowledge', (c) => c.json(ok(db.getKnowledgeBases())));
app.post('/knowledge', async (c) => {
  const body = await c.req.json();
  const kb = db.createKnowledgeBase(body);
  return c.json(ok(kb), 201);
});
app.delete('/knowledge/:id', (c) => {
  const deleted = db.deleteKnowledgeBase(c.req.param('id'));
  return c.json(ok({ deleted }));
});

// Asynchronous Ingest
app.post('/knowledge/:id/ingest', async (c) => {
  const id = c.req.param('id');
  const kb = db.getKnowledgeBaseById(id);
  if (!kb) return c.json(err('Not found'), 404);

  const body = await c.req.json().catch(() => ({}));
  const providerId = body.embedding_provider_id || kb.embedding_provider_id;
  const provider = db.getProviderById(providerId) || db.getProviders()[0];
  if (!provider) return c.json(err('Select an embedding provider first.'), 400);

  db.updateKnowledgeBase(id, { status: 'processing', ingest_started_at: new Date().toISOString() });

  // Async ingestion in background
  (async () => {
    try {
      let content = kb.source_content;
      if (kb.source_type === 'repo') {
        const repo = await sourceFromGitHub(kb.source_url);
        content = repo.content;
      }
      const split = splitChunks(content);
      const apiKey = db.getProviderSecret(provider.id);
      const vectors = [];

      for (let i = 0; i < split.chunks.length; i++) {
        const embedding = await embedText(provider, apiKey, split.chunks[i]);
        vectors.push({ content: split.chunks[i], embedding, metadata: { index: i } });
      }

      db.replaceVectorChunks(id, vectors);
      db.updateKnowledgeBase(id, {
        status: 'complete',
        chunk_count: vectors.length,
        ingest_completed_at: new Date().toISOString(),
        ingest_stats: { chunks_total: vectors.length, chunks_embedded: vectors.length },
      });
    } catch (e) {
      db.updateKnowledgeBase(id, { status: 'error', error_message: e.message });
    }
  })();

  return c.json(ok({ queued: true }), 202);
});

// Provider Groups
app.get('/provider-groups', (c) => c.json(ok(db.getProviderGroups())));
app.post('/provider-groups', async (c) => {
  const body = await c.req.json();
  const group = db.createProviderGroup(body);
  return c.json(ok(group), 201);
});
app.put('/provider-groups/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const updated = db.updateProviderGroup(id, body);
  if (!updated) return c.json(err('Provider group not found'), 404);
  return c.json(ok(updated));
});
app.delete('/provider-groups/:id', (c) => {
  const deleted = db.deleteProviderGroup(c.req.param('id'));
  return c.json(ok({ deleted }));
});

// Logs
app.get('/logs', (c) => {
  const limit = Number(c.req.query('limit') || 50);
  const status = c.req.query('status') || null;
  return c.json(ok({ logs: db.getLogs(LOCAL_USER_ID, limit, status), next_cursor: null }));
});

// Gateway Keys
app.get('/gateway-keys', (c) => c.json(ok(db.getGatewayKeys())));
app.post('/gateway-keys', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const key = createGatewayKey();
  const keyHash = sha256(key);
  const record = db.createGatewayKey(
    body.name,
    `${key.slice(0, 11)}…`,
    keyHash,
    LOCAL_USER_ID,
    body.max_context_tokens,
    {
      provider_group_id: body.provider_group_id,
      routing_mode: body.routing_mode,
      gateway_mode: body.gateway_mode,
      selected_provider_ids: body.selected_provider_ids,
    }
  );
  return c.json(ok({ ...record, key }), 201);
});
app.delete('/gateway-keys/:id', (c) => {
  const revoked = db.revokeGatewayKey(c.req.param('id'));
  return c.json(ok({ revoked }));
});

// Inference Routes (OpenAI compatible)
// --- Super Admin & Member Management ---
app.get('/admin/members', (c) => {
  return c.json(ok(db.getMembers()));
});

app.patch('/admin/members/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updated = db.updateMember(id, body);
    if (!updated) return c.json(err('Member not found'), 404);
    return c.json(ok(updated));
  } catch (error) {
    return c.json(err(error.message), 400);
  }
});

app.post('/chat', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const customKey = c.req.header('x-oniroute-key') || authHeader.replace(/^Bearer\s+/i, '');
    let keyRecord = null;
    if (customKey && customKey.startsWith('or_')) {
      keyRecord = db.getGatewayKeyByHash(sha256(customKey));
      if (!keyRecord) return c.json(err('Invalid or revoked OniRoute key.'), 401);
      db.touchGatewayKey(keyRecord.id);
    }
    const body = await c.req.json();
    const result = await routedChat(body, LOCAL_USER_ID, keyRecord);
    return c.json(ok(result));
  } catch (error) {
    return c.json(err(error.message), 400);
  }
});

app.post('/v1/chat/completions', async (c) => {
  try {
    const authHeader = c.req.header('Authorization') || '';
    const customKey = c.req.header('x-oniroute-key') || authHeader.replace(/^Bearer\s+/i, '');
    let keyRecord = null;

    if (customKey && customKey.startsWith('or_')) {
      keyRecord = db.getGatewayKeyByHash(sha256(customKey));
      if (!keyRecord) return c.json({ error: { message: 'Invalid or revoked OniRoute key.' } }, 401);
      db.touchGatewayKey(keyRecord.id);
    }

    const body = await c.req.json();
    const result = await routedChat(body, LOCAL_USER_ID, keyRecord);

    return c.json({
      id: `chatcmpl_${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: result.response }, finish_reason: result.finish_reason },
      ],
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      oniroute: { provider: result.provider_used, mode: result.mode, latency_ms: result.latency_ms },
    });
  } catch (error) {
    return c.json({ error: { message: error.message, type: 'routing_error' } }, 502);
  }
});

// Models endpoint (Standard OpenAI client discovery)
app.get('/v1/models', (c) => {
  const providers = db.getProviders();
  return c.json({
    object: 'list',
    data: providers.map((p) => ({
      id: p.name.toLowerCase().replace(/\s+/g, '-'),
      object: 'model',
      created: 1700000000,
      owned_by: 'oniroute',
    })),
  });
});

app.get('/health', (c) => c.json({ status: 'ok', server: 'oniroute-local', port: 1001 }));
