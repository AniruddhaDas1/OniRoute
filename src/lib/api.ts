import { supabase } from './supabase';

const DEMO_KEY = 'oniroute-demo';

type ApiResult<T> = { data: T; error: null } | { data: null; error: string };

function getDemoStore(key: string, defaultVal: any) {
  try {
    const raw = localStorage.getItem(`oniroute_demo_${key}`);
    return raw ? JSON.parse(raw) : defaultVal;
  } catch {
    return defaultVal;
  }
}

function setDemoStore(key: string, val: any) {
  try {
    localStorage.setItem(`oniroute_demo_${key}`, JSON.stringify(val));
  } catch {
    // ignore
  }
}

function mockResponse<T>(path: string, options: RequestInit = {}): T | null {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body as string) : {};

  if (path === '/routing-config') {
    if (method === 'PUT') {
      const current = getDemoStore('routing', {
        id: 'demo-routing',
        user_id: 'demo-user',
        mode: 'priority',
        failover_enabled: true,
        max_retries: 2,
        timeout_ms: 10000,
        refine_prompt: null,
      });
      const updated = { ...current, ...body };
      setDemoStore('routing', updated);
      return updated as T;
    }
    return getDemoStore('routing', {
      id: 'demo-routing',
      user_id: 'demo-user',
      mode: 'priority',
      failover_enabled: true,
      max_retries: 2,
      timeout_ms: 10000,
      refine_prompt: null,
      created_at: new Date().toISOString(),
    }) as T;
  }

  if (path === '/providers') {
    const list = getDemoStore('providers', []);
    if (method === 'POST') {
      const newProvider = {
        id: `demo-prov-${Date.now()}`,
        user_id: 'demo-user',
        name: body.name || 'Custom Provider',
        provider_type: body.provider_type || 'openai',
        base_url: body.base_url || 'https://api.openai.com/v1',
        endpoint: body.endpoint || '/chat/completions',
        model_name: body.model_name || 'gpt-4o-mini',
        embedding_model_name: body.embedding_model_name || null,
        is_active: true,
        priority: list.length,
        created_at: new Date().toISOString(),
      };
      list.push(newProvider);
      setDemoStore('providers', list);
      return newProvider as T;
    }
    return list as T;
  }

  if (path.startsWith('/providers/')) {
    const id = path.replace('/providers/', '');
    let list = getDemoStore('providers', []);
    if (method === 'DELETE') {
      list = list.filter((p: any) => p.id !== id);
      setDemoStore('providers', list);
      return { deleted: true } as T;
    }
  }

  if (path === '/providers/reorder') {
    return { reordered: body.provider_ids } as T;
  }

  if (path === '/knowledge') {
    const list = getDemoStore('knowledge', []);
    if (method === 'POST') {
      const newKb = {
        id: `demo-kb-${Date.now()}`,
        user_id: 'demo-user',
        name: body.name,
        source_type: body.source_type,
        source_url: body.source_url || null,
        source_content: body.content || null,
        embedding_provider_id: body.embedding_provider_id || null,
        status: 'complete',
        chunk_count: 8,
        created_at: new Date().toISOString(),
      };
      list.push(newKb);
      setDemoStore('knowledge', list);
      return newKb as T;
    }
    return list as T;
  }

  if (path.startsWith('/knowledge/') && path.endsWith('/ingest')) {
    return { status: 'queued' } as T;
  }

  if (path.startsWith('/knowledge/')) {
    const id = path.replace('/knowledge/', '');
    let list = getDemoStore('knowledge', []);
    if (method === 'DELETE') {
      list = list.filter((k: any) => k.id !== id);
      setDemoStore('knowledge', list);
      return { deleted: true } as T;
    }
  }

  if (path.startsWith('/test-provider/')) {
    return { success: true, latency_ms: 128 } as T;
  }

  if (path === '/gateway-keys') {
    const list = getDemoStore('keys', []);
    if (method === 'POST') {
      const keyStr = `or_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const newKey = {
        id: `demo-key-${Date.now()}`,
        name: body.name || `Key ${list.length + 1}`,
        key_prefix: `${keyStr.slice(0, 11)}…`,
        key: keyStr,
        max_context_tokens: body.max_context_tokens || null,
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      list.push(newKey);
      setDemoStore('keys', list);
      return newKey as T;
    }
    return list.filter((k: any) => !k.revoked_at) as T;
  }

  if (path.startsWith('/gateway-keys/')) {
    const id = path.replace('/gateway-keys/', '');
    let list = getDemoStore('keys', []);
    if (method === 'DELETE') {
      list = list.filter((k: any) => k.id !== id);
      setDemoStore('keys', list);
      return { revoked: true } as T;
    }
  }

  if (path === '/chat') {
    return {
      response: 'Hello! This is a simulated response from OniRoute. Your request was successfully processed through the gateway routing pipeline.',
      provider_used: 'Demo AI Router',
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
    const mock = mockResponse<T>(path, options);
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
