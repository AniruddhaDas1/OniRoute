import { FormEvent, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Plus, PlugZap, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider } from '../types';

const input =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500';

const PRESETS = {
  openai: {
    name: 'OpenAI',
    provider_type: 'openai' as const,
    base_url: 'https://api.openai.com/v1',
    endpoint: '/chat/completions',
    model_name: 'gpt-4o-mini',
    embedding_model_name: 'text-embedding-3-small',
    api_key: '',
  },
  anthropic: {
    name: 'Anthropic Claude',
    provider_type: 'anthropic' as const,
    base_url: 'https://api.anthropic.com',
    endpoint: '/v1/messages',
    model_name: 'claude-3-5-sonnet-20241022',
    embedding_model_name: '',
    api_key: '',
  },
  google: {
    name: 'Google Gemini',
    provider_type: 'google' as const,
    base_url: 'https://generativelanguage.googleapis.com',
    endpoint: '/v1beta/models',
    model_name: 'gemini-2.0-flash',
    embedding_model_name: 'text-embedding-004',
    api_key: '',
  },
  ollama_local: {
    name: 'Ollama Local (11434)',
    provider_type: 'ollama' as const,
    base_url: 'http://127.0.0.1:11434/api',
    endpoint: '/chat',
    model_name: 'llama3.2',
    embedding_model_name: 'nomic-embed-text',
    api_key: '',
  },
  ollama_cloud: {
    name: 'Ollama Cloud',
    provider_type: 'ollama' as const,
    base_url: 'https://ollama.com/api',
    endpoint: '/chat',
    model_name: 'llama3.3',
    embedding_model_name: 'nomic-embed-text',
    api_key: '',
  },
  custom: {
    name: 'Custom LLM Server',
    provider_type: 'custom' as const,
    base_url: 'http://localhost:8000/v1',
    endpoint: '/chat/completions',
    model_name: 'custom-model',
    embedding_model_name: '',
    api_key: '',
  },
};

const emptyForm = {
  name: '',
  provider_type: 'openai' as ApiProvider['provider_type'],
  base_url: '',
  endpoint: '',
  model_name: '',
  embedding_model_name: '',
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
      .then((data) => {
        setProviders(data || []);
      })
      .catch((error) => setNotice(error.message));

  useEffect(() => {
    void load();
  }, []);

  function handleOpenAdd() {
    setForm(emptyForm);
    setOpen(true);
  }

  function applyPreset(type: keyof typeof PRESETS) {
    const preset = PRESETS[type];
    setForm({
      name: preset.name,
      provider_type: preset.provider_type,
      base_url: preset.base_url,
      endpoint: preset.endpoint,
      model_name: preset.model_name,
      embedding_model_name: preset.embedding_model_name,
      api_key: '',
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<ApiProvider>('/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          provider_type: form.provider_type,
          base_url: form.base_url.trim(),
          endpoint: form.endpoint.trim(),
          model_name: form.model_name.trim(),
          embedding_model_name: form.embedding_model_name.trim() || null,
          api_key: form.api_key.trim(),
        }),
      });
      setForm(emptyForm);
      setOpen(false);
      await load();
      setNotice(`Saved provider “${saved?.name || form.name}”. Key is securely stored in encrypted vault.`);
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
          <h1 className="text-2xl font-bold text-gray-900">AI Providers</h1>
          <p className="mt-1 text-sm text-gray-500">
            Connect and prioritize OpenAI, Anthropic, Gemini, Ollama (Cloud / Local), and Custom LLMs.
          </p>
        </div>
        <button
          onClick={handleOpenAdd}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700 transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" /> Add Provider
        </button>
      </div>

      {notice && (
        <p className="rounded-lg border border-violet-100 bg-violet-50 px-4 py-3 text-sm text-violet-900">{notice}</p>
      )}

      {open && (
        <form onSubmit={submit} className="grid gap-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm md:grid-cols-2 animate-in fade-in zoom-in-95 duration-150">
          <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Add New AI Provider</h2>
              <p className="text-xs text-gray-500 mt-0.5">Click a quick preset or fill in your provider details manually.</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-gray-400 font-medium mr-1">Quick Presets:</span>
              <button
                type="button"
                onClick={() => applyPreset('openai')}
                className="rounded-md bg-gray-100 px-2.5 py-1 font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700 transition-colors"
              >
                OpenAI
              </button>
              <button
                type="button"
                onClick={() => applyPreset('anthropic')}
                className="rounded-md bg-gray-100 px-2.5 py-1 font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700 transition-colors"
              >
                Anthropic
              </button>
              <button
                type="button"
                onClick={() => applyPreset('google')}
                className="rounded-md bg-gray-100 px-2.5 py-1 font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700 transition-colors"
              >
                Gemini
              </button>
              <button
                type="button"
                onClick={() => applyPreset('ollama_local')}
                className="rounded-md bg-amber-50 px-2.5 py-1 font-medium text-amber-800 border border-amber-200 hover:bg-amber-100 transition-colors"
              >
                Ollama Local (11434)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('ollama_cloud')}
                className="rounded-md bg-blue-50 px-2.5 py-1 font-medium text-blue-800 border border-blue-200 hover:bg-blue-100 transition-colors"
              >
                Ollama Cloud
              </button>
              <button
                type="button"
                onClick={() => applyPreset('custom')}
                className="rounded-md bg-purple-50 px-2.5 py-1 font-medium text-purple-800 border border-purple-200 hover:bg-purple-100 transition-colors"
              >
                Custom
              </button>
            </div>
          </div>

          <label className="text-sm font-medium">
            Display Name
            <input
              required
              className={input}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. OpenAI GPT-4o, Ollama Gemma 4, Local Llama"
            />
          </label>

          <label className="text-sm font-medium">
            Provider Format
            <select
              className={input}
              value={form.provider_type}
              onChange={(e) => {
                const val = e.target.value as ApiProvider['provider_type'];
                setForm({ ...form, provider_type: val });
              }}
            >
              <option value="openai">OpenAI Compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
              <option value="ollama">Ollama (Cloud / Local)</option>
              <option value="custom">Custom OpenAI Compatible</option>
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
              placeholder="e.g. https://api.openai.com/v1 or https://ollama.com/api"
            />
          </label>

          <label className="text-sm font-medium">
            Chat Endpoint
            <input
              required
              className={input}
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder="e.g. /chat/completions or /chat"
            />
          </label>

          <label className="text-sm font-medium">
            Chat Model
            <input
              required
              className={input}
              value={form.model_name}
              onChange={(e) => setForm({ ...form, model_name: e.target.value })}
              placeholder="e.g. gpt-4o, claude-3-5-sonnet, llama3.3"
            />
          </label>

          <label className="text-sm font-medium">
            Embedding Model <span className="font-normal text-gray-400">(for Vector RAG)</span>
            <input
              className={input}
              value={form.embedding_model_name}
              onChange={(e) => setForm({ ...form, embedding_model_name: e.target.value })}
              placeholder="e.g. text-embedding-3-small or nomic-embed-text"
            />
          </label>

          <label className="md:col-span-2 text-sm font-medium">
            API Key
            <input
              required
              type="password"
              autoComplete="new-password"
              className={input}
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="Enter provider API key (or 'ollama' for offline local instance)"
            />
          </label>

          <div className="md:col-span-2 flex justify-end gap-3 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {busy ? 'Saving…' : 'Save Provider'}
            </button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {!providers.length ? (
          <div className="p-12 text-center">
            <PlugZap className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-3 font-medium text-gray-900">No Providers Configured Yet</p>
            <p className="mt-1 text-sm text-gray-500">Add your first provider to begin routing requests with automatic failover.</p>
          </div>
        ) : (
          providers.map((provider, index) => (
            <div
              key={provider.id}
              className="flex flex-wrap items-center gap-4 border-b border-gray-100 p-4 last:border-0 hover:bg-gray-50/50 transition-colors"
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
                  className="rounded p-2 hover:bg-gray-100 text-gray-500 transition-colors"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  aria-label="Move down"
                  onClick={() => move(index, 1)}
                  className="rounded p-2 hover:bg-gray-100 text-gray-500 transition-colors"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  onClick={() => test(provider.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 transition-colors"
                >
                  <CheckCircle2 className="h-4 w-4" /> Test
                </button>
                <button
                  aria-label="Delete"
                  onClick={() => remove(provider.id)}
                  className="rounded p-2 text-red-500 hover:bg-red-50 transition-colors"
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
