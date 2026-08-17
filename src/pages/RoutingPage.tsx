import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, Zap, Shuffle, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import type { RoutingConfig } from '../types';

const defaultRoutingConfig: RoutingConfig = {
  id: 'default',
  user_id: '',
  mode: 'priority',
  failover_enabled: true,
  max_retries: 3,
  timeout_ms: 10000,
  refine_prompt: null,
  created_at: new Date().toISOString(),
};

export default function RoutingPage() {
  const [config, setConfig] = useState<RoutingConfig>(defaultRoutingConfig);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let isMounted = true;
    api<RoutingConfig>('/routing-config')
      .then((data) => {
        if (isMounted && data) setConfig(data);
      })
      .catch((error) => {
        if (isMounted) setNotice({ type: 'error', message: error.message });
      });
    return () => {
      isMounted = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setNotice(null);
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
      if (next) setConfig(next);
      setNotice({ type: 'success', message: 'Routing configuration saved successfully.' });
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not save settings.',
      });
    } finally {
      setSaving(false);
    }
  }

  const c = config;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Global Routing Strategy</h1>
          <p className="mt-1 text-sm text-gray-500">
            Control the default upstream model sequence, failover retries, and prompt transformations.
          </p>
        </div>
      </div>

      {notice && (
        <div
          className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm border ${
            notice.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {notice.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
          ) : null}
          <span>{notice.message}</span>
        </div>
      )}

      <div className="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        {/* Selection Strategy */}
        <fieldset>
          <legend className="text-sm font-semibold text-gray-900">Default Model Selection Strategy</legend>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">
            Determines how requests without a dedicated Provider Group choose an upstream provider.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setConfig({ ...c, mode: 'priority' })}
              className={`rounded-xl border p-4 text-left transition-all ${
                c.mode === 'priority'
                  ? 'border-violet-600 bg-violet-50 text-violet-950 font-semibold ring-2 ring-violet-500/20'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-700'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-bold">
                <Zap className="h-4 w-4 text-violet-600" /> Priority Ordering
              </div>
              <p className="mt-1.5 text-xs text-gray-500 font-normal">
                Dispatches to the 1st active provider. Automatically fails over to the next provider on failure.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setConfig({ ...c, mode: 'random' })}
              className={`rounded-xl border p-4 text-left transition-all ${
                c.mode === 'random'
                  ? 'border-violet-600 bg-violet-50 text-violet-950 font-semibold ring-2 ring-violet-500/20'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-700'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-bold">
                <Shuffle className="h-4 w-4 text-violet-600" /> Random Load Balance
              </div>
              <p className="mt-1.5 text-xs text-gray-500 font-normal">
                Evenly distributes traffic randomly across all active healthy upstream models.
              </p>
            </button>
          </div>
        </fieldset>

        {/* Automatic Failover Toggle */}
        <label className="flex cursor-pointer items-center justify-between gap-4 border-t border-gray-100 pt-5">
          <div className="space-y-0.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <ShieldCheck className="h-4 w-4 text-violet-600" /> Automatic Failover &amp; Circuit Breakers
            </span>
            <p className="text-xs text-gray-500">
              Try next candidate provider on timeout, 429 rate limit, 5xx server errors, or token exhaustion.
            </p>
          </div>
          <input
            type="checkbox"
            checked={c.failover_enabled}
            onChange={(e) => setConfig({ ...c, failover_enabled: e.target.checked })}
            className="h-5 w-5 rounded text-violet-600 focus:ring-violet-500 accent-violet-600 cursor-pointer"
          />
        </label>

        {/* Retries and Timeout */}
        <div className="grid gap-4 border-t border-gray-100 pt-5 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
              Max Fallback Attempts
            </label>
            <input
              min="0"
              max="20"
              type="number"
              value={c.max_retries}
              onChange={(e) => setConfig({ ...c, max_retries: Number(e.target.value) })}
              className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <p className="mt-1 text-[11px] text-gray-400">Number of alternative providers to try before returning error.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
              Request Timeout (ms)
            </label>
            <input
              min="1000"
              max="60000"
              step="1000"
              type="number"
              value={c.timeout_ms}
              onChange={(e) => setConfig({ ...c, timeout_ms: Number(e.target.value) })}
              className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <p className="mt-1 text-[11px] text-gray-400">Maximum milliseconds to wait for model response before failover.</p>
          </div>
        </div>

        {/* Global Prompt Refinement */}
        <div className="border-t border-gray-100 pt-5">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700">
            Global Prompt Refinement <span className="font-normal text-gray-400">(Optional)</span>
          </label>
          <input
            type="text"
            value={c.refine_prompt ?? ''}
            onChange={(e) => setConfig({ ...c, refine_prompt: e.target.value || null })}
            placeholder="e.g. Rewrite user input as a concise, expert software engineer query"
            className="mt-1.5 w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
          />
          <p className="mt-1 text-xs text-gray-400">
            Transforms user prompts before dispatching to downstream AI models.
          </p>
        </div>

        {/* Save button */}
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50 transition-colors"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </div>
    </div>
  );
}
