import { useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, Server } from 'lucide-react';
import { api } from '../lib/api';
import type { ApiProvider, GatewayKey, RequestLog } from '../types';

export default function DashboardPage() {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api<ApiProvider[]>('/providers').then(setProviders),
      api<GatewayKey[]>('/gateway-keys').then(setKeys),
      api<{ logs: RequestLog[] }>('/logs?limit=5').then((result) => setLogs(result.logs)),
    ]).catch((error) => setNotice(error.message));

  useEffect(() => {
    void load();
  }, []);

  async function makeKey() {
    try {
      const result = await api<GatewayKey & { key: string }>('/gateway-keys', {
        method: 'POST',
        body: JSON.stringify({ name: `Key ${keys.length + 1}` }),
      });
      setNewKey(result.key);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create API key.');
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

  const example = `curl https://your-project.supabase.co/functions/v1/api/v1/chat/completions \\
  -H "x-oniroute-key: or_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}]}'`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">OniRoute</h1>
        <p className="mt-1 text-sm text-gray-500">One secure gateway for all of your AI providers.</p>
      </div>

      {notice && <p className="rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-900">{notice}</p>}

      {newKey && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <p className="font-medium text-amber-950">Copy this API key now — it will not be shown again.</p>
          <div className="mt-3 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white p-3 text-sm">{newKey}</code>
            <button onClick={() => copy(newKey)} className="rounded bg-amber-900 px-3 text-white">
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-white p-5">
          <Server className="h-5 w-5 text-violet-600" />
          <p className="mt-3 text-2xl font-bold">{providers.filter((provider) => provider.is_active).length}</p>
          <p className="text-sm text-gray-500">active providers</p>
        </div>
        <div className="rounded-xl border bg-white p-5">
          <KeyRound className="h-5 w-5 text-violet-600" />
          <p className="mt-3 text-2xl font-bold">{keys.filter((key) => !key.revoked_at).length}</p>
          <p className="text-sm text-gray-500">gateway keys</p>
        </div>
        <div className="rounded-xl border bg-white p-5">
          <p className="text-sm font-medium text-gray-500">Last request</p>
          <p className="mt-3 text-2xl font-bold">{logs[0]?.latency_ms ? `${logs[0].latency_ms}ms` : '—'}</p>
          <p className="text-sm text-gray-500">cloud routing latency</p>
        </div>
      </div>

      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Gateway API keys</h2>
            <p className="mt-1 text-sm text-gray-500">Use one key with the OpenAI-compatible endpoint below.</p>
          </div>
          <button
            onClick={makeKey}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 transition-colors"
          >
            <Plus className="h-4 w-4" /> Create key
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {keys
            .filter((key) => !key.revoked_at)
            .map((key) => (
              <div key={key.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-3 text-sm">
                <span>
                  {key.name} <code className="ml-2 text-xs text-gray-500">{key.key_prefix}</code>
                </span>
                <button onClick={() => revoke(key.id)} className="text-xs font-medium text-red-600 hover:text-red-800">
                  Revoke
                </button>
              </div>
            ))}
          {!keys.filter((key) => !key.revoked_at).length && (
            <p className="py-5 text-center text-sm text-gray-500">Create a key to call OniRoute from any client.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border bg-gray-950 p-5 text-gray-100">
        <p className="mb-2 text-sm font-semibold">OpenAI-compatible request</p>
        <pre className="overflow-x-auto text-xs leading-6">{example}</pre>
      </section>
    </div>
  );
}
