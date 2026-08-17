import { useEffect, useState, FormEvent } from 'react';
import { Copy, KeyRound, Plus, Server, Layers, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider, GatewayKey, RequestLog } from '../types';

export default function DashboardPage() {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Key creation modal state
  const [showModal, setShowModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [contextOption, setContextOption] = useState<'default' | '200k' | '256k' | '500k' | '1m' | 'custom'>('default');
  const [customTokens, setCustomTokens] = useState('256000');

  const load = () =>
    Promise.all([
      api<ApiProvider[]>('/providers').then(setProviders),
      api<GatewayKey[]>('/gateway-keys').then(setKeys),
      api<{ logs: RequestLog[] }>('/logs?limit=5').then((result) => setLogs(result.logs)),
    ]).catch((error) => setNotice(error.message));

  useEffect(() => {
    void load();
  }, []);

  function formatContextLabel(tokens?: number | null): string {
    if (!tokens) return 'Default (Model Native)';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M Context`;
    return `${Math.round(tokens / 1_000)}K Context`;
  }

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let maxContextTokens: number | null = null;
      if (contextOption === '200k') maxContextTokens = 200_000;
      else if (contextOption === '256k') maxContextTokens = 256_000;
      else if (contextOption === '500k') maxContextTokens = 500_000;
      else if (contextOption === '1m') maxContextTokens = 1_000_000;
      else if (contextOption === 'custom') maxContextTokens = Number(customTokens) || null;

      const result = await api<GatewayKey & { key: string }>('/gateway-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: keyName.trim() || `Key ${keys.length + 1}`,
          max_context_tokens: maxContextTokens,
        }),
      });

      setNewKey(result.key);
      setShowModal(false);
      setKeyName('');
      setContextOption('default');
      await load();
      setNotice(`Gateway key “${result.name}” created with ${formatContextLabel(maxContextTokens)}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create API key.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this gateway key?')) return;
    try {
      await api(`/gateway-keys/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not revoke API key.');
    }
  }

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setNotice('Copied to clipboard.');
  };

  const example = `curl http://localhost:1001/v1/chat/completions \\
  -H "Authorization: Bearer or_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello OniRoute"}]}'`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">OniRoute Control Plane</h1>
        <p className="mt-1 text-sm text-gray-500">Universal, isolated AI gateway keys with per-key context window management.</p>
      </div>

      {notice && <p className="rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-900 border border-violet-200">{notice}</p>}

      {newKey && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <div className="flex items-center gap-2 text-amber-950 font-semibold">
            <ShieldCheck className="h-5 w-5 text-amber-700" />
            <p>Copy your new API key now — it will not be displayed again.</p>
          </div>
          <div className="mt-3 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white p-3 font-mono text-sm border border-amber-200">{newKey}</code>
            <button onClick={() => copy(newKey)} className="rounded-lg bg-amber-900 px-4 text-white hover:bg-amber-950 transition-colors">
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Metrics Row */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <Server className="h-5 w-5 text-violet-600" />
            <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Live</span>
          </div>
          <p className="mt-3 text-2xl font-bold">{providers.filter((provider) => provider.is_active).length}</p>
          <p className="text-sm text-gray-500">Active Upstream Providers</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <KeyRound className="h-5 w-5 text-violet-600" />
            <span className="text-xs font-medium text-gray-400">Total</span>
          </div>
          <p className="mt-3 text-2xl font-bold">{keys.filter((key) => !key.revoked_at).length}</p>
          <p className="text-sm text-gray-500">Isolated Gateway Keys</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <Layers className="h-5 w-5 text-violet-600" />
            <span className="text-xs font-medium text-gray-400">Latest</span>
          </div>
          <p className="mt-3 text-2xl font-bold">{logs[0]?.latency_ms ? `${logs[0].latency_ms}ms` : '—'}</p>
          <p className="text-sm text-gray-500">Routing Latency</p>
        </div>
      </div>

      {/* Gateway Keys Table */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">Gateway API Keys</h2>
            <p className="mt-1 text-sm text-gray-500">Each key can have its own isolated context window budget (200K to 1M+ tokens).</p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" /> Generate New Key
          </button>
        </div>

        <div className="mt-5 divide-y divide-gray-100 border-t border-gray-100">
          {keys
            .filter((key) => !key.revoked_at)
            .map((key) => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-4 py-3.5 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900">{key.name}</span>
                  <code className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 font-mono">{key.key_prefix}</code>
                  {key.max_context_tokens ? (
                    <span className="inline-flex items-center rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700 border border-violet-200/80">
                      {formatContextLabel(key.max_context_tokens)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600 font-normal">
                      Default (Model Native)
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>Created {new Date(key.created_at).toLocaleDateString()}</span>
                  <button
                    onClick={() => revoke(key.id)}
                    className="rounded px-2 py-1 font-medium text-red-600 hover:bg-red-50 hover:text-red-800 transition-colors"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}

          {!keys.filter((key) => !key.revoked_at).length && (
            <p className="py-8 text-center text-sm text-gray-500">No gateway keys yet. Generate a key to connect Cursor, Python, or external apps.</p>
          )}
        </div>
      </section>

      {/* Modal Dialog for Generating Key with Context Setting */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl border border-gray-100 space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Generate Gateway API Key</h3>
                <p className="text-xs text-gray-500 mt-0.5">Configure isolated context limits for this specific key.</p>
              </div>
              <button onClick={() => setShowModal(false)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateKey} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">Key Name</label>
                <input
                  type="text"
                  required
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. Cursor Gemma 4, Production Backend, Teammate Key"
                  className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
                  Context Window Budget (Optional)
                </label>
                <p className="text-xs text-gray-500 mt-0.5 mb-2">
                  Automatically trims long conversations to fit this token ceiling without crashing downstream models. Only applies to this API key.
                </p>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setContextOption('default')}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      contextOption === 'default'
                        ? 'border-violet-600 bg-violet-50 font-semibold text-violet-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="font-medium">Default (Native)</div>
                    <div className="text-[10px] text-gray-400">Uncapped / Model Max</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setContextOption('200k')}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      contextOption === '200k'
                        ? 'border-violet-600 bg-violet-50 font-semibold text-violet-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="font-medium">200K Tokens</div>
                    <div className="text-[10px] text-gray-400">Claude 3.5 / 3.7</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setContextOption('256k')}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      contextOption === '256k'
                        ? 'border-violet-600 bg-violet-50 font-semibold text-violet-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="font-medium">256K Tokens</div>
                    <div className="text-[10px] text-gray-400">Gemma 4 / DeepSeek</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setContextOption('500k')}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      contextOption === '500k'
                        ? 'border-violet-600 bg-violet-50 font-semibold text-violet-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="font-medium">500K Tokens</div>
                    <div className="text-[10px] text-gray-400">Large codebases</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setContextOption('1m')}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      contextOption === '1m'
                        ? 'border-violet-600 bg-violet-50 font-semibold text-violet-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="font-medium">1 Million Tokens</div>
                    <div className="text-[10px] text-gray-400">Gemini 2.0 Flash / Pro</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setContextOption('custom')}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      contextOption === 'custom'
                        ? 'border-violet-600 bg-violet-50 font-semibold text-violet-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="font-medium">Custom Limit</div>
                    <div className="text-[10px] text-gray-400">Specify exact tokens</div>
                  </button>
                </div>

                {contextOption === 'custom' && (
                  <div className="mt-3">
                    <input
                      type="number"
                      min="8000"
                      max="2000000"
                      step="1000"
                      value={customTokens}
                      onChange={(e) => setCustomTokens(e.target.value)}
                      placeholder="e.g. 256000"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-gray-400">Enter context ceiling in tokens (e.g. 256000 for Gemma 4)</p>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 transition-colors disabled:opacity-50"
                >
                  {busy ? 'Generating…' : 'Generate Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Integration Code Snippet */}
      <section className="rounded-xl border border-gray-900 bg-gray-950 p-5 text-gray-100 shadow-sm">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Standard OpenAI Compatible Endpoint</p>
        <pre className="overflow-x-auto text-xs font-mono leading-6 text-violet-300">{example}</pre>
      </section>
    </div>
  );
}
