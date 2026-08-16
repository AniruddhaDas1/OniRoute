import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { RoutingConfig } from '../types';

export default function RoutingPage() {
  const [config, setConfig] = useState<RoutingConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<RoutingConfig>('/routing-config')
      .then(setConfig)
      .catch((error) => setNotice(error.message))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!config) return;
    setBusy(true);
    try {
      const next = await api<RoutingConfig>('/routing-config', {
        method: 'PUT',
        body: JSON.stringify({
          mode: config.mode,
          failover_enabled: config.failover_enabled,
          max_retries: Number(config.max_retries),
          timeout_ms: Number(config.timeout_ms),
          refine_prompt: config.refine_prompt || null,
        }),
      });
      setConfig(next);
      setNotice('Routing configuration saved successfully.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading routing configuration…</p>;
  if (notice && !config) return <p className="text-sm text-red-600">{notice}</p>;

  const c = config!;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Routing</h1>
        <p className="mt-1 text-sm text-gray-500">Control the provider sequence used by your single OniRoute API.</p>
      </div>

      {notice && <p className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900">{notice}</p>}

      <div className="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <fieldset>
          <legend className="text-sm font-semibold">Selection strategy</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => setConfig({ ...c, mode: 'priority' })}
              className={`rounded-lg border p-4 text-left ${c.mode === 'priority' ? 'border-violet-500 bg-violet-50' : 'border-gray-200'}`}
            >
              <strong className="block text-sm">Priority</strong>
              <span className="text-xs text-gray-500">Use the order set on Providers.</span>
            </button>
            <button
              onClick={() => setConfig({ ...c, mode: 'random' })}
              className={`rounded-lg border p-4 text-left ${c.mode === 'random' ? 'border-violet-500 bg-violet-50' : 'border-gray-200'}`}
            >
              <strong className="block text-sm">Random</strong>
              <span className="text-xs text-gray-500">Shuffle healthy providers per request.</span>
            </button>
          </div>
        </fieldset>

        <label className="flex cursor-pointer items-center justify-between gap-4 border-t pt-5">
          <span>
            <strong className="block text-sm">Automatic failover</strong>
            <span className="text-xs text-gray-500">Try the next provider on timeout, rate limit, credit, or server errors.</span>
          </span>
          <input
            type="checkbox"
            checked={c.failover_enabled}
            onChange={(e) => setConfig({ ...c, failover_enabled: e.target.checked })}
            className="h-5 w-5 accent-violet-600"
          />
        </label>

        <div className="grid gap-4 border-t pt-5 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Fallback attempts
            <input
              min="0"
              max="20"
              type="number"
              value={c.max_retries}
              onChange={(e) => setConfig({ ...c, max_retries: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
          <label className="text-sm font-medium">
            Timeout (ms)
            <input
              min="1000"
              max="30000"
              type="number"
              value={c.timeout_ms}
              onChange={(e) => setConfig({ ...c, timeout_ms: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
        </div>

        <div className="border-t pt-5">
          <label className="block text-sm font-medium">Prompt refinement</label>
          <input
            type="text"
            value={c.refine_prompt ?? ''}
            onChange={(e) => setConfig({ ...c, refine_prompt: e.target.value || null })}
            placeholder="e.g. Rewrite this as a precise technical query"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-400">
            Transform user messages before they reach the AI provider. Applied to every request when set.
          </p>
        </div>

        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
