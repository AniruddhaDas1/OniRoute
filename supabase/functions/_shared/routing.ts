import type { RoutingConfig } from './types.ts';

/**
 * Mirrors the column defaults in the `routing_configs` table. A user who never
 * opens the Routing page has no row at all, and the previous code read that
 * missing row as `failover_enabled: false` — silently disabling the product's
 * headline feature for exactly the API-first users who needed it.
 */
export const DEFAULT_ROUTING: RoutingConfig = {
  mode: 'priority',
  failover_enabled: true,
  max_retries: 3,
  timeout_ms: 10_000,
  refine_prompt: null,
};

export function resolveRouting(row: Partial<RoutingConfig> | null | undefined): RoutingConfig {
  const mode = row?.mode === 'random' ? 'random' : DEFAULT_ROUTING.mode;
  const maxRetries = Number(row?.max_retries);
  const timeoutMs = Number(row?.timeout_ms);
  return {
    mode,
    failover_enabled: typeof row?.failover_enabled === 'boolean' ? row.failover_enabled : DEFAULT_ROUTING.failover_enabled,
    max_retries: Number.isFinite(maxRetries) ? Math.min(Math.max(maxRetries, 0), 20) : DEFAULT_ROUTING.max_retries,
    timeout_ms: Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1_000), 120_000) : DEFAULT_ROUTING.timeout_ms,
    refine_prompt: row?.refine_prompt ?? null,
  };
}

/**
 * Should we move on to the next provider? Broader than `isTransientFailure`:
 * 401/402 mean this provider will not serve the request, so trying the next one
 * is useful even though the provider itself is not unhealthy.
 */
export function isFailoverError(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 408 ||
    status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Should this failure count against the provider's health? Only transient
 * conditions qualify. A 400 from a mistyped model name is the user's
 * configuration problem: counting it used to trip the breaker after three
 * attempts and lock a perfectly healthy provider out for five minutes.
 */
export function isTransientFailure(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Fisher-Yates. The previous implementation passed a random comparator to
 * `Array.prototype.sort`, which is not a uniform shuffle — comparison sorts
 * assume a consistent ordering, and V8's TimSort leaves the head of the array
 * in place far more often than chance, skewing load toward one provider.
 */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0];
    // Rejection-free modulo bias is irrelevant at these lengths, but the
    // divisor form keeps the distribution clean regardless of list size.
    const swap = Math.floor((random / 2 ** 32) * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}
