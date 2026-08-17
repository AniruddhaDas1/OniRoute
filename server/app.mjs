import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder, TextDecoder } from 'node:util';
import { db, LOCAL_USER_ID } from './db.mjs';
import { sha256, createGatewayKey } from './crypto.mjs';
import {
  buildProviderRequest,
  normaliseMessages,
  parseProviderResponse,
  parseProviderStreamLine,
  embedText,
  pruneContextToBudget,
  validateProviderUrl,
} from './provider-client.mjs';
import { searchVectorChunks } from './vector.mjs';
import { splitChunks } from './chunking.mjs';
import { sourceFromGitHub } from './github.mjs';

export const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'apikey', 'x-client-info', 'x-oniroute-key', 'x-oniroute-admin-key'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

function ok(data) {
  return { data, error: null };
}
function err(message) {
  return { data: null, error: message };
}

function isFailoverError(status) {
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500;
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// =============================================================================
// Control-Plane Authentication Middleware (Protects Management & Vault Secrets)
// =============================================================================
export async function authenticateControlPlane(c, next) {
  const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const customKey = (c.req.header('x-oniroute-admin-key') || c.req.header('x-oniroute-key') || token).trim();

  // 1. Explicit admin key configured in environment
  const envAdminKey = process.env.ONIROUTE_ADMIN_KEY;
  if (envAdminKey && customKey === envAdminKey) {
    return next();
  }

  // 2. Valid gateway key
  if (customKey && customKey.startsWith('or_')) {
    const keyRecord = db.getGatewayKeyByHash(sha256(customKey));
    if (keyRecord && !keyRecord.revoked_at) {
      return next();
    }
  }

  // 3. Local loopback check (Allowed when server is strictly bound to localhost/127.0.0.1)
  const hostHeader = (c.req.header('host') || '').toLowerCase();
  const isLoopback =
    hostHeader.startsWith('localhost') ||
    hostHeader.startsWith('127.0.0.1') ||
    hostHeader.startsWith('0.0.0.0');

  const isBoundToLocalhost = !process.env.HOST || process.env.HOST === '127.0.0.1';

  if (isLoopback && isBoundToLocalhost) {
    return next();
  }

  return c.json(err('Unauthorized control-plane access. A valid OniRoute key or ONIROUTE_ADMIN_KEY is required for remote management.'), 401);
}

async function sendToProvider(provider, apiKey, messages, options, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const req = buildProviderRequest(provider, apiKey, messages, options);
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, latencyMs, status: res.status, error: (await res.text()).slice(0, 600) };
    }
    const parsed = parseProviderResponse(provider, await res.json());
    if (!parsed.content) {
      return { ok: false, latencyMs, status: 502, error: 'Provider returned an empty response.' };
    }
    return { ok: true, latencyMs, parsed };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, status: 503, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sendToProviderStream(provider, apiKey, messages, options, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 8000, 8000));
  try {
    const req = buildProviderRequest(provider, apiKey, messages, { ...options, stream: true });
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, latencyMs, status: res.status, error: (await res.text()).slice(0, 600) };
    }
    if (!res.body) {
      return { ok: false, latencyMs, status: 502, error: 'Provider returned no response stream.' };
    }
    return { ok: true, latencyMs, response: res, provider };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, status: 503, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function refineUserMessage(providers, userMessage, refinePrompt, timeoutMs) {
  for (const provider of providers) {
    const apiKey = db.getProviderSecret(provider.id);
    if (!apiKey) continue;
    const res = await sendToProvider(
      provider,
      apiKey,
      [
        { role: 'system', content: refinePrompt },
        { role: 'user', content: userMessage },
      ],
      { maxTokens: 512, temperature: 0.3 },
      timeoutMs,
    );
    if (res.ok && res.parsed?.content?.trim()) {
      return res.parsed.content.trim();
    }
  }
  return userMessage;
}

async function resolveProvidersAndMessages(body, userId, keyRecord) {
  let mode = body.mode === 'refined' ? 'refined' : 'direct';
  if (keyRecord?.gateway_mode && keyRecord.gateway_mode !== 'flexible') {
    mode = keyRecord.gateway_mode;
  }

  const config = db.getRoutingConfig(userId);
  let allProviders = db.getProviders(userId).filter((p) => p.is_active);

  let candidateProviderIds = null;
  let keyOrGroupRoutingMode = keyRecord?.routing_mode || null;

  if (keyRecord?.provider_group_id) {
    const group = db.getProviderGroupById(keyRecord.provider_group_id, userId);
    if (group) {
      candidateProviderIds = group.provider_ids || [];
      if (!keyOrGroupRoutingMode) {
        keyOrGroupRoutingMode = group.routing_mode;
      }
    }
  } else if (Array.isArray(keyRecord?.selected_provider_ids) && keyRecord.selected_provider_ids.length) {
    candidateProviderIds = keyRecord.selected_provider_ids;
  }

  let providers = allProviders;
  if (candidateProviderIds && candidateProviderIds.length) {
    const idToProvider = new Map(allProviders.map((p) => [p.id, p]));
    providers = candidateProviderIds
      .map((id) => idToProvider.get(id))
      .filter((p) => Boolean(p && p.is_active));
  }

  const effectiveRoutingMode = keyOrGroupRoutingMode || config.mode || 'priority';
  if (effectiveRoutingMode === 'random') {
    providers = shuffle(providers);
  }

  // If client requested a specific model (and not "oniroute"), prioritize that provider
  if (body.model && body.model.toLowerCase() !== 'oniroute') {
    const reqModel = body.model.toLowerCase();
    providers.sort((a, b) => {
      const matchA = a.model_name.toLowerCase() === reqModel || a.name.toLowerCase() === reqModel;
      const matchB = b.model_name.toLowerCase() === reqModel || b.name.toLowerCase() === reqModel;
      if (matchA && !matchB) return -1;
      if (!matchA && matchB) return 1;
      return 0;
    });
  }

  if (!providers.length) {
    throw new Error('No active providers available for routing.');
  }

  const systemBlocks = [];
  if (body.system_prompt) systemBlocks.push(body.system_prompt);

  let turns = [];
  if (Array.isArray(body.messages) && body.messages.length) {
    const normalised = normaliseMessages(body.messages);
    for (const msg of normalised) {
      if (msg.role === 'system') systemBlocks.push(msg.content);
      else turns.push(msg);
    }
  } else if (body.message?.trim()) {
    turns = [{ role: 'user', content: body.message.trim() }];
  }

  const refinePrompt = body.refine_prompt?.trim() ?? config.refine_prompt?.trim();
  if (refinePrompt && turns.some((turn) => turn.role === 'user')) {
    const lastUserIndex = turns.map((turn) => turn.role).lastIndexOf('user');
    const originalMessage = turns[lastUserIndex].content;
    const refined = await refineUserMessage(providers, originalMessage, refinePrompt, config.timeout_ms);
    turns[lastUserIndex] = { role: 'user', content: refined };
  }

  let contextUsed = [];
  if (mode === 'refined' && body.knowledge_base_id) {
    const kb = db.getKnowledgeBaseById(body.knowledge_base_id, userId);
    if (kb) {
      const embeddingProviderId = body.embedding_provider_id || kb.embedding_provider_id || providers[0]?.id;
      const embeddingProvider = db.getProviderById(embeddingProviderId, userId);
      const apiKey = embeddingProvider ? db.getProviderSecret(embeddingProvider.id) : null;
      if (embeddingProvider && apiKey) {
        const query = turns.filter((t) => t.role === 'user').at(-1)?.content ?? '';
        try {
          const queryEmbedding = await embedText(embeddingProvider, apiKey, query);
          const matches = searchVectorChunks(userId, queryEmbedding, body.knowledge_base_id, 6);
          contextUsed = matches.map((m) => m.content);
          if (contextUsed.length) {
            systemBlocks.push(
              'Answer using the supplied knowledge when relevant. If the knowledge does not contain the answer, say so clearly.' +
                `\n\nKnowledge:\n${contextUsed.join('\n\n---\n\n')}`,
            );
          }
        } catch {
          // Non-fatal RAG search fallback
        }
      }
    }
  }

  const effectiveMaxTokens = body.max_context_tokens || keyRecord?.max_context_tokens;
  const messages = pruneContextToBudget(systemBlocks, turns, effectiveMaxTokens);

  return { mode, config, providers, messages, systemBlocks, turns, contextUsed };
}

async function routedChat(body, userId = LOCAL_USER_ID, keyRecord = null) {
  const { mode, config, providers, messages } = await resolveProvidersAndMessages(body, userId, keyRecord);
  const maxAttempts = Math.min(providers.length, (config.max_retries ?? 3) + 1);
  const failures = [];

  for (const provider of providers.slice(0, maxAttempts)) {
    const apiKey = db.getProviderSecret(provider.id);
    if (!apiKey) {
      failures.push(`${provider.name}: No API key configured`);
      continue;
    }
    const result = await sendToProvider(provider, apiKey, messages, body, config.timeout_ms);
    if (result.ok) {
      db.writeLog({
        user_id: userId,
        provider_id: provider.id,
        status: 'success',
        latency_ms: result.latencyMs,
        mode,
        usage: result.parsed.usage,
      });
      return {
        response: result.parsed.content,
        provider_used: provider.name,
        provider_id: provider.id,
        model: result.parsed.model,
        finish_reason: result.parsed.finishReason,
        usage: result.parsed.usage,
        latency_ms: result.latencyMs,
        mode,
      };
    }

    failures.push(`${provider.name}: ${result.error}`);
    db.writeLog({
      user_id: userId,
      provider_id: provider.id,
      status: isFailoverError(result.status) ? 'failover' : 'error',
      latency_ms: result.latencyMs,
      mode,
      error_message: result.error,
    });

    if (!config.failover_enabled || !isFailoverError(result.status)) break;
  }

  throw new Error(`All providers failed. ${failures.join(' | ')}`);
}

async function routedChatStream(body, userId = LOCAL_USER_ID, keyRecord = null) {
  const { mode, config, providers, messages } = await resolveProvidersAndMessages(body, userId, keyRecord);
  const maxAttempts = Math.min(providers.length, (config.max_retries ?? 3) + 1);
  const failures = [];

  for (const provider of providers.slice(0, maxAttempts)) {
    const apiKey = db.getProviderSecret(provider.id);
    if (!apiKey) {
      failures.push(`${provider.name}: No API key configured`);
      continue;
    }
    const result = await sendToProviderStream(provider, apiKey, messages, body, config.timeout_ms);
    if (result.ok) {
      // True end-to-end streaming bridge
      const reader = result.response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const id = `chatcmpl_${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = provider.model_name || 'oniroute';
      const startedAt = Date.now();
      let buffer = '';
      let hasEmittedFinish = false;

      const stream = new ReadableStream({
        async start(controller) {
          // Initial assistant role event (OpenAI standard)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              })}\n\n`,
            ),
          );

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                const delta = parseProviderStreamLine(provider, line);
                if (!delta) continue;

                if (delta.text) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
                      })}\n\n`,
                    ),
                  );
                }

                if ((delta.done || delta.finishReason) && !hasEmittedFinish) {
                  hasEmittedFinish = true;
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{ index: 0, delta: {}, finish_reason: delta.finishReason || 'stop' }],
                      })}\n\n`,
                    ),
                  );
                }
              }
            }

            if (buffer.trim()) {
              const delta = parseProviderStreamLine(provider, buffer);
              if (delta?.text) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
                    })}\n\n`,
                  ),
                );
              }
            }

            if (!hasEmittedFinish) {
              hasEmittedFinish = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  })}\n\n`,
                ),
              );
            }

            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();

            db.writeLog({
              user_id: userId,
              provider_id: provider.id,
              status: 'success',
              latency_ms: Date.now() - startedAt,
              mode,
            });
          } catch (streamErr) {
            if (!hasEmittedFinish) {
              hasEmittedFinish = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: { content: `\n\n[Streaming Error: ${streamErr.message}]` }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
            controller.close();
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'access-control-allow-origin': '*',
        },
      });
    }

    failures.push(`${provider.name}: ${result.error}`);
    db.writeLog({
      user_id: userId,
      provider_id: provider.id,
      status: isFailoverError(result.status) ? 'failover' : 'error',
      latency_ms: result.latencyMs,
      mode,
      error_message: result.error,
    });

    if (!config.failover_enabled || !isFailoverError(result.status)) break;
  }

  throw new Error(`All providers failed streaming. ${failures.join(' | ')}`);
}

// =============================================================================
// REST Routes (Protected Control Plane)
// =============================================================================

// Providers
app.get('/providers', authenticateControlPlane, (c) => c.json(ok(db.getProviders())));

app.post('/providers', authenticateControlPlane, async (c) => {
  const body = await c.req.json();
  try {
    validateProviderUrl(body, false);
  } catch (e) {
    return c.json(err(e.message), 400);
  }
  const provider = db.createProvider(body, body.api_key);
  return c.json(ok(provider), 201);
});

app.put('/providers/reorder', authenticateControlPlane, async (c) => {
  const { provider_ids } = await c.req.json();
  db.reorderProviders(provider_ids);
  return c.json(ok({ reordered: provider_ids }));
});

app.put('/providers/:id', authenticateControlPlane, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const existing = db.getProviderById(id);
  if (!existing) return c.json(err('Not found'), 404);

  try {
    validateProviderUrl({ ...existing, ...body }, false);
  } catch (e) {
    return c.json(err(e.message), 400);
  }

  const provider = db.updateProvider(id, body, body.api_key);
  return provider ? c.json(ok(provider)) : c.json(err('Not found'), 404);
});

app.delete('/providers/:id', authenticateControlPlane, (c) => {
  const deleted = db.deleteProvider(c.req.param('id'));
  return c.json(ok({ deleted }));
});

app.get('/providers/:id/secret', authenticateControlPlane, (c) => {
  const provider = db.getProviderById(c.req.param('id'));
  if (!provider) return c.json(err('Not found'), 404);
  const secret = db.getProviderSecret(provider.id);
  return c.json(ok({ api_key: secret || '', exists: Boolean(secret) }));
});

app.post('/test-provider/:id', authenticateControlPlane, async (c) => {
  const provider = db.getProviderById(c.req.param('id'));
  if (!provider) return c.json(err('Not found'), 404);
  const apiKey = db.getProviderSecret(provider.id);
  const result = await sendToProvider(
    provider,
    apiKey,
    [{ role: 'user', content: 'Reply with exactly: OniRoute connection successful.' }],
    { maxTokens: 64 },
    10000,
  );
  return c.json(
    ok(
      result.ok
        ? { success: true, latency_ms: result.latencyMs, response: result.parsed.content }
        : { success: false, latency_ms: result.latencyMs, error: result.error },
    ),
  );
});

// Routing
app.get('/routing-config', authenticateControlPlane, (c) => c.json(ok(db.getRoutingConfig())));
app.put('/routing-config', authenticateControlPlane, async (c) => {
  const body = await c.req.json();
  const updated = db.updateRoutingConfig(body);
  return c.json(ok(updated));
});

// Knowledge Bases
app.get('/knowledge', authenticateControlPlane, (c) => c.json(ok(db.getKnowledgeBases())));
app.post('/knowledge', authenticateControlPlane, async (c) => {
  const body = await c.req.json();
  const kb = db.createKnowledgeBase(body);
  return c.json(ok(kb), 201);
});
app.delete('/knowledge/:id', authenticateControlPlane, (c) => {
  const deleted = db.deleteKnowledgeBase(c.req.param('id'));
  return c.json(ok({ deleted }));
});

// Asynchronous Ingest
app.post('/knowledge/:id/ingest', authenticateControlPlane, async (c) => {
  const id = c.req.param('id');
  const kb = db.getKnowledgeBaseById(id);
  if (!kb) return c.json(err('Not found'), 404);

  const body = await c.req.json().catch(() => ({}));
  const providerId = body.embedding_provider_id || kb.embedding_provider_id;
  const provider = db.getProviderById(providerId) || db.getProviders()[0];
  if (!provider) return c.json(err('Select an embedding provider first.'), 400);

  db.updateKnowledgeBase(id, { status: 'processing', ingest_started_at: new Date().toISOString() });

  (async () => {
    try {
      let content = kb.source_content;
      if (kb.source_type === 'repo') {
        const repo = await sourceFromGitHub(kb.source_url);
        content = repo.content;
      }
      const split = splitChunks(content);
      const apiKey = db.getProviderSecret(provider.id);
      const vectors = [];

      for (let i = 0; i < split.chunks.length; i++) {
        const embedding = await embedText(provider, apiKey, split.chunks[i]);
        vectors.push({ content: split.chunks[i], embedding, metadata: { index: i } });
      }

      db.replaceVectorChunks(id, vectors);
      db.updateKnowledgeBase(id, {
        status: 'complete',
        chunk_count: vectors.length,
        ingest_completed_at: new Date().toISOString(),
        ingest_stats: { chunks_total: vectors.length, chunks_embedded: vectors.length },
      });
    } catch (e) {
      db.updateKnowledgeBase(id, { status: 'error', error_message: e.message });
    }
  })();

  return c.json(ok({ queued: true }), 202);
});

// Provider Groups
app.get('/provider-groups', authenticateControlPlane, (c) => c.json(ok(db.getProviderGroups())));

app.post('/provider-groups', authenticateControlPlane, async (c) => {
  const body = await c.req.json();
  if (Array.isArray(body.provider_ids) && body.provider_ids.length > 0) {
    const userProviders = db.getProviders(LOCAL_USER_ID);
    const ownedIds = new Set(userProviders.map((p) => p.id));
    const invalid = body.provider_ids.filter((pId) => !ownedIds.has(pId));
    if (invalid.length > 0) {
      return c.json(err(`Invalid provider IDs: ${invalid.join(', ')}`), 400);
    }
  }
  const group = db.createProviderGroup(body);
  return c.json(ok(group), 201);
});

app.put('/provider-groups/:id', authenticateControlPlane, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (Array.isArray(body.provider_ids) && body.provider_ids.length > 0) {
    const userProviders = db.getProviders(LOCAL_USER_ID);
    const ownedIds = new Set(userProviders.map((p) => p.id));
    const invalid = body.provider_ids.filter((pId) => !ownedIds.has(pId));
    if (invalid.length > 0) {
      return c.json(err(`Invalid provider IDs: ${invalid.join(', ')}`), 400);
    }
  }
  const updated = db.updateProviderGroup(id, body);
  if (!updated) return c.json(err('Provider group not found'), 404);
  return c.json(ok(updated));
});

app.delete('/provider-groups/:id', authenticateControlPlane, (c) => {
  const deleted = db.deleteProviderGroup(c.req.param('id'));
  return c.json(ok({ deleted }));
});

// Logs
app.get('/logs', authenticateControlPlane, (c) => {
  const limit = Number(c.req.query('limit') || 50);
  const status = c.req.query('status') || null;
  return c.json(ok({ logs: db.getLogs(LOCAL_USER_ID, limit, status), next_cursor: null }));
});

// Gateway Keys
app.get('/gateway-keys', authenticateControlPlane, (c) => c.json(ok(db.getGatewayKeys())));
app.post('/gateway-keys', authenticateControlPlane, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const key = createGatewayKey();
  const keyHash = sha256(key);
  const record = db.createGatewayKey(
    body.name,
    `${key.slice(0, 11)}…`,
    keyHash,
    LOCAL_USER_ID,
    body.max_context_tokens,
    {
      provider_group_id: body.provider_group_id,
      routing_mode: body.routing_mode,
      gateway_mode: body.gateway_mode,
      selected_provider_ids: body.selected_provider_ids,
    }
  );
  return c.json(ok({ ...record, key }), 201);
});
app.delete('/gateway-keys/:id', authenticateControlPlane, (c) => {
  const revoked = db.revokeGatewayKey(c.req.param('id'));
  return c.json(ok({ revoked }));
});

// --- Super Admin & Member Management ---
app.get('/admin/members', authenticateControlPlane, (c) => {
  return c.json(ok(db.getMembers()));
});

app.patch('/admin/members/:id', authenticateControlPlane, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updated = db.updateMember(id, body);
    if (!updated) return c.json(err('Member not found'), 404);
    return c.json(ok(updated));
  } catch (error) {
    return c.json(err(error.message), 400);
  }
});

// Auth helper for inference routes
function authenticateGatewayKey(c) {
  const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
  const keyHeader =
    c.req.header('x-oniroute-key') ||
    c.req.header('x-api-key') ||
    c.req.header('api-key') ||
    c.req.header('X-API-KEY');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const rawKey = (keyHeader || token).trim();

  if (!rawKey) return null;
  const keyRecord = db.getGatewayKeyByHash(sha256(rawKey));
  if (keyRecord && !keyRecord.revoked_at) {
    db.touchGatewayKey(keyRecord.id);
    return keyRecord;
  }
  return null;
}

app.post('/chat', async (c) => {
  try {
    const keyRecord = authenticateGatewayKey(c);
    if (!keyRecord) {
      return c.json(err('Unauthorized. A valid OniRoute gateway API key is required.'), 401);
    }
    const body = await c.req.json();
    const result = await routedChat(body, LOCAL_USER_ID, keyRecord);
    return c.json(ok(result));
  } catch (error) {
    return c.json(err(error.message), 400);
  }
});

function createErrorSseResponseStandalone(errorMessage, model = 'oniroute') {
  const id = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: Role assistant
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`,
        ),
      );
      // Chunk 2: Error content
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: `⚠️ OniRoute Gateway: ${errorMessage}` }, finish_reason: null }],
          })}\n\n`,
        ),
      );
      // Chunk 3: Single finish reason stop
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        ),
      );
      // Chunk 4: Standard SSE completion delimiter
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
}

const handleChatCompletionsStandalone = async (c) => {
  const keyRecord = authenticateGatewayKey(c);
  if (!keyRecord) {
    return c.json(
      { error: { message: 'Unauthorized. A valid OniRoute gateway API key (or_...) is required.', type: 'authentication_error' } },
      401,
    );
  }

  let body = {};
  try {
    body = await c.req.json();
    if (body.stream) {
      return await routedChatStream(body, LOCAL_USER_ID, keyRecord);
    }

    const result = await routedChat(body, LOCAL_USER_ID, keyRecord);
    return c.json({
      id: `chatcmpl_${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: result.response }, finish_reason: result.finish_reason },
      ],
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      oniroute: { provider: result.provider_used, mode: result.mode, latency_ms: result.latency_ms },
    });
  } catch (error) {
    if (body.stream) {
      return createErrorSseResponseStandalone(error.message, body.model || 'oniroute');
    }
    return c.json({ error: { message: error.message, type: 'routing_error' } }, 502);
  }
};

app.post('/v1/chat/completions', handleChatCompletionsStandalone);
app.post('/chat/completions', handleChatCompletionsStandalone);
app.post('/v1/v1/chat/completions', handleChatCompletionsStandalone);

// Models endpoint (Standard OpenAI client discovery)
const handleModelsStandalone = (c) => {
  const providers = db.getProviders();
  const list = providers.map((p) => ({
    id: p.model_name || p.name.toLowerCase().replace(/\s+/g, '-'),
    object: 'model',
    created: 1700000000,
    owned_by: 'oniroute',
  }));
  list.unshift({ id: 'oniroute', object: 'model', created: 1700000000, owned_by: 'oniroute' });
  return c.json({
    object: 'list',
    data: list,
  });
};

app.get('/v1/models', handleModelsStandalone);
app.get('/models', handleModelsStandalone);
app.get('/v1/v1/models', handleModelsStandalone);

app.get('/health', (c) => c.json({ status: 'ok', server: 'oniroute-local', port: 1001 }));
app.get('/v1/health', (c) => c.json({ status: 'ok', server: 'oniroute-local', port: 1001 }));
