/**
 * Allowed browser origins for the dashboard.
 *
 * Defaults to `*` so a fresh self-hosted deployment works without extra
 * configuration. Set `ONIROUTE_ALLOWED_ORIGINS` to a comma-separated list to
 * lock the control plane down to your own dashboard origin — worth doing, since
 * these routes can mint and revoke gateway keys.
 *
 *   supabase secrets set ONIROUTE_ALLOWED_ORIGINS=https://app.example.com
 */
export function allowedOrigins(): string[] | '*' {
  const configured = Deno.env.get('ONIROUTE_ALLOWED_ORIGINS')?.trim();
  if (!configured || configured === '*') return '*';
  const origins = configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  return origins.length ? origins : '*';
}

export const ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'apikey', 'x-client-info', 'x-oniroute-key'];
export const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
