import { supabase } from './supabase';

const DEMO_KEY = 'oniroute-demo';

type ApiResult<T> = { data: T; error: null } | { data: null; error: string };

function mockResponse<T>(path: string): T | null {
  if (path === '/routing-config') {
    return {
      id: 'demo-routing',
      user_id: 'demo-user',
      mode: 'priority' as const,
      failover_enabled: true,
      max_retries: 2,
      timeout_ms: 10000,
      created_at: new Date().toISOString(),
    } as T;
  }
  if (path === '/providers') {
    return [] as T;
  }
  if (path === '/knowledge') {
    return [] as T;
  }
  if (path.startsWith('/test-provider/')) {
    return { success: true, latency_ms: 120 } as T;
  }
  if (path === '/gateway-keys') {
    return [] as T;
  }
  if (path === '/chat') {
    return {
      response: 'Hello! This is a simulated response from OniRoute Demo Mode. Connect your Supabase credentials or local server to route live requests to upstream AI providers.',
      provider_used: 'Simulated Demo Gateway',
      latency_ms: 142,
    } as T;
  }
  if (path.startsWith('/logs')) {
    return { logs: [] } as T;
  }
  return null;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isDemo = typeof localStorage !== 'undefined' && localStorage.getItem(DEMO_KEY) === 'true';

  if (isDemo) {
    const mock = mockResponse<T>(path);
    if (mock !== null) return mock;
  }

  const isStandalone = Boolean(
    import.meta.env.VITE_API_URL ||
    import.meta.env.VITE_SUPABASE_URL?.includes(':1001')
  );

  let authHeader: string | undefined;
  if (!isDemo && !isStandalone) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Your session has expired. Please sign in again.');
    authHeader = `Bearer ${session.access_token}`;
  }

  const endpointUrl = isStandalone
    ? `${(import.meta.env.VITE_API_URL || import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')}${path}`
    : `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api${path}`;

  const response = await fetch(endpointUrl, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || 'standalone',
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(options.headers ?? {}),
    },
  });
  const result = await response.json() as ApiResult<T>;
  if (!response.ok || result.error) throw new Error(result.error || 'The request failed.');
  return result.data as T;
}
