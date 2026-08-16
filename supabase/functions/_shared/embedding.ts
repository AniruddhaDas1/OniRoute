import type { ApiProvider } from './types.ts';
import { fetchWithTimeout, joinUrl } from './runtime.ts';

/** Matches `vector(1536)` on `public.vector_chunks.embedding`. */
export const EMBEDDING_DIMENSIONS = 1536;

const EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Embed a single string with the user's configured provider.
 *
 * Shared by the gateway (query embedding for refined mode) and the
 * `embed-knowledge` worker (document embedding), so the dialect handling and
 * the dimension guard can never disagree between the two.
 */
export async function embedText(provider: ApiProvider, apiKey: string, text: string): Promise<number[]> {
  const model = provider.embedding_model_name || provider.model_name;
  let url: string;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: unknown;

  if (provider.provider_type === 'google') {
    url = `${provider.base_url.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:embedContent`;
    headers = { ...headers, 'x-goog-api-key': apiKey };
    body = { model: `models/${model}`, content: { parts: [{ text }] } };
  } else if (provider.provider_type === 'ollama') {
    if (apiKey && apiKey !== 'ollama') headers.Authorization = `Bearer ${apiKey}`;
    if (provider.base_url.endsWith('/api') || provider.endpoint === '/chat' || provider.endpoint === '/api/chat') {
      url = joinUrl(provider.base_url, '/embed');
      body = { model, input: text };
    } else {
      const derived = provider.endpoint.replace(/chat\/completions\/?$/i, 'embeddings').replace(/messages\/?$/i, 'embeddings');
      url = joinUrl(provider.base_url, derived === provider.endpoint ? '/v1/embeddings' : derived);
      body = { model, input: text };
    }
  } else {
    // Derive the embeddings endpoint from the configured chat endpoint so a
    // provider only has to be registered once.
    const derived = provider.endpoint.replace(/chat\/completions\/?$/i, 'embeddings').replace(/messages\/?$/i, 'embeddings');
    url = joinUrl(provider.base_url, derived === provider.endpoint ? '/v1/embeddings' : derived);
    headers = { ...headers, Authorization: `Bearer ${apiKey}` };
    body = { model, input: text };
  }

  const response = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, EMBEDDING_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();
  const embedding =
    provider.provider_type === 'google'
      ? payload.embedding?.values
      : payload.embeddings?.[0] ?? payload.data?.[0]?.embedding ?? payload.embedding;

  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding model "${model}" must return ${EMBEDDING_DIMENSIONS} dimensions; received ` +
        `${Array.isArray(embedding) ? embedding.length : 'none'}. text-embedding-3-small or a 1536-dim model is required for pgvector.`,
    );
  }
  return embedding as number[];
}
