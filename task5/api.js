const API_URL = 'https://router.huggingface.co/v1/chat/completions';
const TOKEN_STORAGE = 'task5.hf.token';

const HTTP_HINTS = {
  400: 'Bad request — the payload was rejected.',
  401: 'Invalid token. Paste a Hugging Face token with inference access.',
  402: 'Out of credits. Top up at huggingface.co/settings/billing',
  403: 'This token may not call Inference Providers.',
  404: 'That provider is not serving that model right now.',
  422: 'Invalid parameters in the request.',
  429: 'Rate limited. Wait a moment, or lower the run count.',
  500: 'Provider error. Try again shortly.',
  503: 'The provider is overloaded or cold. Try again shortly.',
};

function getToken() {
  try {
    return (localStorage.getItem(TOKEN_STORAGE) || '').trim();
  } catch (error) {
    return '';
  }
}

function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_STORAGE, value.trim());
    else localStorage.removeItem(TOKEN_STORAGE);
  } catch (error) {
  }
}

async function explain(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = (body.error && (body.error.message || body.error)) || '';
  } catch (error) {
    detail = '';
  }
  const hint = HTTP_HINTS[response.status] || `HTTP ${response.status}`;
  return `${hint} ${typeof detail === 'string' ? detail : ''}`.trim();
}

async function complete({ model, messages, temperature, maxTokens, signal, onChunk }) {
  const token = getToken();
  if (!token) throw new Error('No token. Paste one into the token field above.');

  const started = performance.now();

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not reach router.huggingface.co. Check your connection.');
  }

  if (!response.ok) throw new Error(await explain(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let ttft = null;
  let usage = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        continue;
      }

      if (parsed.usage) usage = parsed.usage;

      const choice = parsed.choices && parsed.choices[0];
      const delta = (choice && choice.delta) || {};
      const thought = delta.reasoning_content || delta.reasoning;

      if (thought) {
        if (ttft === null) ttft = (performance.now() - started) / 1000;
        reasoning += thought;
        if (onChunk) onChunk(thought, 'reasoning');
      }
      if (delta.content) {
        if (ttft === null) ttft = (performance.now() - started) / 1000;
        text += delta.content;
        if (onChunk) onChunk(delta.content, 'content');
      }
    }
  }

  const elapsed = (performance.now() - started) / 1000;
  const details = (usage && usage.completion_tokens_details) || {};

  return {
    text,
    reasoning,
    ttft,
    elapsed,
    promptTokens: (usage && usage.prompt_tokens) || 0,
    completionTokens: (usage && usage.completion_tokens) || 0,
    reasoningTokens: details.reasoning_tokens || 0,
    reportedCost: usage && typeof usage.estimated_cost === 'number' ? usage.estimated_cost : null,
  };
}
