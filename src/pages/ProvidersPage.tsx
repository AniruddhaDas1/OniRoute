import { FormEvent, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  PlugZap,
  Trash2,
  X,
  RefreshCw,
  Pencil,
  Info,
  Eye,
  EyeOff,
  Layers,
  Shuffle,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider, ProviderGroup } from '../types';

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

const emptyGroupForm = {
  name: '',
  description: '',
  routing_mode: 'priority' as 'priority' | 'random',
  provider_ids: [] as string[],
};

interface ProviderTestState {
  status: 'idle' | 'testing' | 'connected' | 'failed';
  latency_ms?: number;
  error?: string;
}

export default function ProvidersPage() {
  const [activeTab, setActiveTab] = useState<'providers' | 'groups'>('providers');
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState(false);

  // Group modal state
  const [groupOpen, setGroupOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState(emptyGroupForm);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, ProviderTestState>>({});
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const load = () =>
    Promise.all([
      api<ApiProvider[]>('/providers').then((data) => setProviders(data || [])),
      api<ProviderGroup[]>('/provider-groups').then((data) => setGroups(data || [])),
    ]).catch((error) => setNotice({ type: 'error', message: error.message }));

  useEffect(() => {
    void load();
  }, []);

  function handleOpenAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function handleEdit(provider: ApiProvider) {
    setEditingId(provider.id);
    setForm({
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url,
      endpoint: provider.endpoint,
      model_name: provider.model_name,
      embedding_model_name: provider.embedding_model_name || '',
      api_key: '',
    });
    setOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleOpenCreateGroup() {
    setEditingGroupId(null);
    setGroupForm({
      name: '',
      description: '',
      routing_mode: 'priority',
      provider_ids: providers.map((p) => p.id),
    });
    setGroupOpen(true);
  }

  function handleEditGroup(grp: ProviderGroup) {
    setEditingGroupId(grp.id);
    setGroupForm({
      name: grp.name,
      description: grp.description || '',
      routing_mode: grp.routing_mode || 'priority',
      provider_ids: Array.isArray(grp.provider_ids) ? [...grp.provider_ids] : [],
    });
    setGroupOpen(true);
  }

  async function handleDeleteGroup(id: string) {
    if (!confirm('Are you sure you want to delete this provider group?')) return;
    try {
      await api(`/provider-groups/${id}`, { method: 'DELETE' });
      setNotice({ type: 'success', message: 'Provider group deleted.' });
      await load();
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message || 'Could not delete provider group.' });
    }
  }

  async function submitGroup(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (editingGroupId) {
        await api(`/provider-groups/${editingGroupId}`, {
          method: 'PUT',
          body: JSON.stringify(groupForm),
        });
        setNotice({ type: 'success', message: `Group "${groupForm.name}" updated successfully.` });
      } else {
        await api<ProviderGroup>('/provider-groups', {
          method: 'POST',
          body: JSON.stringify(groupForm),
        });
        setNotice({ type: 'success', message: `Group "${groupForm.name}" created successfully.` });
      }
      setGroupOpen(false);
      await load();
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message || 'Could not save group.' });
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(type: keyof typeof PRESETS) {
    const preset = PRESETS[type];
    setForm((prev) => ({
      ...prev,
      name: prev.name || preset.name,
      provider_type: preset.provider_type,
      base_url: preset.base_url,
      endpoint: preset.endpoint,
      model_name: preset.model_name,
      embedding_model_name: preset.embedding_model_name,
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const payload: Record<string, any> = {
        name: form.name.trim(),
        provider_type: form.provider_type,
        base_url: form.base_url.trim(),
        endpoint: form.endpoint.trim(),
        model_name: form.model_name.trim(),
        embedding_model_name: form.embedding_model_name.trim() || null,
      };

      if (form.api_key.trim()) {
        payload.api_key = form.api_key.trim();
      }

      if (editingId) {
        await api(`/providers/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setNotice({
          type: 'success',
          message: `Updated provider “${form.name}” successfully.`,
        });
      } else {
        const saved = await api<ApiProvider>('/providers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setNotice({
          type: 'success',
          message: `Saved provider “${saved?.name || form.name}”. Key is securely stored in encrypted vault.`,
        });
      }

      setForm(emptyForm);
      setEditingId(null);
      setOpen(false);
      await load();
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not save provider.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(id: string) {
    setTestingId(id);
    setTestStates((prev) => ({ ...prev, [id]: { status: 'testing' } }));
    try {
      const result = await api<{ success: boolean; latency_ms?: number; error?: string }>(
        `/test-provider/${id}`,
        { method: 'POST' }
      );
      if (result.success) {
        setTestStates((prev) => ({
          ...prev,
          [id]: { status: 'connected', latency_ms: result.latency_ms },
        }));
      } else {
        setTestStates((prev) => ({
          ...prev,
          [id]: { status: 'failed', error: result.error || 'Connection failed' },
        }));
      }
    } catch (error: any) {
      setTestStates((prev) => ({
        ...prev,
        [id]: { status: 'failed', error: error?.message || 'Connection failed' },
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function reorder(index: number, direction: 'up' | 'down') {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= providers.length) return;
    const next = [...providers];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setProviders(next);
    try {
      await api('/providers/reorder', {
        method: 'POST',
        body: JSON.stringify({ provider_ids: next.map((p) => p.id) }),
      });
    } catch (error) {
      await load();
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not reorder providers.',
      });
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this provider? Associated keys and failover rules will be deleted.')) return;
    try {
      await api(`/providers/${id}`, { method: 'DELETE' });
      await load();
      setNotice({ type: 'info', message: 'Provider removed.' });
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not remove provider.',
      });
    }
  }

  const provMap = new Map(providers.map((p) => [p.id, p]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Providers &amp; Groups</h1>
          <p className="mt-1 text-sm text-gray-500">
            Connect AI models, create specialized model groups (e.g. Coding, Reasoning), and set failover priorities.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenCreateGroup}
            className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-3.5 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-100 transition-colors shadow-sm"
          >
            <Layers className="h-4 w-4" /> + New Group
          </button>
          <button
            onClick={handleOpenAdd}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add Provider
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 text-sm font-medium text-gray-500">
        <button
          onClick={() => setActiveTab('providers')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 transition-colors ${
            activeTab === 'providers'
              ? 'border-violet-600 font-semibold text-violet-600'
              : 'border-transparent hover:text-gray-700'
          }`}
        >
          <PlugZap className="h-4 w-4" /> All Providers ({providers.length})
        </button>
        <button
          onClick={() => setActiveTab('groups')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 transition-colors ${
            activeTab === 'groups'
              ? 'border-violet-600 font-semibold text-violet-600'
              : 'border-transparent hover:text-gray-700'
          }`}
        >
          <Layers className="h-4 w-4" /> Provider Groups ({groups.length})
        </button>
      </div>

      {notice && (
        <div
          className={`flex items-center justify-between rounded-lg px-4 py-3 text-sm border ${
            notice.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : notice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-blue-200 bg-blue-50 text-blue-800'
          }`}
        >
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)} className="text-current opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Provider Form Modal / Card */}
      {open && (
        <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-6 shadow-sm">
          <div className="flex items-center justify-between border-b border-violet-100 pb-3">
            <h2 className="font-semibold text-gray-900">
              {editingId ? `Edit Provider: ${form.name}` : 'Connect Upstream AI Provider'}
            </h2>
            <button
              onClick={() => {
                setOpen(false);
                setEditingId(null);
              }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {!editingId && (
            <div className="mt-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Quick Presets (Click to autofill)
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => applyPreset(key as keyof typeof PRESETS)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:border-violet-400 hover:bg-violet-50 transition-colors"
                  >
                    + {preset.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700">Display Name</label>
              <input
                className={input}
                required
                placeholder="e.g. OpenAI GPT-4o Mini"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700">Provider Type</label>
              <select
                className={input}
                value={form.provider_type}
                onChange={(e) =>
                  setForm({ ...form, provider_type: e.target.value as ApiProvider['provider_type'] })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google Gemini</option>
                <option value="ollama">Ollama (Cloud / Local)</option>
                <option value="custom">Custom (OpenAI-compatible)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700">Base URL</label>
              <input
                className={input}
                required
                placeholder="https://api.openai.com/v1"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700">Chat Endpoint</label>
              <input
                className={input}
                required
                placeholder="/chat/completions"
                value={form.endpoint}
                onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700">Chat Model Name</label>
              <input
                className={input}
                required
                placeholder="e.g. gpt-4o-mini, claude-3-5-sonnet, llama3.2"
                value={form.model_name}
                onChange={(e) => setForm({ ...form, model_name: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700">
                Embedding Model Name <span className="text-gray-400 font-normal">(Optional, for Vector RAG)</span>
              </label>
              <input
                className={input}
                placeholder="e.g. text-embedding-3-small, nomic-embed-text"
                value={form.embedding_model_name}
                onChange={(e) => setForm({ ...form, embedding_model_name: e.target.value })}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-700">
                API Key / Auth Token
                {editingId && (
                  <span className="ml-2 text-xs text-amber-700 font-normal">
                    (Leave blank to keep existing encrypted secret)
                  </span>
                )}
              </label>
              <div className="relative mt-1">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  className={`${input} pr-10`}
                  placeholder={editingId ? '••••••••••••••••••••••••' : 'sk-... or your auth token'}
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-3 sm:col-span-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setEditingId(null);
                }}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingId ? 'Update Provider' : 'Save & Secure in Vault'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Provider Group Create / Edit Modal */}
      {groupOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl border border-gray-100 space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  {editingGroupId ? 'Edit Provider Group' : 'Create AI Provider Group'}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Group specific models together and set an isolated routing strategy.
                </p>
              </div>
              <button onClick={() => setGroupOpen(false)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={submitGroup} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">Group Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Coding LLMs, Reasoning Cluster, Ollama Fast"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
                  Description <span className="font-normal text-gray-400">(Optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Primary fallback chain for Cursor and code completions"
                  value={groupForm.description}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-2">
                  Routing Strategy For This Group
                </label>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => setGroupForm({ ...groupForm, routing_mode: 'priority' })}
                    className={`rounded-xl border p-3 text-left transition-all ${
                      groupForm.routing_mode === 'priority'
                        ? 'border-violet-600 bg-violet-50 text-violet-950 font-semibold ring-2 ring-violet-500/20'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-bold">
                      <Zap className="h-4 w-4 text-violet-600" /> Priority Failover
                    </div>
                    <p className="mt-1 text-[11px] text-gray-500 font-normal">
                      Tries Model 1 first. Automatically fails over to Model 2 if unreachable.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setGroupForm({ ...groupForm, routing_mode: 'random' })}
                    className={`rounded-xl border p-3 text-left transition-all ${
                      groupForm.routing_mode === 'random'
                        ? 'border-violet-600 bg-violet-50 text-violet-950 font-semibold ring-2 ring-violet-500/20'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-bold">
                      <Shuffle className="h-4 w-4 text-violet-600" /> Random Balance
                    </div>
                    <p className="mt-1 text-[11px] text-gray-500 font-normal">
                      Distributes requests randomly across all models in this group.
                    </p>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-2">
                  Assign Providers to Group
                </label>
                {providers.length === 0 ? (
                  <p className="text-xs text-amber-700 bg-amber-50 p-3 rounded-lg border border-amber-200">
                    No providers configured yet. Add providers first.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-200 bg-gray-50/50 p-2 space-y-1">
                    {providers.map((p) => {
                      const isChecked = groupForm.provider_ids.includes(p.id);
                      return (
                        <label
                          key={p.id}
                          className="flex items-center justify-between p-2 rounded hover:bg-white cursor-pointer transition-colors"
                        >
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setGroupForm({
                                    ...groupForm,
                                    provider_ids: [...groupForm.provider_ids, p.id],
                                  });
                                } else {
                                  setGroupForm({
                                    ...groupForm,
                                    provider_ids: groupForm.provider_ids.filter((id) => id !== p.id),
                                  });
                                }
                              }}
                              className="rounded text-violet-600 focus:ring-violet-500 h-4 w-4"
                            />
                            <div>
                              <p className="text-xs font-semibold text-gray-900">{p.name}</p>
                              <p className="text-[10px] text-gray-500 font-mono">{p.model_name}</p>
                            </div>
                          </div>
                          <span className="text-[10px] font-medium bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full uppercase">
                            {p.provider_type}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setGroupOpen(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !groupForm.name.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50 shadow-sm"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {editingGroupId ? 'Update Group' : 'Create Group'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 1: ALL PROVIDERS */}
      {activeTab === 'providers' && (
        <section className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 border-b border-gray-100">
              <div>
                <h2 className="font-semibold text-gray-900">Configured AI Providers</h2>
                <p className="text-xs text-gray-500">Order from top to bottom sets default failover priority.</p>
              </div>
              <span className="text-xs font-medium text-gray-400">{providers.length} configured</span>
            </div>

            <div className="mt-4 divide-y divide-gray-100">
              {providers.map((provider, index) => {
                const testState = testStates[provider.id];
                const isTesting = testingId === provider.id;

                return (
                  <div key={provider.id} className="py-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700">
                          {index + 1}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-gray-900">{provider.name}</span>
                            <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700 uppercase tracking-wide">
                              {provider.provider_type}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                            <span>
                              Model: <code className="font-mono text-gray-700 font-medium">{provider.model_name}</code>
                            </span>
                            {provider.embedding_model_name && (
                              <span className="border-l border-gray-200 pl-2">
                                Vector Embed: <code className="font-mono text-violet-600">{provider.embedding_model_name}</code>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Live Connection Status Badge */}
                        {testState?.status === 'connected' && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            Connected {testState.latency_ms ? `(${testState.latency_ms}ms)` : ''}
                          </span>
                        )}
                        {testState?.status === 'failed' && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 border border-rose-200">
                            <AlertCircle className="h-3.5 w-3.5 text-rose-600" />
                            Failed
                          </span>
                        )}

                        <button
                          onClick={() => testConnection(provider.id)}
                          disabled={isTesting}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${isTesting ? 'animate-spin text-violet-600' : ''}`} />
                          {isTesting ? 'Testing...' : 'Test'}
                        </button>

                        <button
                          onClick={() => handleEdit(provider)}
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5 text-gray-500" />
                          Edit
                        </button>

                        <button
                          disabled={index === 0}
                          onClick={() => reorder(index, 'up')}
                          className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          disabled={index === providers.length - 1}
                          onClick={() => reorder(index, 'down')}
                          className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => remove(provider.id)}
                          className="rounded p-1.5 text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* Error diagnostic explanation if test failed */}
                    {testState?.status === 'failed' && testState.error && (
                      <div className="mt-2 text-xs text-rose-700 bg-rose-50/80 p-2.5 rounded-lg border border-rose-100">
                        <strong>Diagnostics:</strong> {testState.error}
                      </div>
                    )}
                  </div>
                );
              })}

              {!providers.length && (
                <div className="py-12 text-center text-gray-500 space-y-3">
                  <PlugZap className="h-8 w-8 mx-auto text-gray-300" />
                  <p className="text-sm font-medium">No Providers Configured Yet</p>
                  <p className="text-xs text-gray-400">
                    Add your first provider to begin routing requests with automatic failover.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Embedding Model Guidance Panel */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5 text-sm text-blue-950 shadow-sm space-y-3">
            <div className="flex items-center gap-2 font-semibold text-blue-900">
              <Info className="h-5 w-5 text-blue-600 flex-shrink-0" />
              <span>When is an Embedding Model Required vs Optional?</span>
            </div>
            <p className="text-xs text-blue-900/80 leading-relaxed">
              <strong>Direct Routing Mode (Default):</strong> Pure API calls and code completions (e.g. Cursor, Continue, ChatGPT API) only require the <strong>Chat Model Name</strong>.
              <br />
              <strong>Refined RAG Mode:</strong> If you plan to index documentation or repositories in the <strong>Knowledge Base</strong>, configure an <strong>Embedding Model Name</strong>.
            </p>
          </div>
        </section>
      )}

      {/* TAB 2: PROVIDER GROUPS */}
      {activeTab === 'groups' && (
        <section className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between pb-4 border-b border-gray-100">
              <div>
                <h2 className="font-semibold text-gray-900">AI Provider Groups (Routing Profiles)</h2>
                <p className="text-xs text-gray-500">
                  Combine models into named clusters (e.g. Coding, Reasoning, Fast Fallback) and link them to API keys.
                </p>
              </div>
              <button
                onClick={handleOpenCreateGroup}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 shadow-sm"
              >
                <Plus className="h-3.5 w-3.5" /> New Group
              </button>
            </div>

            <div className="mt-5 space-y-4">
              {groups.map((group) => {
                const assigned = (group.provider_ids || [])
                  .map((id) => provMap.get(id))
                  .filter((p): p is ApiProvider => Boolean(p));

                return (
                  <div
                    key={group.id}
                    className="rounded-xl border border-gray-200 bg-gray-50/40 p-5 transition-all hover:border-violet-300"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2.5">
                          <span className="font-bold text-gray-900 text-base">{group.name}</span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                              group.routing_mode === 'random'
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-violet-50 text-violet-700 border-violet-200'
                            }`}
                          >
                            {group.routing_mode === 'random' ? (
                              <>
                                <Shuffle className="h-3 w-3" /> Random Load Balancing
                              </>
                            ) : (
                              <>
                                <Zap className="h-3 w-3" /> Priority Failover
                              </>
                            )}
                          </span>
                        </div>
                        {group.description && (
                          <p className="text-xs text-gray-500">{group.description}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleEditGroup(group)}
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-sm"
                        >
                          <Pencil className="h-3.5 w-3.5 text-gray-500" /> Edit
                        </button>
                        <button
                          onClick={() => handleDeleteGroup(group.id)}
                          className="rounded-lg p-1.5 text-red-500 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* Assigned Model Chips */}
                    <div className="mt-4 pt-3 border-t border-gray-200/60">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Assigned Upstream Models ({assigned.length}):
                      </span>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {assigned.map((p, idx) => (
                          <span
                            key={p.id}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-800 shadow-sm"
                          >
                            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-100 text-[10px] font-bold text-violet-700">
                              {idx + 1}
                            </span>
                            {p.name}
                            <code className="text-[10px] text-gray-400 font-mono">({p.model_name})</code>
                          </span>
                        ))}
                        {assigned.length === 0 && (
                          <span className="text-xs text-gray-400 italic">
                            No models assigned yet. Edit this group to add models.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {!groups.length && (
                <div className="py-12 text-center text-gray-500 space-y-3">
                  <Layers className="h-8 w-8 mx-auto text-gray-300" />
                  <p className="text-sm font-medium">No Provider Groups Created Yet</p>
                  <p className="text-xs text-gray-400">
                    Create your first group to bundle models together for dedicated API keys!
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
