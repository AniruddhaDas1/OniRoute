import type { ApiProvider, TokenUsage } from './types.ts';
import { joinUrl } from './runtime.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
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

/** Anthropic requires an explicit ceiling, so a default is unavoidable there. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Normalise whatever an OpenAI-compatible client sent us into the three roles
 * every upstream understands. Unknown roles (`tool`, `function`) are folded
 * into `user` rather than dropped, so their content still reaches the model.
 */
export function normaliseMessages(raw: ReadonlyArray<{ role?: unknown; content?: unknown }>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    const content = typeof item.content === 'string'
      ? item.content
      // Content parts: [{type:'text',text:'…'}, …]
      : Array.isArray(item.content)
      ? item.content.map((part) => (typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? ''))).join('')
      : '';
    if (!content.trim()) continue;
    const role = String(item.role ?? 'user').toLowerCase();
    messages.push({
      role: role === 'system' || role === 'developer' ? 'system' : role === 'assistant' || role === 'model' ? 'assistant' : 'user',
      content,
    });
  }
  return messages;
}

/** Collapse runs of the same role, which Anthropic and Google both reject. */
function mergeSameRole(messages: ChatMessage[]): ChatMessage[] {
  return messages.reduce<ChatMessage[]>((merged, message) => {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) previous.content = `${previous.content}\n\n${message.content}`;
    else merged.push({ ...message });
    return merged;
  }, []);
}

function splitSystem(messages: ChatMessage[]): { system: string; turns: ChatMessage[] } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const turns = mergeSameRole(messages.filter((message) => message.role !== 'system'));
  // Anthropic and Google both require the conversation to open on a user turn.
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
  currentChars += lastTurn.content.length;

  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i];
    const turnLen = turn.content.length;
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
  const url = joinUrl(provider.base_url, provider.endpoint);

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
        })),
      };
    }

    case 'google': {
      const { system, turns } = splitSystem(messages);
      return {
        // The key travels as a header rather than a query parameter so it stays
        // out of proxy and CDN access logs.
        url,
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
            stream: false,
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
          stream: false,
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
          stream: false,
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
