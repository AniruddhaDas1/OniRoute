import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ApiProvider, RequestLog } from '../types';

export default function LogsPage() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ logs: RequestLog[] }>('/logs?limit=100').then((result) => setLogs(result.logs)),
      api<ApiProvider[]>('/providers').then(setProviders),
    ]).catch((reason) => setError(reason.message));
  }, []);

  const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? 'Deleted provider';

  const statusColor = (status: RequestLog['status']) => {
    switch (status) {
      case 'success':
        return 'text-emerald-600';
      case 'failover':
        return 'text-amber-600';
      case 'error':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Request logs</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cloud-side activity and failover history. API keys and prompts are never logged.
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Tokens</th>
              <th className="px-4 py-3">Latency</th>
              <th className="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b last:border-0 hover:bg-gray-50/50">
                <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">
                  {new Date(log.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {log.provider_id ? providerName(log.provider_id) : '—'}
                </td>
                <td className="px-4 py-3 capitalize text-gray-600">{log.mode}</td>
                <td className={`px-4 py-3 font-medium ${statusColor(log.status)}`}>{log.status}</td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {log.total_tokens !== null ? `${log.total_tokens.toLocaleString()} tok` : '—'}
                </td>
                <td className="px-4 py-3 text-gray-700">{log.latency_ms !== null ? `${log.latency_ms}ms` : '—'}</td>
                <td className="max-w-xs truncate px-4 py-3 text-xs text-gray-500">{log.error_message ?? '—'}</td>
              </tr>
            ))}
            {!logs.length && (
              <tr>
                <td colSpan={7} className="p-10 text-center text-gray-500">
                  No routed requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
