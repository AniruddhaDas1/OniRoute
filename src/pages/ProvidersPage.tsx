import { FormEvent, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Plus, PlugZap, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider } from '../types';

const input =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500';

const PRESETS = {
  openai: {
    base_url: 'https://api.openai.com/v1',
    endpoint: '/chat/completions',
    model_name: 'gpt-4o-mini',
    embedding_model_name: 'text-embedding-3-small',
  },
  anthropic: {
    base_url: 'https://api.anthropic.com',
    endpoint: '/v1/messages',
    model_name: 'claude-3-5-sonnet-20241022',
    embedding_model_name: '',
  },
  google: {
    base_url: 'https://generativelanguage.googleapis.com',
    endpoint: '/v1beta/models',
    model_name: 'gemini-2.0-flash',
    embedding_model_name: 'text-embedding-004',
  },
  ollama_local: {
    base_url: 'http://127.0.0.1:11434/api',
    endpoint: '/chat',
    model_name: 'llama3.2',
    embedding_model_name: 'nomic-embed-text',
    api_key: 'ollama',
  },
  ollama_cloud: {
    base_url: 'https://ollama.com/api',
    endpoint: '/chat',
    model_name: 'llama3.3',
    embedding_model_name: 'nomic-embed-text',
    api_key: '',
  },
  custom: {
    base_url: 'http://localhost:8000/v1',
    endpoint: '/chat/completions',
    model_name: 'custom-model',
    embedding_model_name: '',
  },
};

const emptyForm = {
  name: '',
  provider_type: 'openai' as ApiProvider['provider_type'],
  base_url: 'https://api.openai.com/v1',
  endpoint: '/chat/completions',
  model_name: 'gpt-4o-mini',
  embedding_model_name: 'text-embedding-3-small',
  api_key: '',
};

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    api<ApiProvider[]>('/providers')
      .then(setProviders)
      .catch((error) => setNotice(error.message));

  useEffect(() => {
    void load();
  }, []);

  function applyPreset(type: 'openai' | 'anthropic' | 'google' | 'ollama_local' | 'ollama_cloud' | 'custom') {
    const preset = PRESETS[type];
    const providerType = type.startsWith('ollama') ? 'ollama' : (type as ApiProvider['provider_type']);
    setForm((prev) => ({
      ...prev,
      provider_type: providerType,
      base_url: preset.base_url,
      endpoint: preset.endpoint,
      model_name: preset.model_name,
      embedding_model_name: preset.embedding_model_name,
      api_key: 'api_key' in preset && preset.api_key ? preset.api_key : prev.api_key,
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api('/providers', { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyForm);
      setOpen(false);
      await load();
      setNotice('Provider saved. Its API key is stored server-side in Supabase Vault / Encrypted Storage.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save provider.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this provider and its secret?')) return;
    try {
      await api(`/providers/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove provider.');
    }
  }

  async function test(id: string) {
    setBusy(true);
    try {
      const result = await api<{ success: boolean; latency_ms: number; error?: string }>(`/test-provider/${id}`, {
        method: 'POST',
      });
      setNotice(
        result.success
          ? `Connection succeeded in ${result.latency_ms}ms.`
          : `Connection failed: ${result.error}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Connection test failed.');
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const swap = index + direction;
    if (swap < 0 || swap >= providers.length) return;
    const next = [...providers];
    [next[index], next[swap]] = [next[swap], next[index]];
    setProviders(next);
    try {
      await api('/providers/reorder', {
        method: 'PUT',
        body: JSON.stringify({ provider_ids: next.map((provider) => provider.id) }),
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reorder providers.');
      load();
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI providers</h1>
          <p className="mt-1 text-sm text-gray-500">
            Connect OpenAI, Anthropic, Gemini, Ollama (Local/Cloud), and Custom LLMs.
          </p>
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add provider
        </button>
      </div>

      {notice && (
        <p className="rounded-lg border border-violet-100 bg-violet-50 px-4 py-3 text-sm text-violet-900">{notice}</p>
      )}

      {open && (
        <form onSubmit={submit} className="grid gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-2">
          <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
            <h2 className="text-base font-semibold text-gray-900">New provider</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-gray-400 font-medium mr-1">Quick Presets:</span>
              <button
                type="button"
                onClick={() => applyPreset('openai')}
                className="rounded bg-gray-100 px-2 py-1 font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700"
              >
                OpenAI
              </button>
              <button
                type="button"
                onClick={() => applyPreset('anthropic')}
                className="rounded bg-gray-100 px-2 py-1 font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700"
              >
                Anthropic
              </button>
              <button
                type="button"
                onClick={() => applyPreset('google')}
                className="rounded bg-gray-100 px-2 py-1 font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700"
              >
                Gemini
              </button>
              <button
                type="button"
                onClick={() => applyPreset('ollama_local')}
                className="rounded bg-amber-50 px-2 py-1 font-medium text-amber-800 border border-amber-200 hover:bg-amber-100"
              >
                Ollama Local (11434)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('ollama_cloud')}
                className="rounded bg-blue-50 px-2 py-1 font-medium text-blue-800 border border-blue-200 hover:bg-blue-100"
              >
                Ollama Cloud / Remote
              </button>
            </div>
          </div>

          <label className="text-sm font-medium">
            Display name
            <input
              required
              className={input}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Ollama Local Llama 3.2"
            />
          </label>
          <label className="text-sm font-medium">
            Provider format
            <select
              className={input}
              value={form.provider_type}
              onChange={(e) => {
                const val = e.target.value as ApiProvider['provider_type'];
                setForm({ ...form, provider_type: val });
              }}
            >
              <option value="openai">OpenAI compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
              <option value="ollama">Ollama (Local / Cloud)</option>
              <option value="custom">Custom OpenAI compatible</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Base URL
            <input
              required
              type="text"
              className={input}
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="http://127.0.0.1:11434/v1"
            />
          </label>
          <label className="text-sm font-medium">
            Chat endpoint
            <input
              required
              className={input}
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder="/chat/completions"
            />
          </label>
          <label className="text-sm font-medium">
            Chat model
            <input
              required
              className={input}
              value={form.model_name}
              onChange={(e) => setForm({ ...form, model_name: e.target.value })}
              placeholder="llama3.2 or deepseek-r1"
            />
          </label>
          <label className="text-sm font-medium">
            Embedding model <span className="font-normal text-gray-400">(for vector RAG)</span>
            <input
              className={input}
              value={form.embedding_model_name}
              onChange={(e) => setForm({ ...form, embedding_model_name: e.target.value })}
              placeholder="nomic-embed-text or text-embedding-3-small"
            />
          </label>
          <label className="md:col-span-2 text-sm font-medium">
            API key <span className="font-normal text-gray-400">(use "ollama" or dummy key for local Ollama)</span>
            <input
              required
              type="password"
              autoComplete="new-password"
              className={input}
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="ollama or your-cloud-api-key"
            />
          </label>
          <div className="md:col-span-2 flex justify-end gap-3">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-4 py-2 text-sm hover:bg-gray-100">
              Cancel
            </button>
            <button
              disabled={busy}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-gray-800"
            >
              {busy ? 'Saving…' : 'Save provider'}
            </button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {!providers.length ? (
          <div className="p-12 text-center">
            <PlugZap className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-3 font-medium">No providers yet</p>
            <p className="mt-1 text-sm text-gray-500">Add a provider to begin routing requests.</p>
          </div>
        ) : (
          providers.map((provider, index) => (
            <div
              key={provider.id}
              className="flex flex-wrap items-center gap-4 border-b border-gray-100 p-4 last:border-0"
            >
              <span className="w-6 text-center text-sm font-semibold text-gray-400">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">
                  {provider.name}{' '}
                  {!provider.is_active && <span className="ml-2 text-xs font-normal text-red-600">disabled</span>}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {provider.provider_type} · {provider.model_name} · {provider.base_url}
                  {provider.endpoint}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  aria-label="Move up"
                  onClick={() => move(index, -1)}
                  className="rounded p-2 hover:bg-gray-100 text-gray-500"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  aria-label="Move down"
                  onClick={() => move(index, 1)}
                  className="rounded p-2 hover:bg-gray-100 text-gray-500"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  onClick={() => test(provider.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50"
                >
                  <CheckCircle2 className="h-4 w-4" /> Test
                </button>
                <button
                  aria-label="Delete"
                  onClick={() => remove(provider.id)}
                  className="rounded p-2 text-red-500 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
