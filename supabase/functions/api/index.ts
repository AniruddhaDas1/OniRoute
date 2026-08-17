import { Hono, type Context, type Next } from 'https://deno.land/x/hono@v4.3.0/mod.ts';
import { cors } from 'https://deno.land/x/hono@v4.3.0/middleware.ts';
import { getAuthUser, getServiceClient } from '../_shared/auth.ts';
import type { AuthUser } from '../_shared/auth.ts';
import { ALLOWED_HEADERS, ALLOWED_METHODS, allowedOrigins } from '../_shared/cors.ts';
import { embedText } from '../_shared/embedding.ts';
import { buildProviderRequest, normaliseMessages, parseProviderResponse, pruneContextToBudget, validateProviderUrl } from '../_shared/provider-client.ts';
import type { ChatMessage, CompletionOptions, ProviderResponse } from '../_shared/provider-client.ts';
import { fetchWithTimeout, messageOf, runBackground } from '../_shared/runtime.ts';
import { isFailoverError, isTransientFailure, resolveRouting, shuffle } from '../_shared/routing.ts';
import { isProviderType, type ApiProvider, type LogStatus, type TokenUsage } from '../_shared/types.ts';

type Caller = AuthUser & {
  gatewayKeyId?: string;
  maxContextTokens?: number | null;
  providerGroupId?: string | null;
  routingMode?: 'priority' | 'random' | null;
  gatewayMode?: 'direct' | 'refined' | 'flexible' | null;
  selectedProviderIds?: string[] | null;
  role?: string;
  isActive?: boolean;
  accessGranted?: boolean;
  isSuperAdmin?: boolean;
};
type Env = { Variables: { user: Caller } };

type ChatBody = {
  message?: string;
  messages?: Array<{ role?: unknown; content?: unknown }>;
  mode?: 'direct' | 'refined';
  system_prompt?: string;
  refine_prompt?: string;
  knowledge_base_id?: string;
  embedding_provider_id?: string;
  max_context_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
};

/** Guards against a single request exhausting the isolate's memory. */
const MAX_PROMPT_CHARS = 200_000;
const MAX_KNOWLEDGE_CHARS = 2_000_000;
const INGEST_LEASE_MS = 15 * 60 * 1000;

class RequestError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

const ok = <T>(data: T) => ({ data, error: null });
const err = (error: string) => ({ data: null, error });

const app = new Hono<Env>();
app.use('*', cors({ origin: allowedOrigins(), allowMethods: ALLOWED_METHODS, allowHeaders: ALLOWED_HEADERS }));

async function sha256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function createGatewayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `or_${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function authenticate(request: Request): Promise<Caller | null> {
  const authHeader =
    request.headers.get('Authorization') ??
    request.headers.get('authorization') ??
    '';
  const keyHeader =
    request.headers.get('x-oniroute-key') ??
    request.headers.get('x-api-key') ??
    request.headers.get('api-key') ??
    request.headers.get('X-API-KEY');

  const service = getServiceClient();

  // If Supabase session JWT (starts with eyJ...)
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token.startsWith('eyJ') && !keyHeader) {
    const user = await getAuthUser(authHeader);
    if (!user) return null;

    const { data: profile } = await service
      .from('profiles')
      .select('id, email, role, is_active, access_granted')
      .eq('id', user.id)
      .maybeSingle();

    const isSuperAdmin =
      user.email?.toLowerCase() === 'leadspree24x7@gmail.com' ||
      profile?.role === 'super_admin' ||
      profile?.email?.toLowerCase() === 'leadspree24x7@gmail.com';

    return {
      ...user,
      role: isSuperAdmin ? 'super_admin' : (profile?.role ?? 'member'),
      isActive: profile ? profile.is_active !== false : true,
      accessGranted: profile ? profile.access_granted !== false : true,
      isSuperAdmin,
    };
  }

  // Otherwise treat as Gateway API Key (e.g. or_... or custom)
  const key = (keyHeader ?? token).trim();
  if (!key) return null;

  const keyHash = await sha256(key);
  const { data } = await service
    .from('gateway_api_keys')
    .select('id, user_id, max_context_tokens, provider_group_id, routing_mode, gateway_mode, selected_provider_ids')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (!data) return null;

  const { data: profile } = await service
    .from('profiles')
    .select('id, email, role, is_active, access_granted')
    .eq('id', data.user_id)
    .maybeSingle();

  const isSuperAdmin =
    profile?.role === 'super_admin' ||
    profile?.email?.toLowerCase() === 'leadspree24x7@gmail.com';

  runBackground(
    Promise.resolve(service.from('gateway_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id)),
    'gateway-key-touch',
  );

  return {
    id: data.user_id,
    email: profile?.email ?? '',
    gatewayKeyId: data.id,
    maxContextTokens: data.max_context_tokens,
    providerGroupId: data.provider_group_id,
    routingMode: data.routing_mode,
    gatewayMode: data.gateway_mode,
    selectedProviderIds: data.selected_provider_ids,
    role: isSuperAdmin ? 'super_admin' : (profile?.role ?? 'member'),
    isActive: profile ? profile.is_active !== false : true,
    accessGranted: profile ? profile.access_granted !== false : true,
    isSuperAdmin,
  };
}

app.get('/', (c) => c.json({ status: 'ok', server: 'oniroute', service: 'ai-gateway' }));
app.get('/v1', (c) => c.json({ status: 'ok', server: 'oniroute', service: 'ai-gateway' }));
app.get('/health', (c) => c.json({ status: 'ok', server: 'oniroute' }));
app.get('/v1/health', (c) => c.json({ status: 'ok', server: 'oniroute' }));

app.use('*', async (c, next) => {
  const p = c.req.path.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/v1' || p === '/health' || p === '/v1/health' || p.endsWith('/health') || p.endsWith('/api') || p.endsWith('/api/v1')) {
    return next();
  }

  const user = await authenticate(c.req.raw);
  if (!user) return c.json(err('Unauthorized. Use a Supabase session or an OniRoute API key.'), 401);
  if (user.isActive === false || user.accessGranted === false) {
    return c.json(err('Your account access has been suspended by the administrator (leadspree24x7@gmail.com).'), 403);
  }
  c.set('user', user);
  await next();
});

/**
 * Control-plane guard.
 */
async function sessionOnly(c: Context<Env>, next: Next) {
  if (c.get('user').gatewayKeyId) {
    return c.json(err('Gateway keys may only call /chat and /v1/chat/completions. Use a signed-in dashboard session to manage this account.'), 403);
  }
  await next();
}

/**
 * Super Admin guard.
 */
async function superAdminOnly(c: Context<Env>, next: Next) {
  const user = c.get('user');
  if (!user.isSuperAdmin) {
    return c.json(err('Access denied. Super Admin privileges required.'), 403);
  }
  await next();
}

async function ownedProvider(userId: string, providerId: string | null | undefined): Promise<ApiProvider | null> {
  if (!providerId) return null;
  const service = getServiceClient();
  const { data } = await service.from('ai_providers').select('*').eq('id', providerId).eq('user_id', userId).maybeSingle();
  return data as ApiProvider | null;
}

async function readSecret(providerId: string): Promise<string> {
  const { data, error } = await getServiceClient().rpc('get_provider_secret', { p_provider_id: providerId });
  if (error || !data) throw new Error('Provider secret is unavailable. Update the provider API key.');
  return data as string;
}

async function writeLog(
  userId: string,
  providerId: string | null,
  status: LogStatus,
  latency: number,
  mode: string,
  errorMessage?: string,
  usage?: TokenUsage,
) {
  await getServiceClient().from('request_logs').insert({
    user_id: userId,
    provider_id: providerId,
    status,
    latency_ms: latency,
    mode,
    error_message: errorMessage ?? null,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
  });
}

type ProviderAttempt =
  | { ok: true; latencyMs: number; parsed: ProviderResponse }
  | { ok: false; latencyMs: number; status: number; error: string };

async function sendToProvider(
  provider: ApiProvider,
  messages: ChatMessage[],
  options: CompletionOptions,
  timeoutMs: number,
): Promise<ProviderAttempt> {
  const startedAt = Date.now();
  try {
    // Inside the try so a missing secret degrades to a failover-eligible
    // attempt instead of aborting the whole request.
    const apiKey = await readSecret(provider.id);
    const request = buildProviderRequest(provider, apiKey, messages, options);
    const response = await fetchWithTimeout(
      request.url,
      { method: 'POST', headers: request.headers, body: request.body },
      timeoutMs,
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { ok: false, latencyMs, status: response.status, error: (await response.text()).slice(0, 600) };
    const parsed = parseProviderResponse(provider, await response.json());
    if (!parsed.content) return { ok: false, latencyMs, status: 502, error: 'Provider returned an empty response.' };
    return { ok: true, latencyMs, parsed };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, status: 503, error: messageOf(error) };
  }
}

/**
 * Turn a request body into a conversation, preserving roles.
 *
 * The previous implementation joined every message's content with newlines and
 * dropped the roles, so an assistant turn was indistinguishable from a user
 * turn and a client's `system` message vanished entirely.
 */
function readConversation(body: ChatBody): { systemBlocks: string[]; turns: ChatMessage[] } {
  const systemBlocks: string[] = [];
  if (body.system_prompt?.trim()) systemBlocks.push(body.system_prompt.trim());

  let turns: ChatMessage[] = [];
  if (Array.isArray(body.messages) && body.messages.length) {
    const normalised = normaliseMessages(body.messages);
    for (const message of normalised) {
      if (message.role === 'system') systemBlocks.push(message.content);
      else turns.push(message);
    }
  } else if (body.message?.trim()) {
    turns = [{ role: 'user', content: body.message.trim() }];
  }

  if (!turns.length) throw new RequestError('A message or messages array is required.', 400);

  const totalChars = [...systemBlocks, ...turns.map((turn) => turn.content)].reduce((sum, text) => sum + text.length, 0);
  if (totalChars > MAX_PROMPT_CHARS) {
    throw new RequestError(`The conversation is ${totalChars} characters; the limit is ${MAX_PROMPT_CHARS}.`, 413);
  }
  return { systemBlocks, turns };
}

function readOptions(body: ChatBody): CompletionOptions {
  const numeric = (value: unknown, min: number, max: number): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : undefined;
  };
  const stop = Array.isArray(body.stop) ? body.stop.filter((item): item is string => typeof item === 'string')
    : typeof body.stop === 'string' ? [body.stop]
    : undefined;
  return {
    maxTokens: body.max_tokens === undefined ? undefined : numeric(body.max_tokens, 1, 200_000),
    temperature: body.temperature === undefined ? undefined : numeric(body.temperature, 0, 2),
    topP: body.top_p === undefined ? undefined : numeric(body.top_p, 0, 1),
    stop: stop?.length ? stop.slice(0, 4) : undefined,
  };
}

/**
 * Refine the user's last message using the first available provider.
 *
 * The refine_prompt is a system instruction that tells the provider how to
 * transform the user's message (e.g. "Rewrite this as a precise technical
 * query", "Expand this into a detailed request"). The provider's output
 * replaces the original user message before the main routing call.
 */
async function refineUserMessage(
  providers: ApiProvider[],
  userMessage: string,
  refinePrompt: string,
  timeoutMs: number,
): Promise<string> {
  for (const provider of providers) {
    const apiKey = await readSecret(provider.id);
    const request = buildProviderRequest(provider, apiKey, [
      { role: 'system', content: refinePrompt },
      { role: 'user', content: userMessage },
    ], { maxTokens: 512, temperature: 0.3 });
    const response = await fetchWithTimeout(request.url, { method: 'POST', headers: request.headers, body: request.body }, timeoutMs);
    if (!response.ok) continue;
    const parsed = parseProviderResponse(provider, await response.json());
    if (parsed.content.trim()) return parsed.content.trim();
  }
  return userMessage;
}

async function routedChat(user: Caller, body: ChatBody) {

  const mode = (user.gatewayMode && user.gatewayMode !== 'flexible')
    ? (user.gatewayMode as 'direct' | 'refined')
    : (body.mode === 'refined' ? 'refined' : 'direct');
  const { systemBlocks, turns } = readConversation(body);
  const options = readOptions(body);
  const client = getServiceClient();

  const { data: configRow } = await client.from('routing_configs').select('*').eq('user_id', user.id).maybeSingle();
  const config = resolveRouting(configRow);

  // Check if caller's key specifies a Provider Group or Selected Providers
  let candidateProviderIds: string[] | null = null;
  let keyOrGroupRoutingMode: 'priority' | 'random' | null = user.routingMode ?? null;

  if (user.providerGroupId) {
    const { data: group } = await client
      .from('provider_groups')
      .select('id, name, routing_mode, provider_ids')
      .eq('id', user.providerGroupId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (group) {
      candidateProviderIds = group.provider_ids || [];
      if (!keyOrGroupRoutingMode) {
        keyOrGroupRoutingMode = group.routing_mode;
      }
    }
  } else if (Array.isArray(user.selectedProviderIds) && user.selectedProviderIds.length) {
    candidateProviderIds = user.selectedProviderIds;
  }

  const { data: allProviders } = await client
    .from('ai_providers')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .order('priority');

  let providers = (allProviders ?? []) as ApiProvider[];

  if (candidateProviderIds && candidateProviderIds.length) {
    const idToProvider = new Map(providers.map((p) => [p.id, p]));
    providers = candidateProviderIds
      .map((id) => idToProvider.get(id))
      .filter((p): p is ApiProvider => Boolean(p && p.is_active));
  }

  const effectiveRoutingMode = keyOrGroupRoutingMode || config.mode || 'priority';
  if (effectiveRoutingMode === 'random') providers = shuffle(providers);
  providers = providers.filter((provider) => !isCircuitOpen(provider.id));

  if (!providers.length) {
    throw new RequestError(
      user.providerGroupId
        ? 'No active providers available in the assigned Provider Group.'
        : 'No active provider is available. Add a provider or wait for the circuit breaker to recover.',
      503,
    );
  }

  // Refine the user's last message if a refine_prompt is set.
  const refinePrompt = body.refine_prompt?.trim() ?? config.refine_prompt?.trim();
  if (refinePrompt && turns.some((turn) => turn.role === 'user')) {
    const lastUserIndex = turns.map((turn) => turn.role).lastIndexOf('user');
    const originalMessage = turns[lastUserIndex].content;
    const refined = await refineUserMessage(providers, originalMessage, refinePrompt, config.timeout_ms);
    turns[lastUserIndex] = { role: 'user', content: refined };
  }

  let contextUsed: string[] = [];
  if (mode === 'refined') {
    let embeddingProviderId = body.embedding_provider_id;
    if (!embeddingProviderId && body.knowledge_base_id) {
      const { data: base } = await client
        .from('knowledge_bases').select('embedding_provider_id')
        .eq('id', body.knowledge_base_id).eq('user_id', user.id).maybeSingle();
      embeddingProviderId = base?.embedding_provider_id ?? undefined;
    }
    if (!embeddingProviderId) throw new RequestError('Refined mode requires an embedding provider and a knowledge base.', 400);
    const embeddingProvider = await ownedProvider(user.id, embeddingProviderId);
    if (!embeddingProvider) throw new RequestError('Embedding provider was not found.', 404);

    // Retrieve against the latest user turn rather than the whole transcript:
    // more accurate, and it keeps earlier turns from diluting the query vector.
    const query = turns.filter((turn) => turn.role === 'user').at(-1)?.content ?? '';
    const embedding = await embedText(embeddingProvider, await readSecret(embeddingProvider.id), query);
    const { data: matches, error } = await client.rpc('match_oniroute_chunks', {
      p_user_id: user.id,
      p_embedding: embedding,
      p_match_count: 6,
      p_knowledge_base_id: body.knowledge_base_id ?? null,
    });
    if (error) throw new RequestError(`Knowledge search failed: ${error.message}`);
    contextUsed = ((matches ?? []) as Array<{ content: string }>).map((match) => match.content);
    if (!contextUsed.length) {
      throw new RequestError('No embedded knowledge was found. Ingest a knowledge source before using refined mode.', 409);
    }
    systemBlocks.push(
      'Answer using the supplied knowledge when relevant. If the knowledge does not contain the answer, say so clearly.' +
        `\n\nKnowledge:\n${contextUsed.join('\n\n---\n\n')}`,
    );
  }

  const effectiveMaxTokens = body.max_context_tokens || user.maxContextTokens;
  const messages: ChatMessage[] = pruneContextToBudget(systemBlocks, turns, effectiveMaxTokens);

  const maxAttempts = Math.min(providers.length, Math.max(1, config.max_retries + 1));
  const failures: string[] = [];
  for (const provider of providers.slice(0, maxAttempts)) {
    const result = await sendToProvider(provider, messages, options, config.timeout_ms);
    if (result.ok) {
      recordSuccess(provider.id);
      await writeLog(user.id, provider.id, 'success', result.latencyMs, mode, undefined, result.parsed.usage);
      return {
        response: result.parsed.content,
        provider_used: provider.name,
        provider_id: provider.id,
        model: result.parsed.model,
        finish_reason: result.parsed.finishReason,
        usage: result.parsed.usage,
        latency_ms: result.latencyMs,
        mode,
        context_used: mode === 'refined' ? contextUsed : undefined,
      };
    }

    // Only transient conditions count against provider health. A 400 from a
    // mistyped model name is configuration, and tripping the breaker on it used
    // to lock a healthy provider out for five minutes.
    if (isTransientFailure(result.status)) recordFailure(provider.id);
    failures.push(`${provider.name}: ${result.error}`);
    await writeLog(
      user.id,
      provider.id,
      isFailoverError(result.status) ? 'failover' : 'error',
      result.latencyMs,
      mode,
      result.error,
    );
    if (!config.failover_enabled || !isFailoverError(result.status)) break;
  }
  throw new RequestError(`All selected providers failed. ${failures.join(' | ')}`);
}

// =============================================================================
// Providers
// =============================================================================

app.get('/providers', sessionOnly, async (c) => {
  const user = c.get('user');
  const { data, error } = await getServiceClient().from('ai_providers').select('*').eq('user_id', user.id).order('priority');
  return error ? c.json(err(error.message), 500) : c.json(ok(data));
});

app.post('/providers', sessionOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const required = ['name', 'provider_type', 'endpoint', 'base_url', 'model_name', 'api_key'];
  if (required.some((field) => !body[field]?.trim?.())) return c.json(err(`Missing required fields: ${required.join(', ')}`), 400);
  if (!isProviderType(body.provider_type)) return c.json(err('Unsupported provider type.'), 400);

  try {
    validateProviderUrl({
      id: '',
      user_id: user.id,
      name: body.name.trim(),
      provider_type: body.provider_type,
      endpoint: body.endpoint.trim(),
      base_url: body.base_url.trim(),
      model_name: body.model_name.trim(),
      priority: 0,
      is_active: true,
      created_at: '',
    });
  } catch (urlErr: any) {
    return c.json(err(urlErr.message), 400);
  }

  const service = getServiceClient();
  const { data: highest } = await service
    .from('ai_providers').select('priority').eq('user_id', user.id).order('priority', { ascending: false }).limit(1);
  const { data: provider, error } = await service.from('ai_providers').insert({
    user_id: user.id,
    name: body.name.trim(),
    provider_type: body.provider_type,
    endpoint: body.endpoint.trim(),
    base_url: body.base_url.trim(),
    model_name: body.model_name.trim(),
    embedding_model_name: body.embedding_model_name?.trim() || null,
    priority: highest?.[0] ? highest[0].priority + 1 : 0,
  }).select().single();
  if (error || !provider) return c.json(err(error?.message ?? 'Could not create provider.'), 500);
  const { error: secretError } = await service.rpc('upsert_provider_secret', { p_provider_id: provider.id, p_secret: body.api_key.trim() });
  if (secretError) {
    await service.from('ai_providers').delete().eq('id', provider.id);
    return c.json(err(secretError.message), 500);
  }
  return c.json(ok(provider), 201);
});

app.put('/providers/reorder', sessionOnly, async (c) => {
  const user = c.get('user');
  const { provider_ids } = await c.req.json();
  if (!Array.isArray(provider_ids) || !provider_ids.length) return c.json(err('provider_ids must be a non-empty array.'), 400);
  const service = getServiceClient();
  const { data: owned } = await service.from('ai_providers').select('id').eq('user_id', user.id).in('id', provider_ids);
  if ((owned ?? []).length !== provider_ids.length) return c.json(err('One or more providers are not owned by you.'), 403);
  const results = await Promise.all(
    provider_ids.map((id: string, priority: number) => service.from('ai_providers').update({ priority }).eq('id', id).eq('user_id', user.id)),
  );
  const failed = results.find((result) => result.error);
  return failed?.error ? c.json(err(failed.error.message), 500) : c.json(ok({ reordered: provider_ids }));
});

app.put('/providers/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const service = getServiceClient();

  if (body.provider_type !== undefined && !isProviderType(body.provider_type)) {
    return c.json(err('Unsupported provider type.'), 400);
  }
  const allowed = ['name', 'provider_type', 'endpoint', 'base_url', 'model_name', 'embedding_model_name', 'is_active'];
  const updates = Object.fromEntries(allowed.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
  if (!Object.keys(updates).length && !body.api_key) return c.json(err('No editable provider fields were supplied.'), 400);

  const { data: existing, error: fetchError } = await service.from('ai_providers').select('*').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (fetchError || !existing) return c.json(err('Provider not found.'), 404);

  try {
    validateProviderUrl({ ...existing, ...updates });
  } catch (urlErr: any) {
    return c.json(err(urlErr.message), 400);
  }

  const { data, error } = Object.keys(updates).length
    ? await service.from('ai_providers').update(updates).eq('id', id).eq('user_id', user.id).select().maybeSingle()
    : { data: existing, error: null };
  if (error || !data) return c.json(err('Provider not found.'), 404);
  if (body.api_key?.trim()) {
    const { error: secretError } = await service.rpc('upsert_provider_secret', { p_provider_id: id, p_secret: body.api_key.trim() });
    if (secretError) return c.json(err(secretError.message), 500);
  }
  return c.json(ok(data));
});

app.delete('/providers/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const service = getServiceClient();
  const provider = await ownedProvider(user.id, id);
  if (!provider) return c.json(err('Provider not found.'), 404);
  await service.rpc('delete_provider_secret', { p_provider_id: id });
  const { error } = await service.from('ai_providers').delete().eq('id', id).eq('user_id', user.id);
  return error ? c.json(err(error.message), 500) : c.json(ok({ deleted: true }));
});

app.get('/providers/:id/secret', sessionOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const provider = await ownedProvider(user.id, id);
  if (!provider) return c.json(err('Provider not found.'), 404);
  const { data: secret } = await getServiceClient().rpc('get_provider_secret', { p_provider_id: id });
  return c.json(ok({ api_key: secret || '', exists: Boolean(secret) }));
});

app.post('/test-provider/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const provider = await ownedProvider(user.id, c.req.param('id'));
  if (!provider) return c.json(err('Provider not found.'), 404);
  const result = await sendToProvider(
    provider,
    [{ role: 'user', content: 'Reply with exactly: OniRoute connection successful.' }],
    { maxTokens: 64 },
    10_000,
  );
  return c.json(ok(result.ok
    ? { success: true, latency_ms: result.latencyMs, response: result.parsed.content }
    : { success: false, latency_ms: result.latencyMs, error: result.error }));
});

// =============================================================================
// Routing configuration
// =============================================================================

app.get('/routing-config', sessionOnly, async (c) => {
  const user = c.get('user');
  const service = getServiceClient();
  const { data, error } = await service
    .from('routing_configs')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return c.json(err(error.message), 500);
  return c.json(ok(data ?? { user_id: user.id, ...resolveRouting(null) }));
});

app.put('/routing-config', sessionOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const allowed = ['mode', 'failover_enabled', 'max_retries', 'timeout_ms', 'refine_prompt'];
  const updates = Object.fromEntries(allowed.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
  if (!Object.keys(updates).length || (updates.mode && !['priority', 'random'].includes(String(updates.mode)))) {
    return c.json(err('Invalid routing configuration.'), 400);
  }
  const { data, error } = await getServiceClient()
    .from('routing_configs').upsert({ user_id: user.id, ...updates }, { onConflict: 'user_id' }).select().single();
  return error ? c.json(err(error.message), 500) : c.json(ok(data));
});

// =============================================================================
// Knowledge bases
// =============================================================================

app.get('/knowledge', sessionOnly, async (c) => {
  const user = c.get('user');
  const { data, error } = await getServiceClient()
    .from('knowledge_bases').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return error ? c.json(err(error.message), 500) : c.json(ok(data));
});

app.post('/knowledge', sessionOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  if (!body.name?.trim() || !['text', 'repo'].includes(body.source_type)) {
    return c.json(err('Name and a source type of text or repo are required.'), 400);
  }
  if (body.source_type === 'text' && !body.content?.trim()) return c.json(err('Text knowledge needs content.'), 400);
  if (body.source_type === 'repo' && !body.source_url?.trim()) return c.json(err('Repository knowledge needs a GitHub URL.'), 400);
  if (typeof body.content === 'string' && body.content.length > MAX_KNOWLEDGE_CHARS) {
    return c.json(err(`Knowledge text is limited to ${MAX_KNOWLEDGE_CHARS} characters.`), 413);
  }
  // This wrote the caller's `embedding_provider_id` straight through a
  // service-role client with no ownership check.
  if (body.embedding_provider_id && !(await ownedProvider(user.id, body.embedding_provider_id))) {
    return c.json(err('Embedding provider was not found.'), 400);
  }
  const { data, error } = await getServiceClient().from('knowledge_bases').insert({
    user_id: user.id,
    name: body.name.trim(),
    source_type: body.source_type,
    source_url: body.source_url?.trim() || null,
    source_content: body.content?.trim() || null,
    embedding_provider_id: body.embedding_provider_id || null,
    status: 'pending',
  }).select().single();
  return error ? c.json(err(error.message), 500) : c.json(ok(data), 201);
});

/** Ask the worker function to pick up a queued job. */
async function triggerIngestWorker(knowledgeBaseId: string): Promise<void> {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${baseUrl}/functions/v1/embed-knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ knowledge_base_id: knowledgeBaseId }),
  });
  if (!response.ok) {
    // Surface a failed hand-off instead of leaving the row queued forever.
    const detail = (await response.text()).slice(0, 300);
    await getServiceClient().from('knowledge_bases').update({
      status: 'error',
      error_message: `Could not start the ingestion worker (${response.status}). ${detail}`,
    }).eq('id', knowledgeBaseId);
  }
}

app.post('/knowledge/:id/ingest', sessionOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const service = getServiceClient();
  const id = c.req.param('id');

  const { data: base } = await service.from('knowledge_bases').select('*').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!base) return c.json(err('Knowledge base not found.'), 404);

  const provider = await ownedProvider(user.id, body.embedding_provider_id || base.embedding_provider_id);
  if (!provider) return c.json(err('Select an embedding provider before ingesting.'), 400);

  const leaseAge = base.ingest_started_at ? Date.now() - new Date(base.ingest_started_at).getTime() : Infinity;
  if ((base.status === 'processing' || base.status === 'queued') && leaseAge < INGEST_LEASE_MS) {
    return c.json(err('This knowledge base is already being ingested.'), 409);
  }

  const { data, error } = await service.from('knowledge_bases').update({
    status: 'queued',
    error_message: null,
    embedding_provider_id: provider.id,
    ingest_completed_at: null,
  }).eq('id', id).eq('user_id', user.id).select().single();
  if (error) return c.json(err(error.message), 500);

  // Ingestion runs in the worker function. This request returns immediately;
  // the dashboard polls `GET /knowledge` for progress.
  runBackground(triggerIngestWorker(id), `ingest:${id}`);
  return c.json(ok(data), 202);
});

app.delete('/knowledge/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const { error } = await getServiceClient().from('knowledge_bases').delete().eq('id', c.req.param('id')).eq('user_id', user.id);
  return error ? c.json(err(error.message), 500) : c.json(ok({ deleted: true }));
});

// =============================================================================
// Logs
// =============================================================================

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(log: { created_at: string; id: string }): string {
  return btoa(`${log.created_at}|${log.id}`);
}

function decodeCursor(raw: string): { created_at: string; id: string } | null {
  try {
    const [created_at, id] = atob(raw).split('|');
    if (!ISO_TIMESTAMP.test(created_at ?? '') || !UUID.test(id ?? '')) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}

app.get('/logs', sessionOnly, async (c) => {
  const user = c.get('user');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  let query = getServiceClient()
    .from('request_logs').select('*').eq('user_id', user.id)
    // `created_at` alone is not unique, so a timestamp-only cursor could skip or
    // repeat rows at a page boundary. Tie-break on the primary key.
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(limit);

  const rawCursor = c.req.query('cursor');
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) return c.json(err('Invalid pagination cursor.'), 400);
    query = query.or(`created_at.lt."${cursor.created_at}",and(created_at.eq."${cursor.created_at}",id.lt."${cursor.id}")`);
  }
  const status = c.req.query('status');
  if (status) {
    if (!['success', 'error', 'failover'].includes(status)) return c.json(err('Invalid status filter.'), 400);
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) return c.json(err(error.message), 500);
  const logs = (data ?? []) as Array<{ created_at: string; id: string }>;
  return c.json(ok({
    logs,
    next_cursor: logs.length === limit && logs.at(-1) ? encodeCursor(logs[logs.length - 1]) : null,
  }));
});

// =============================================================================
// Provider Groups (AI Provider Groups & Routing Profiles)
// =============================================================================

app.get('/provider-groups', sessionOnly, async (c) => {
  const user = c.get('user');
  const { data, error } = await getServiceClient()
    .from('provider_groups')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return error ? c.json(err(error.message), 500) : c.json(ok(data ?? []));
});

app.post('/provider-groups', sessionOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const service = getServiceClient();

  if (Array.isArray(body.provider_ids) && body.provider_ids.length > 0) {
    const { data: owned } = await service
      .from('ai_providers')
      .select('id')
      .eq('user_id', user.id)
      .in('id', body.provider_ids);
    const ownedIds = new Set((owned ?? []).map((p) => p.id));
    const invalid = body.provider_ids.filter((pId: string) => !ownedIds.has(pId));
    if (invalid.length > 0) {
      return c.json(err(`Invalid provider IDs not owned by you: ${invalid.join(', ')}`), 400);
    }
  }

  const { data, error } = await service
    .from('provider_groups')
    .insert({
      user_id: user.id,
      name: body.name?.trim() || 'Custom Group',
      description: body.description?.trim() || null,
      routing_mode: body.routing_mode === 'random' ? 'random' : 'priority',
      provider_ids: Array.isArray(body.provider_ids) ? body.provider_ids : [],
    })
    .select()
    .single();
  return error ? c.json(err(error.message), 500) : c.json(ok(data), 201);
});

app.put('/provider-groups/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const service = getServiceClient();

  if (Array.isArray(body.provider_ids) && body.provider_ids.length > 0) {
    const { data: owned } = await service
      .from('ai_providers')
      .select('id')
      .eq('user_id', user.id)
      .in('id', body.provider_ids);
    const ownedIds = new Set((owned ?? []).map((p) => p.id));
    const invalid = body.provider_ids.filter((pId: string) => !ownedIds.has(pId));
    if (invalid.length > 0) {
      return c.json(err(`Invalid provider IDs not owned by you: ${invalid.join(', ')}`), 400);
    }
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.name) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.routing_mode) updates.routing_mode = body.routing_mode;
  if (Array.isArray(body.provider_ids)) updates.provider_ids = body.provider_ids;

  const { data, error } = await service
    .from('provider_groups')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? c.json(err(error.message), 500) : c.json(ok(data));
});

app.delete('/provider-groups/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const { error } = await getServiceClient()
    .from('provider_groups')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  return error ? c.json(err(error.message), 500) : c.json(ok({ deleted: true }));
});

// =============================================================================
// Gateway keys
// =============================================================================

app.get('/gateway-keys', sessionOnly, async (c) => {
  const user = c.get('user');
  const { data, error } = await getServiceClient()
    .from('gateway_api_keys')
    .select('id, name, key_prefix, provider_group_id, routing_mode, gateway_mode, selected_provider_ids, max_context_tokens, created_at, last_used_at, revoked_at, provider_groups(name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return c.json(err(error.message), 500);
  const formatted = (data ?? []).map((k: any) => ({
    ...k,
    provider_group_name: k.provider_groups?.name || null,
  }));
  return c.json(ok(formatted));
});

app.post('/gateway-keys', sessionOnly, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const key = createGatewayKey();
  const { data, error } = await getServiceClient().from('gateway_api_keys').insert({
    user_id: user.id,
    name: body.name?.trim() || 'Default key',
    key_prefix: `${key.slice(0, 11)}…`,
    key_hash: await sha256(key),
    provider_group_id: body.provider_group_id || null,
    routing_mode: body.routing_mode || null,
    gateway_mode: body.gateway_mode || 'flexible',
    selected_provider_ids: Array.isArray(body.selected_provider_ids) ? body.selected_provider_ids : null,
    max_context_tokens: body.max_context_tokens ? Number(body.max_context_tokens) : null,
  }).select('id, name, key_prefix, provider_group_id, routing_mode, gateway_mode, selected_provider_ids, max_context_tokens, created_at').single();
  return error ? c.json(err(error.message), 500) : c.json(ok({ ...data, key }), 201);
});

app.delete('/gateway-keys/:id', sessionOnly, async (c) => {
  const user = c.get('user');
  const { error } = await getServiceClient()
    .from('gateway_api_keys').update({ revoked_at: new Date().toISOString() })
    .eq('id', c.req.param('id')).eq('user_id', user.id);
  return error ? c.json(err(error.message), 500) : c.json(ok({ revoked: true }));
});

// =============================================================================
// Super Admin & Team Management (leadspree24x7@gmail.com)
// =============================================================================

app.get('/admin/members', sessionOnly, superAdminOnly, async (c) => {
  const service = getServiceClient();
  const { data: profiles, error } = await service
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return c.json(err(error.message), 500);

  const members = await Promise.all(
    (profiles ?? []).map(async (p: any) => {
      const isSuper = p.role === 'super_admin' || p.email?.toLowerCase() === 'leadspree24x7@gmail.com';
      const [
        { count: providersCount },
        { count: keysCount },
        { count: knowledgeCount },
        { count: requestsCount },
      ] = await Promise.all([
        service.from('ai_providers').select('*', { count: 'exact', head: true }).eq('user_id', p.id),
        service.from('gateway_api_keys').select('*', { count: 'exact', head: true }).eq('user_id', p.id).is('revoked_at', null),
        service.from('knowledge_bases').select('*', { count: 'exact', head: true }).eq('user_id', p.id),
        service.from('request_logs').select('*', { count: 'exact', head: true }).eq('user_id', p.id),
      ]);

      return {
        ...p,
        role: isSuper ? 'super_admin' : (p.role ?? 'member'),
        providers_count: providersCount ?? 0,
        keys_count: keysCount ?? 0,
        knowledge_count: knowledgeCount ?? 0,
        total_requests: requestsCount ?? 0,
      };
    }),
  );

  return c.json(ok(members));
});

app.patch('/admin/members/:id', sessionOnly, superAdminOnly, async (c) => {
  const targetId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const service = getServiceClient();

  const { data: targetProfile } = await service
    .from('profiles')
    .select('*')
    .eq('id', targetId)
    .maybeSingle();

  if (!targetProfile) return c.json(err('Member not found.'), 404);

  if (targetProfile.email?.toLowerCase() === 'leadspree24x7@gmail.com') {
    if (body.role && body.role !== 'super_admin') {
      return c.json(err('Cannot demote root Super Admin.'), 400);
    }
    if (body.is_active === false || body.access_granted === false) {
      return c.json(err('Cannot suspend root Super Admin.'), 400);
    }
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.role !== undefined) updates.role = body.role;
  if (body.is_active !== undefined) updates.is_active = Boolean(body.is_active);
  if (body.access_granted !== undefined) updates.access_granted = Boolean(body.access_granted);

  const { data, error } = await service
    .from('profiles')
    .update(updates)
    .eq('id', targetId)
    .select()
    .single();

  return error ? c.json(err(error.message), 500) : c.json(ok(data));
});

app.delete('/admin/members/:id', sessionOnly, superAdminOnly, async (c) => {
  const targetId = c.req.param('id');
  const service = getServiceClient();

  const { data: targetProfile } = await service
    .from('profiles')
    .select('*')
    .eq('id', targetId)
    .maybeSingle();

  if (!targetProfile) return c.json(err('Member not found.'), 404);
  if (targetProfile.email?.toLowerCase() === 'leadspree24x7@gmail.com') {
    return c.json(err('Cannot delete root Super Admin account.'), 400);
  }

  const { error } = await service.from('profiles').delete().eq('id', targetId);
  return error ? c.json(err(error.message), 500) : c.json(ok({ deleted: true }));
});

// =============================================================================
// Inference — the only routes a gateway key may call
// =============================================================================

app.post('/chat', async (c) => {
  try {
    return c.json(ok(await routedChat(c.get('user'), await c.req.json())));
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 422;
    return c.json(err(messageOf(error)), status as 400);
  }
});

app.post('/v1/chat/completions', async (c) => {
  try {
    const result = await routedChat(c.get('user'), await c.req.json());
    return c.json({
      id: `chatcmpl_${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.response }, finish_reason: result.finish_reason }],
      // OpenAI clients read `usage` for cost accounting; it was being dropped.
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      oniroute: { provider: result.provider_used, mode: result.mode, latency_ms: result.latency_ms },
    });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 502;
    return c.json({ error: { message: messageOf(error), type: 'routing_error' } }, status as 400);
  }
});

// Standard OpenAI Models Discovery (for Hermes Agent, Cursor, LangChain)
const handleModels = async (c: Context<Env>) => {
  const user = c.get('user');
  const service = getServiceClient();
  const { data: providers } = await service
    .from('ai_providers')
    .select('id, name, model_name, provider_type')
    .eq('user_id', user.id)
    .eq('is_active', true);

  const modelList = (providers ?? []).map((p) => ({
    id: p.model_name || p.name.toLowerCase().replace(/\s+/g, '-'),
    object: 'model',
    created: 1700000000,
    owned_by: 'oniroute',
  }));

  // Include default gateway model alias
  if (!modelList.some((m) => m.id === 'oniroute')) {
    modelList.unshift({
      id: 'oniroute',
      object: 'model',
      created: 1700000000,
      owned_by: 'oniroute',
    });
  }

  return c.json({
    object: 'list',
    data: modelList,
  });
};

app.get('/v1/models', handleModels);
app.get('/models', handleModels);
app.get('/v1/v1/models', handleModels);

const handleChatCompletions = async (c: Context<Env>) => {
  const body = await c.req.json().catch(() => ({}));
  const user = c.get('user');

  try {
    const result = await routedChat(user, { ...body, stream: false });

    if (body.stream) {
      const stream = new ReadableStream({
        start(controller) {
          const id = `chatcmpl_${crypto.randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);
          const model = result.model || 'oniroute';
          const content = result.response || '';

          // Initial assistant role chunk
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
              })}\n\n`
            )
          );

          // Stream content chunks (word by word for smooth UI typing)
          const words = content.split(' ');
          for (let i = 0; i < words.length; i++) {
            const chunk = (i === 0 ? '' : ' ') + words[i];
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
                })}\n\n`
              )
            );
          }

          // Final finish chunk
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              })}\n\n`
            )
          );
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
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

    return c.json({
      id: `chatcmpl_${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.response }, finish_reason: result.finish_reason }],
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      oniroute: { provider: result.provider_used, mode: result.mode, latency_ms: result.latency_ms },
    });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 502;
    return c.json({ error: { message: messageOf(error), type: 'routing_error' } }, status as 400);
  }
};

app.post('/v1/chat/completions', handleChatCompletions);
app.post('/chat/completions', handleChatCompletions);
app.post('/v1/v1/chat/completions', handleChatCompletions);

const root = new Hono<Env>();
root.use('*', cors({ origin: allowedOrigins(), allowMethods: ALLOWED_METHODS, allowHeaders: ALLOWED_HEADERS }));
root.route('/functions/v1/api', app);
root.route('/api', app);
root.route('/', app);

Deno.serve(root.fetch);
