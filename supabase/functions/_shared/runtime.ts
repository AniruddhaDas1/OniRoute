// Supabase runs Edge Functions on a runtime that exposes `EdgeRuntime`. Work
// handed to `waitUntil` survives after the response is returned; without it a
// detached promise can be killed when the isolate is torn down.
declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export function runBackground(promise: Promise<unknown>, label: string): void {
  const guarded = promise.catch((error: unknown) => {
    console.error(`[background:${label}]`, error instanceof Error ? error.message : error);
  });
  if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime?.waitUntil === 'function') {
    EdgeRuntime.waitUntil(guarded);
    return;
  }
  void guarded;
}

/** Fetch with a hard deadline. Every outbound call in OniRoute goes through this. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request to ${new URL(url).host} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** Length-independent comparison, for secrets that arrive from the network. */
export function secureEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

export function joinUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${baseUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
}
