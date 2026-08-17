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
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderResponse {
  content: string;
  model: string;
  finishReason: string;
  usage?: TokenUsage;
}

export interface StreamDelta {
  text?: string;
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

export function pruneContextToBudget(
  systemBlocks: string[],
  turns: ChatMessage[],
  maxContextTokens?: number | null,
): ChatMessage[] {
  if (!maxContextTokens || maxContextTokens <= 0 || !turns.length) {
    return [...systemBlocks.map((content) => ({ role: 'system' as const, content })), ...turns];
  }

  const CHARS_PER_TOKEN = 3.8;
  const maxChars = maxContextTokens * CHARS_PER_TOKEN;
  let currentChars = systemBlocks.reduce((sum, s) => sum + s.length, 0);

  const keptTurns: ChatMessage[] = [];
  const lastTurn = turns[turns.length - 1];
  keptTurns.unshift(lastTurn);
  currentChars += (lastTurn.content || '').length;

  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i];
    const turnLen = (turn.content || '').length;
    if (currentChars + turnLen > maxChars) {
      break;
    }
    keptTurns.unshift(turn);
    currentChars += turnLen;
  }

  return [...systemBlocks.map((content) => ({ role: 'system' as const, content })), ...keptTurns];
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
      return {
        url,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(defined({
          model: provider.model_name,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: system || undefined,
          messages: turns.length ? turns : [{ role: 'user', content: '' }],
          temperature: options.temperature,
          top_p: options.topP,
          stop_sequences: options.stop,
          stream,
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
      return {
        url: googleUrl,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(defined({
          contents: turns.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          generationConfig: defined({
            maxOutputTokens: options.maxTokens,
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

      if (provider.endpoint === '/chat' || provider.endpoint === '/api/chat' || provider.base_url.endsWith('/api')) {
        return {
          url,
          headers,
          body: JSON.stringify(defined({
            model: provider.model_name,
            messages,
            stream,
            options: defined({
              temperature: options.temperature,
              top_p: options.topP,
              num_predict: options.maxTokens,
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
          messages,
          stream,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
          top_p: options.topP,
          stop: options.stop,
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
          temperature: options.temperature,
          top_p: options.topP,
          stop: options.stop,
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

export function parseProviderResponse(provider: ApiProvider, responseBody: any): ProviderResponse {
  switch (provider.provider_type) {
    case 'anthropic':
      return {
        content: (responseBody.content ?? [])
          .filter((block: { type?: string }) => block?.type === 'text')
          .map((block: { text?: string }) => block.text ?? '')
          .join(''),
        model: responseBody.model || provider.model_name,
        finishReason: responseBody.stop_reason === 'max_tokens' ? 'length' : 'stop',
        usage: usageFrom(responseBody.usage?.input_tokens, responseBody.usage?.output_tokens),
      };

    case 'google': {
      const candidate = responseBody.candidates?.[0];
      return {
        content: (candidate?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? '').join(''),
        model: responseBody.modelVersion || provider.model_name,
        finishReason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
        usage: usageFrom(responseBody.usageMetadata?.promptTokenCount, responseBody.usageMetadata?.candidatesTokenCount),
      };
    }

    case 'ollama': {
      if (responseBody.message?.content !== undefined) {
        return {
          content: responseBody.message.content ?? '',
          model: responseBody.model || provider.model_name,
          finishReason: responseBody.done_reason || (responseBody.done ? 'stop' : 'length'),
          usage: usageFrom(responseBody.prompt_eval_count, responseBody.eval_count),
        };
      }
      const choice = responseBody.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        model: responseBody.model || provider.model_name,
        finishReason: choice?.finish_reason || 'stop',
        usage: usageFrom(responseBody.usage?.prompt_tokens, responseBody.usage?.completion_tokens),
      };
    }

    case 'openai':
    case 'custom':
    default: {
      const choice = responseBody.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        model: responseBody.model || provider.model_name,
        finishReason: choice?.finish_reason || 'stop',
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
        if (json.type === 'content_block_delta') {
          return { text: json.delta?.text ?? '' };
        }
        if (json.type === 'message_delta') {
          return { finishReason: json.delta?.stop_reason === 'max_tokens' ? 'length' : 'stop' };
        }
        if (json.type === 'message_stop') {
          return { done: true };
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
        const candidate = json.candidates?.[0];
        const text = (candidate?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
        const finish = candidate?.finishReason ? (candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop') : null;
        return { text, finishReason: finish };
      } catch {
        return null;
      }
    }

    case 'ollama': {
      const dataStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (dataStr === '[DONE]') return { done: true };
      try {
        const json = JSON.parse(dataStr);
        if (json.message?.content !== undefined) {
          return {
            text: json.message.content ?? '',
            finishReason: json.done ? (json.done_reason || 'stop') : null,
            done: json.done ?? false,
          };
        }
        const choice = json.choices?.[0];
        if (choice) {
          return {
            text: choice.delta?.content ?? '',
            finishReason: choice.finish_reason ?? null,
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
        const choice = json.choices?.[0];
        if (choice) {
          return {
            text: choice.delta?.content ?? '',
            finishReason: choice.finish_reason ?? null,
          };
        }
      } catch {
        return null;
      }
      return null;
    }
  }
}
