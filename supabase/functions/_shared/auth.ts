import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secureEquals } from './runtime.ts';

export interface AuthUser {
  id: string;
  email: string;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

export function getSupabaseClient(authHeader: string | null): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let serviceClient: SupabaseClient | null = null;

/** Full-privilege client. Every caller must have already established ownership. */
export function getServiceClient(): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}

export async function getAuthUser(authHeader: string | null): Promise<AuthUser | null> {
  if (!authHeader) return null;

  const supabase = getSupabaseClient(authHeader);
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) return null;

  return { id: user.id, email: user.email || '' };
}

/**
 * Gate for function-to-function calls (the gateway enqueuing an ingestion job).
 *
 * The caller must present the service-role key, which only the Edge runtime
 * holds. A signed-in user's JWT is *not* sufficient — `verify_jwt` alone would
 * accept any authenticated user and let them drive the worker directly.
 */
export function isTrustedInternalCaller(authHeader: string | null): boolean {
  const presented = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!presented) return false;
  const workerSecret = Deno.env.get('ONIROUTE_WORKER_SECRET');
  if (workerSecret && secureEquals(presented, workerSecret)) return true;
  return secureEquals(presented, requireEnv('SUPABASE_SERVICE_ROLE_KEY'));
}
