import { FormEvent, useEffect, useState } from 'react';
import { BookOpen, Database, Loader2, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider, KnowledgeBase } from '../types';

const ACTIVE: KnowledgeBase['status'][] = ['queued', 'processing'];
const POLL_MS = 3000;

function progressOf(base: KnowledgeBase): string | null {
  const total = base.ingest_stats?.chunks_total;
  return typeof total === 'number' && total > 0
    ? `${base.ingest_stats?.chunks_embedded ?? 0} / ${total} chunks embedded`
    : null;
}

function percentOf(base: KnowledgeBase): number {
  const total = base.ingest_stats?.chunks_total ?? 0;
  return total > 0 ? Math.min(100, Math.round(((base.ingest_stats?.chunks_embedded ?? 0) / total) * 100)) : 8;
}

function statusClass(status: KnowledgeBase['status']): string {
  return status === 'complete'
    ? 'text-emerald-600 font-semibold'
    : status === 'error'
    ? 'text-red-600 font-semibold'
    : ACTIVE.includes(status)
    ? 'text-violet-600 font-semibold'
    : 'text-gray-500';
}

export default function KnowledgePage() {
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [sourceType, setSourceType] = useState<'text' | 'repo'>('text');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [embeddingProvider, setEmbeddingProvider] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api<KnowledgeBase[]>('/knowledge').then(setBases),
      api<ApiProvider[]>('/providers').then(setProviders),
    ]).catch((error) => setNotice(error.message));

  useEffect(() => {
    void load();
  }, []);

  // Ingestion runs in a background worker now, so progress only appears on a
  // refetch. Poll while anything is in flight, and stop as soon as nothing is.
  const active = bases.some((base) => ACTIVE.includes(base.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void api<KnowledgeBase[]>('/knowledge')
        .then(setBases)
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const base = await api<KnowledgeBase>('/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          name,
          source_type: sourceType,
          content,
          source_url: url,
          embedding_provider_id: embeddingProvider || null,
        }),
      });
      setName('');
      setContent('');
      setUrl('');
      await load();
      setNotice(`Saved “${base.name}”. Select Ingest to generate its cloud vector index.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save knowledge.');
    } finally {
      setBusy(false);
    }
  }

  async function ingest(base: KnowledgeBase) {
    setBusy(true);
    try {
      await api(`/knowledge/${base.id}/ingest`, {
        method: 'POST',
        body: JSON.stringify({ embedding_provider_id: embeddingProvider || base.embedding_provider_id }),
      });
      await load();
      setNotice(`Queued “${base.name}”. Embedding runs in the background; this list updates as it progresses.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not queue ingestion.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this knowledge base and all its vector chunks?')) return;
    try {
      await api(`/knowledge/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete knowledge.');
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Knowledge base</h1>
        <p className="mt-1 text-sm text-gray-500">
          Store text or public GitHub repositories in your private Supabase vector database.
        </p>
      </div>

      {notice && (
        <p className="rounded-lg border border-violet-100 bg-violet-50 px-4 py-3 text-sm text-violet-900">{notice}</p>
      )}

      <form onSubmit={create} className="grid gap-4 rounded-xl border bg-white p-5 shadow-sm md:grid-cols-2">
        <label className="text-sm font-medium">
          Name
          <input
            required
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Product docs"
          />
        </label>
        <label className="text-sm font-medium">
          Source
          <select
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as 'text' | 'repo')}
          >
            <option value="text">Paste text</option>
            <option value="repo">Public GitHub repository</option>
          </select>
        </label>
        <label className="text-sm font-medium md:col-span-2">
          Embedding provider
          <select
            required
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
            value={embeddingProvider}
            onChange={(e) => setEmbeddingProvider(e.target.value)}
          >
            <option value="">Choose a provider</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} — {provider.embedding_model_name || provider.model_name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs font-normal text-gray-500">
            Use a provider with a 1536-dimension embedding model, for example text-embedding-3-small.
          </span>
        </label>
        {sourceType === 'text' ? (
          <label className="text-sm font-medium md:col-span-2">
            Knowledge text
            <textarea
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={7}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
              placeholder="Paste product docs, notes, or reference material…"
            />
          </label>
        ) : (
          <label className="text-sm font-medium md:col-span-2">
            GitHub repository URL
            <input
              required
              type="url"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
            />
            <span className="mt-1 block text-xs font-normal text-gray-500">
              Public repositories only. OniRoute reads supported source files and limits ingestion to 80 files.
            </span>
          </label>
        )}
        <div className="md:col-span-2 flex justify-end">
          <button
            disabled={busy || !providers.length}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
          >
            Save knowledge source
          </button>
        </div>
      </form>

      <div className="space-y-3">
        {!bases.length ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-gray-500">
            <BookOpen className="mx-auto mb-3 h-7 w-7 text-gray-300" />
            No knowledge sources yet.
          </div>
        ) : (
          bases.map((base) => (
            <div key={base.id} className="flex flex-wrap items-center gap-4 rounded-xl border bg-white p-4">
              <Database className="h-5 w-5 text-violet-600" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">{base.name}</p>
                <p className="text-xs text-gray-500">
                  {base.source_type} · {base.chunk_count} chunks ·{' '}
                  <span className={statusClass(base.status)}>{base.status}</span>
                  {base.error_message ? ` — ${base.error_message}` : ''}
                </p>
                {ACTIVE.includes(base.status) && (
                  <div className="mt-2 space-y-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-violet-100">
                      <div
                        className="h-full rounded-full bg-violet-600 transition-all"
                        style={{ width: `${percentOf(base)}%` }}
                      />
                    </div>
                    <p className="text-xs text-violet-700">
                      {progressOf(base) ??
                        (base.status === 'queued' ? 'Waiting for the ingestion worker…' : 'Reading the source…')}
                    </p>
                  </div>
                )}
                {base.ingest_stats?.truncation_reason && (
                  <p className="mt-1 text-xs text-amber-700">{base.ingest_stats.truncation_reason}</p>
                )}
                {base.ingest_stats?.warnings?.map((warning) => (
                  <p key={warning} className="mt-1 text-xs text-amber-700">
                    {warning}
                  </p>
                ))}
              </div>
              <button
                onClick={() => ingest(base)}
                disabled={busy || ACTIVE.includes(base.status)}
                className="inline-flex items-center gap-1 rounded-lg bg-violet-50 px-3 py-2 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              >
                {ACTIVE.includes(base.status) ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Ingest
              </button>
              <button onClick={() => remove(base.id)} className="rounded p-2 text-red-500 hover:bg-red-50">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
