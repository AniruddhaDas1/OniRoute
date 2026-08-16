import { FormEvent, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider, KnowledgeBase } from '../types';

export default function PlaygroundPage() {
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'direct' | 'refined'>('direct');
  const [refinePrompt, setRefinePrompt] = useState('');
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [baseId, setBaseId] = useState('');
  const [embeddingProviderId, setEmbeddingProviderId] = useState('');
  const [response, setResponse] = useState<{ response: string; provider_used: string; latency_ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<KnowledgeBase[]>('/knowledge').then(setBases),
      api<ApiProvider[]>('/providers').then(setProviders),
    ]).catch((reason) => setError(reason.message));
  }, []);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResponse(null);
    try {
      setResponse(await api('/chat', {
        method: 'POST',
        body: JSON.stringify({
          message,
          mode,
          refine_prompt: refinePrompt || undefined,
          knowledge_base_id: baseId || undefined,
          embedding_provider_id: embeddingProviderId || undefined,
        }),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Playground</h1>
        <p className="mt-1 text-sm text-gray-500">Send a request through the same cloud router used by your OniRoute API.</p>
      </div>

      <form onSubmit={send} className="space-y-4 rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('direct')}
            className={`rounded-lg px-3 py-2 text-sm ${mode === 'direct' ? 'bg-violet-600 text-white' : 'bg-gray-100'}`}
          >
            Direct AI response
          </button>
          <button
            type="button"
            onClick={() => setMode('refined')}
            className={`rounded-lg px-3 py-2 text-sm ${mode === 'refined' ? 'bg-violet-600 text-white' : 'bg-gray-100'}`}
          >
            Refined AI response
          </button>
        </div>

        {mode === 'refined' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <select
              required
              className="rounded-lg border px-3 py-2 text-sm"
              value={baseId}
              onChange={(e) => setBaseId(e.target.value)}
            >
              <option value="">Knowledge base</option>
              {bases.filter((base) => base.status === 'complete').map((base) => (
                <option value={base.id} key={base.id}>{base.name}</option>
              ))}
            </select>
            <select
              required
              className="rounded-lg border px-3 py-2 text-sm"
              value={embeddingProviderId}
              onChange={(e) => setEmbeddingProviderId(e.target.value)}
            >
              <option value="">Embedding provider</option>
              {providers.map((provider) => (
                <option value={provider.id} key={provider.id}>{provider.name}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium">Refine prompt</label>
          <input
            type="text"
            value={refinePrompt}
            onChange={(e) => setRefinePrompt(e.target.value)}
            placeholder="e.g. Rewrite this as a precise technical query"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-400">
            Transform the user message before it reaches the AI provider. Leave empty to send as-is.
          </p>
        </div>

        <textarea
          required
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-lg border px-3 py-3 text-sm"
          placeholder="Ask anything…"
        />

        <div className="flex justify-end">
          <button
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {busy ? 'Routing…' : 'Send request'}
          </button>
        </div>
      </form>

      {error && <p className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}

      {response && (
        <article className="rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold">Response</h2>
          <p className="mt-2 text-sm whitespace-pre-wrap">{response.response}</p>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
            <span>Provider: {response.provider_used}</span>
            <span>Latency: {response.latency_ms}ms</span>
          </div>
        </article>
      )}
    </div>
  );
}
