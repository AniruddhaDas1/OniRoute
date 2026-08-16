export const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_MAX_TOKENS = 4096;

export function joinUrl(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${baseUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
}

export function normaliseMessages(raw) {
  const messages = [];
  for (const item of raw || []) {
    const content = typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content)
      ? item.content.map((part) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
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

function mergeSameRole(messages) {
  return messages.reduce((merged, message) => {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
    return merged;
  }, []);
}

function splitSystem(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = mergeSameRole(messages.filter((m) => m.role !== 'system'));
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return { system, turns };
}

function defined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function buildProviderRequest(provider, apiKey, messages, options = {}) {
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
        url,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(defined({
          contents: turns.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
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
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey && apiKey !== 'ollama') headers.Authorization = `Bearer ${apiKey}`;

      // If native Ollama endpoint (/chat or /api/chat)
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

      // OpenAI-compatible Ollama endpoint (/v1/chat/completions)
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

function usageFrom(prompt, completion) {
  const promptTokens = Number(prompt);
  const completionTokens = Number(completion);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return undefined;
  const safePrompt = Number.isFinite(promptTokens) ? promptTokens : 0;
  const safeCompletion = Number.isFinite(completionTokens) ? completionTokens : 0;
  return { prompt_tokens: safePrompt, completion_tokens: safeCompletion, total_tokens: safePrompt + safeCompletion };
}

export function parseProviderResponse(provider, responseBody) {
  switch (provider.provider_type) {
    case 'anthropic':
      return {
        content: (responseBody.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join(''),
        model: responseBody.model || provider.model_name,
        finishReason: responseBody.stop_reason === 'max_tokens' ? 'length' : 'stop',
        usage: usageFrom(responseBody.usage?.input_tokens, responseBody.usage?.output_tokens),
      };

    case 'google': {
      const candidate = responseBody.candidates?.[0];
      return {
        content: (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join(''),
        model: responseBody.modelVersion || provider.model_name,
        finishReason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
        usage: usageFrom(responseBody.usageMetadata?.promptTokenCount, responseBody.usageMetadata?.candidatesTokenCount),
      };
    }

    case 'ollama': {
      // Native Ollama message format
      if (responseBody.message?.content !== undefined) {
        return {
          content: responseBody.message.content ?? '',
          model: responseBody.model || provider.model_name,
          finishReason: responseBody.done_reason || (responseBody.done ? 'stop' : 'length'),
          usage: usageFrom(responseBody.prompt_eval_count, responseBody.eval_count),
        };
      }
      // OpenAI-compatible format
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

export async function embedText(provider, apiKey, text) {
  const model = provider.embedding_model_name || provider.model_name;
  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;

  if (provider.provider_type === 'google') {
    url = `${provider.base_url.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:embedContent`;
    headers['x-goog-api-key'] = apiKey;
    body = { model: `models/${model}`, content: { parts: [{ text }] } };
  } else if (provider.provider_type === 'ollama') {
    if (apiKey && apiKey !== 'ollama') headers.Authorization = `Bearer ${apiKey}`;

    // Ollama Cloud (https://ollama.com/api/embed) or native (/embed)
    if (provider.base_url.endsWith('/api') || provider.endpoint === '/chat' || provider.endpoint === '/api/chat') {
      url = joinUrl(provider.base_url, '/embed');
      body = { model, input: text };
    } else {
      const derived = provider.endpoint.replace(/chat\/completions\/?$/i, 'embeddings').replace(/messages\/?$/i, 'embeddings');
      url = joinUrl(provider.base_url, derived === provider.endpoint ? '/v1/embeddings' : derived);
      body = { model, input: text };
    }
  } else {
    const derived = provider.endpoint.replace(/chat\/completions\/?$/i, 'embeddings').replace(/messages\/?$/i, 'embeddings');
    url = joinUrl(provider.base_url, derived === provider.endpoint ? '/v1/embeddings' : derived);
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, input: text };
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Embedding request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const payload = await res.json();
  const embedding =
    provider.provider_type === 'google'
      ? payload.embedding?.values
      : payload.embeddings?.[0] ?? payload.data?.[0]?.embedding ?? payload.embedding;

  if (!Array.isArray(embedding)) {
    throw new Error(`Embedding model "${model}" did not return a valid vector.`);
  }
  return embedding;
}
