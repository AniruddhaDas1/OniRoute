import type { ApiProvider, TokenUsage } from './types.ts';
import { joinUrl } from './runtime.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface CompletionOptions {
  maxTokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  response_format?: any;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderResponse {
  content: string;
  tool_calls?: any[];
  model: string;
  finishReason: string;
  usage?: TokenUsage;
}

export interface StreamDelta {
  text?: string;
  toolCalls?: any[];
  role?: string;
  finishReason?: string | null;
  done?: boolean;
}

/** Anthropic requires an explicit ceiling, so a default is unavoidable there. */
const DEFAULT_MAX_TOKENS = 4096;

function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  const h = hostname.toLowerCase();
  return allowedDomains.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) {
    return true;
  }
  // Cloud metadata endpoint
  if (h === '169.254.169.254' || h.startsWith('169.254.')) {
    return true;
  }
  // RFC1918 IPv4 subnets
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  // IPv6 link-local
  if (/^fe80:/i.test(h)) return true;
  return false;
}

/**
 * Validates provider endpoint URLs against strict domain boundaries and prevents
 * SSRF and credential exfiltration.
 */
export function validateProviderUrl(provider: ApiProvider, isCloudMode = true): void {
  const fullUrl = joinUrl(provider.base_url, provider.endpoint);
  let parsed: URL;
  try {
    parsed = new URL(fullUrl);
  } catch {
    throw new Error(`Invalid provider URL: ${fullUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Provider URL cannot contain embedded credentials.');
  }

  const hostname = parsed.hostname.toLowerCase();

  // Cloud Mode SSRF Prevention: Block internal subnets and metadata
  if (isCloudMode && isPrivateOrLoopbackHost(hostname)) {
    throw new Error(`Access to private network or metadata destinations (${hostname}) is forbidden in Cloud mode to prevent SSRF.`);
  }

  switch (provider.provider_type) {
    case 'openai':
      if (!isAllowedDomain(hostname, ['openai.com', 'azure.com', 'openai.azure.com'])) {
        throw new Error(`Invalid OpenAI endpoint domain: "${hostname}". Expected api.openai.com or *.openai.azure.com.`);
      }
      break;

    case 'anthropic':
      if (!isAllowedDomain(hostname, ['anthropic.com'])) {
        throw new Error(`Invalid Anthropic endpoint domain: "${hostname}". Expected api.anthropic.com.`);
      }
      break;

    case 'google':
      if (!isAllowedDomain(hostname, ['googleapis.com'])) {
        throw new Error(`Invalid Google Gemini endpoint domain: "${hostname}". Expected generativelanguage.googleapis.com.`);
      }
      break;

    case 'ollama': {
      const isLoopback = isPrivateOrLoopbackHost(hostname);
      const isOfficialCloud = isAllowedDomain(hostname, ['ollama.com', 'ollama.ai']);
      if (isCloudMode) {
        if (!isOfficialCloud) {
          throw new Error(`In Cloud mode, Ollama endpoints must use official cloud domains (ollama.com). Got: "${hostname}".`);
        }
      } else {
        if (!isLoopback && !isOfficialCloud && parsed.protocol !== 'https:') {
          throw new Error(`Invalid Ollama endpoint host: "${hostname}". Expected localhost, ollama.com, or private network.`);
        }
      }
      break;
    }

    case 'custom':
    default:
      if (!hostname) {
        throw new Error('Custom provider must specify a valid hostname.');
      }
      break;
  }
}

/**
 * Normalise whatever an OpenAI-compatible client sent us into clean message turns.
 * Preserves tool_calls, multimodal content, and roles.
 */
export function normaliseMessages(raw: ReadonlyArray<any>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of raw || []) {
    let content = '';
    if (typeof item.content === 'string') {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part?.type === 'text') return String(part.text ?? '');
          if (part?.type === 'image_url') return `[Image: ${part.image_url?.url || ''}]`;
          return '';
        })
        .join('');
    } else if (item.content !== undefined && item.content !== null) {
      content = String(item.content);
    }

    const rawRole = String(item.role ?? 'user').toLowerCase();
    let role: ChatMessage['role'] = 'user';
    if (rawRole === 'system' || rawRole === 'developer') role = 'system';
    else if (rawRole === 'assistant' || rawRole === 'model') role = 'assistant';
    else if (rawRole === 'tool' || rawRole === 'function') role = 'tool';

    if (!content.trim() && !item.tool_calls && !item.tool_call_id) continue;

    const msg: ChatMessage = { role, content };
    if (item.name) msg.name = String(item.name);
    if (item.tool_call_id) msg.tool_call_id = String(item.tool_call_id);
    if (item.tool_calls) msg.tool_calls = item.tool_calls;

    messages.push(msg);
  }
  return messages;
}

function mergeSameRole(messages: ChatMessage[]): ChatMessage[] {
  return messages.reduce<ChatMessage[]>((merged, message) => {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role && previous.role !== 'tool' && !previous.tool_calls) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
    return merged;
  }, []);
}

function splitSystem(messages: ChatMessage[]): { system: string; turns: ChatMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns = mergeSameRole(messages.filter((m) => m.role !== 'system'));
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return { system, turns };
}

function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function getTurnSize(turn: ChatMessage): number {
  let len = (turn.content || '').length;
  if (turn.tool_calls) {
    len += JSON.stringify(turn.tool_calls).length;
  }
  return len;
}

function truncateString(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 60) / 2);
  return str.slice(0, half) + '\n\n[... content truncated to fit model context window ...]\n\n' + str.slice(str.length - half);
}

export function pruneContextToBudget(
  systemBlocks: string[],
  turns: ChatMessage[],
  maxContextTokens?: number | null,
): ChatMessage[] {
  if (!turns.length) {
    return systemBlocks.map((content) => ({ role: 'system' as const, content }));
  }

  // Safety ceiling: Ollama/vLLM max context is 262,144 chars; set safe 240,000 max
  const hardMaxChars = 240_000;
  const tokenBasedChars = maxContextTokens && maxContextTokens > 0 ? maxContextTokens * 3.5 : hardMaxChars;
  const maxChars = Math.min(tokenBasedChars, hardMaxChars);

  let systemChars = systemBlocks.reduce((sum, s) => sum + s.length, 0);
  let remainingBudget = maxChars - systemChars;

  if (remainingBudget < 4000) {
    systemBlocks = systemBlocks.map((s) => truncateString(s, 20000));
    systemChars = systemBlocks.reduce((sum, s) => sum + s.length, 0);
    remainingBudget = maxChars - systemChars;
  }

  const keptTurns: ChatMessage[] = [];
  const lastTurn: ChatMessage = { ...turns[turns.length - 1] };
  let lastTurnSize = getTurnSize(lastTurn);

  if (lastTurnSize > remainingBudget) {
    if (lastTurn.content) {
      lastTurn.content = truncateString(lastTurn.content, remainingBudget - 1000);
    }
    lastTurnSize = getTurnSize(lastTurn);
  }

  keptTurns.unshift(lastTurn);
  let currentChars = systemChars + lastTurnSize;

  for (let i = turns.length - 2; i >= 0; i--) {
    const turn: ChatMessage = { ...turns[i] };
    const turnLen = getTurnSize(turn);
    if (currentChars + turnLen > maxChars) {
      break;
    }
    keptTurns.unshift(turn);
    currentChars += turnLen;
  }

  // Ensure leading orphaned tool turns are discarded
  while (keptTurns.length && keptTurns[0].role === 'tool') {
    keptTurns.shift();
  }

  return [...systemBlocks.map((content) => ({ role: 'system' as const, content })), ...keptTurns];
}

function formatMessagesForOllama(messages: ChatMessage[]): any[] {
  return messages.map((msg) => {
    if (!msg.tool_calls || !msg.tool_calls.length) {
      return {
        role: msg.role === 'tool' ? 'tool' : msg.role,
        content: msg.content ?? '',
      };
    }

    const ollamaToolCalls = msg.tool_calls.map((tc: any) => {
      let args = tc.function?.arguments || tc.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return {
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function?.name || tc.name || '',
          arguments: args || {},
        },
      };
    });

    return {
      role: msg.role,
      content: msg.content ?? '',
      tool_calls: ollamaToolCalls,
    };
  });
}

function formatTurnsForAnthropic(turns: ChatMessage[]): any[] {
  return turns.map((turn) => {
    if (turn.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: turn.tool_call_id || turn.name || 'call_0',
            content: turn.content ?? '',
          },
        ],
      };
    }
    if (turn.role === 'assistant' && turn.tool_calls?.length) {
      const contentParts: any[] = [];
      if (turn.content) contentParts.push({ type: 'text', text: turn.content });
      for (const tc of turn.tool_calls) {
        let input = tc.function?.arguments || tc.arguments;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = {};
          }
        }
        contentParts.push({
          type: 'tool_use',
          id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
          name: tc.function?.name || tc.name || '',
          input: input || {},
        });
      }
      return { role: 'assistant', content: contentParts };
    }
    return {
      role: turn.role,
      content: turn.content ?? '',
    };
  });
}

export function buildProviderRequest(
  provider: ApiProvider,
  apiKey: string,
  messages: ChatMessage[],
  options: CompletionOptions = {},
): ProviderRequest {
  validateProviderUrl(provider, false);
  const url = joinUrl(provider.base_url, provider.endpoint);
  const stream = Boolean(options.stream);

  switch (provider.provider_type) {
    case 'anthropic': {
      const { system, turns } = splitSystem(messages);
      const anthropicTools = options.tools?.map((t: any) => {
        if (t.type === 'function' && t.function) {
          return {
            name: t.function.name,
            description: t.function.description || undefined,
            input_schema: t.function.parameters || { type: 'object', properties: {} },
          };
        }
        return t;
      });
      const formattedTurns = formatTurnsForAnthropic(turns);
      return {
        url,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(defined({
          model: provider.model_name,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: system || undefined,
          messages: formattedTurns.length ? formattedTurns : [{ role: 'user', content: '' }],
          temperature: options.temperature,
          top_p: options.topP,
          stop_sequences: options.stop,
          stream,
          tools: anthropicTools,
        })),
      };
    }

    case 'google': {
      const { system, turns } = splitSystem(messages);
      let googleUrl = url;
      if (stream && !googleUrl.includes('streamGenerateContent')) {
        googleUrl = googleUrl.replace(':generateContent', ':streamGenerateContent');
        if (!googleUrl.includes(':streamGenerateContent')) {
          googleUrl = `${googleUrl}:streamGenerateContent?alt=sse`;
        } else if (!googleUrl.includes('alt=sse')) {
          googleUrl = `${googleUrl}&alt=sse`;
        }
      }
      const googleTools = options.tools?.length
        ? [{
            functionDeclarations: options.tools.map((t: any) =>
              t.type === 'function' && t.function
                ? { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
                : t,
            ),
          }]
        : undefined;

      return {
        url: googleUrl,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(defined({
          contents: turns.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          tools: googleTools,
          generationConfig: defined({
            maxOutputTokens: options.maxTokens ?? 8192,
            temperature: options.temperature,
            topP: options.topP,
            stopSequences: options.stop,
          }),
        })),
      };
    }

    case 'ollama': {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey && apiKey !== 'ollama') headers.Authorization = `Bearer ${apiKey}`;
      const ollamaMessages = formatMessagesForOllama(messages);

      if (provider.endpoint === '/chat' || provider.endpoint === '/api/chat' || provider.base_url.endsWith('/api')) {
        return {
          url,
          headers,
          body: JSON.stringify(defined({
            model: provider.model_name,
            messages: ollamaMessages,
            stream,
            tools: options.tools,
            options: defined({
              temperature: options.temperature,
              top_p: options.topP,
              num_predict: options.maxTokens ?? 8192,
              stop: options.stop,
            }),
          })),
        };
      }

      return {
        url,
        headers,
        body: JSON.stringify(defined({
          model: provider.model_name,
          messages: ollamaMessages,
          stream,
          max_tokens: options.maxTokens ?? 8192,
          max_completion_tokens: options.max_completion_tokens,
          temperature: options.temperature,
          top_p: options.topP,
          stop: options.stop,
          tools: options.tools,
          tool_choice: options.tool_choice,
          response_format: options.response_format,
        })),
      };
    }

    case 'openai':
    case 'custom':
    default:
      return {
        url,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(defined({
          model: provider.model_name,
          messages,
          stream,
          max_tokens: options.maxTokens,
          max_completion_tokens: options.max_completion_tokens,
          temperature: options.temperature,
          top_p: options.topP,
          stop: options.stop,
          tools: options.tools,
          tool_choice: options.tool_choice,
          response_format: options.response_format,
        })),
      };
  }
}

function usageFrom(prompt: unknown, completion: unknown): TokenUsage | undefined {
  const promptTokens = Number(prompt);
  const completionTokens = Number(completion);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return undefined;
  const safePrompt = Number.isFinite(promptTokens) ? promptTokens : 0;
  const safeCompletion = Number.isFinite(completionTokens) ? completionTokens : 0;
  return { prompt_tokens: safePrompt, completion_tokens: safeCompletion, total_tokens: safePrompt + safeCompletion };
}

export function normalizeToolCalls(rawToolCalls: any[]): any[] {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.map((tc, idx) => ({
    index: typeof tc.index === 'number' ? tc.index : idx,
    id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
    type: 'function',
    function: {
      name: tc.function?.name || tc.name || '',
      arguments: typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
    },
  }));
}

export function parseProviderResponse(provider: ApiProvider, responseBody: any): ProviderResponse {
  switch (provider.provider_type) {
    case 'anthropic': {
      const toolBlocks = (responseBody.content ?? []).filter((block: any) => block?.type === 'tool_use');
      const textBlocks = (responseBody.content ?? []).filter((block: any) => block?.type === 'text');
      const toolCalls = toolBlocks.length
        ? normalizeToolCalls(
            toolBlocks.map((b: any) => ({
              id: b.id,
              name: b.name,
              arguments: b.input,
            })),
          )
        : undefined;

      return {
        content: textBlocks.map((block: any) => block.text ?? '').join(''),
        tool_calls: toolCalls,
        model: responseBody.model || provider.model_name,
        finishReason: toolCalls?.length ? 'tool_calls' : (responseBody.stop_reason === 'max_tokens' ? 'length' : 'stop'),
        usage: usageFrom(responseBody.usage?.input_tokens, responseBody.usage?.output_tokens),
      };
    }

    case 'google': {
      const candidate = responseBody.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const textParts = parts.filter((p: any) => p.text !== undefined);
      const funcParts = parts.filter((p: any) => p.functionCall !== undefined);
      const toolCalls = funcParts.length
        ? normalizeToolCalls(
            funcParts.map((p: any) => ({
              name: p.functionCall.name,
              arguments: p.functionCall.args,
            })),
          )
        : undefined;

      return {
        content: textParts.map((part: any) => part.text ?? '').join(''),
        tool_calls: toolCalls,
        model: responseBody.modelVersion || provider.model_name,
        finishReason: toolCalls?.length ? 'tool_calls' : (candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop'),
        usage: usageFrom(responseBody.usageMetadata?.promptTokenCount, responseBody.usageMetadata?.candidatesTokenCount),
      };
    }

    case 'ollama': {
      if (responseBody.message?.content !== undefined || responseBody.message?.tool_calls !== undefined) {
        const rawToolCalls = responseBody.message?.tool_calls;
        const normalizedTools = rawToolCalls?.length ? normalizeToolCalls(rawToolCalls) : undefined;
        return {
          content: responseBody.message.content ?? '',
          tool_calls: normalizedTools,
          model: responseBody.model || provider.model_name,
          finishReason: normalizedTools?.length ? 'tool_calls' : (responseBody.done_reason || (responseBody.done ? 'stop' : 'length')),
          usage: usageFrom(responseBody.prompt_eval_count, responseBody.eval_count),
        };
      }
      const choice = responseBody.choices?.[0];
      const rawTools = choice?.message?.tool_calls;
      const normalizedTools = rawTools?.length ? normalizeToolCalls(rawTools) : undefined;
      return {
        content: choice?.message?.content ?? '',
        tool_calls: normalizedTools,
        model: responseBody.model || provider.model_name,
        finishReason: normalizedTools?.length ? 'tool_calls' : (choice?.finish_reason || 'stop'),
        usage: usageFrom(responseBody.usage?.prompt_tokens, responseBody.usage?.completion_tokens),
      };
    }

    case 'openai':
    case 'custom':
    default: {
      const choice = responseBody.choices?.[0];
      const rawTools = choice?.message?.tool_calls;
      const normalizedTools = rawTools?.length ? normalizeToolCalls(rawTools) : undefined;
      return {
        content: choice?.message?.content ?? '',
        tool_calls: normalizedTools,
        model: responseBody.model || provider.model_name,
        finishReason: normalizedTools?.length ? 'tool_calls' : (choice?.finish_reason || 'stop'),
        usage: usageFrom(responseBody.usage?.prompt_tokens, responseBody.usage?.completion_tokens),
      };
    }
  }
}

/**
 * Parses streaming events from upstream AI providers line by line in real-time.
 */
export function parseProviderStreamLine(provider: ApiProvider, line: string): StreamDelta | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;

  switch (provider.provider_type) {
    case 'anthropic': {
      if (!trimmed.startsWith('data:')) return null;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) return null;
      try {
        const json = JSON.parse(dataStr);
        if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
          return {
            toolCalls: [
              {
                index: json.index ?? 0,
                id: json.content_block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
                type: 'function',
                function: { name: json.content_block.name, arguments: '' },
              },
            ],
          };
        }
        if (json.type === 'content_block_delta') {
          if (json.delta?.type === 'text_delta') {
            return { text: json.delta?.text ?? '' };
          }
          if (json.delta?.type === 'input_json_delta') {
            return {
              toolCalls: [
                {
                  index: json.index ?? 0,
                  function: { arguments: json.delta.partial_json ?? '' },
                },
              ],
            };
          }
        }
        if (json.type === 'message_delta') {
          return { finishReason: json.delta?.stop_reason === 'tool_use' ? 'tool_calls' : (json.delta?.stop_reason === 'max_tokens' ? 'length' : 'stop') };
        }
        if (json.type === 'message_stop') {
          return { done: true };
        }
        if (json.type === 'error' || json.error) {
          return { text: `\n\n[Anthropic Error: ${json.error?.message || 'Stream error'}]`, finishReason: 'stop', done: true };
        }
      } catch {
        return null;
      }
      return null;
    }

    case 'google': {
      if (!trimmed.startsWith('data:')) return null;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) return null;
      try {
        const json = JSON.parse(dataStr);
        if (json.error) {
          return { text: `\n\n[Google Gemini Error: ${json.error.message || 'Stream error'}]`, finishReason: 'stop', done: true };
        }
        const candidate = json.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        const textParts = parts.filter((p: any) => p.text !== undefined);
        const funcParts = parts.filter((p: any) => p.functionCall !== undefined);
        const text = textParts.map((p: any) => p.text ?? '').join('');
        const toolCalls = funcParts.length
          ? normalizeToolCalls(
              funcParts.map((p: any) => ({
                name: p.functionCall.name,
                arguments: p.functionCall.args,
              })),
            )
          : undefined;

        const finish = candidate?.finishReason
          ? (toolCalls?.length ? 'tool_calls' : (candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop'))
          : null;
        return { text: text || (toolCalls ? undefined : ''), toolCalls, finishReason: finish };
      } catch {
        return null;
      }
    }

    case 'ollama': {
      const dataStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (dataStr === '[DONE]') return { done: true };
      try {
        const json = JSON.parse(dataStr);
        if (json.error) {
          return { text: `\n\n[Ollama Error: ${json.error}]`, finishReason: 'stop', done: true };
        }
        if (json.message?.content !== undefined || json.message?.tool_calls !== undefined) {
          const rawToolCalls = json.message?.tool_calls;
          const normalizedTools = rawToolCalls?.length ? normalizeToolCalls(rawToolCalls) : undefined;
          const finish = json.done ? (normalizedTools?.length ? 'tool_calls' : (json.done_reason || 'stop')) : null;
          return {
            text: json.message.content ?? (normalizedTools ? undefined : ''),
            toolCalls: normalizedTools,
            finishReason: finish,
            done: json.done ?? false,
          };
        }
        const choice = json.choices?.[0];
        if (choice) {
          const rawToolCalls = choice.delta?.tool_calls;
          const normalizedTools = rawToolCalls?.length ? normalizeToolCalls(rawToolCalls) : undefined;
          const finish = choice.finish_reason ?? null;
          return {
            text: choice.delta?.content ?? (normalizedTools ? undefined : ''),
            toolCalls: normalizedTools,
            role: choice.delta?.role,
            finishReason: finish,
            done: Boolean(choice.finish_reason),
          };
        }
      } catch {
        return null;
      }
      return null;
    }

    case 'openai':
    case 'custom':
    default: {
      if (!trimmed.startsWith('data:')) return null;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') return { done: true };
      try {
        const json = JSON.parse(dataStr);
        if (json.error) {
          return { text: `\n\n[Provider Error: ${json.error.message || json.error}]`, finishReason: 'stop', done: true };
        }
        const choice = json.choices?.[0];
        if (choice) {
          const rawToolCalls = choice.delta?.tool_calls;
          const normalizedTools = rawToolCalls?.length ? normalizeToolCalls(rawToolCalls) : undefined;
          const finish = choice.finish_reason ?? null;
          return {
            text: choice.delta?.content ?? (normalizedTools ? undefined : ''),
            toolCalls: normalizedTools,
            role: choice.delta?.role,
            finishReason: finish,
            done: Boolean(choice.finish_reason),
          };
        }
      } catch {
        return null;
      }
      return null;
    }
  }
}
