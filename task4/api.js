/* DeepSeek from the browser.
 *
 * The API sends CORS headers and reflects the origin -- including `null`, the
 * origin of a file:// page -- so this runs by opening index.html directly. No
 * server, no build, no proxy.
 *
 * The key is read from localStorage, which is the trade this design makes: it
 * never touches disk in the project and there is nothing to gitignore, but it
 * does live in the browser. That is fine for a local file and it is the reason
 * this page must not be hosted anywhere.
 * */

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const KEY_STORAGE = 'task4.deepseek.key';

const HTTP_HINTS = {
  400: 'Bad request — the message payload was rejected.',
  401: 'Invalid API key. Check the key field above.',
  402: 'Insufficient balance. Top up at platform.deepseek.com',
  422: 'Invalid parameters in the request.',
  429: 'Rate limit reached. Lower the sample count or wait a moment.',
  500: 'DeepSeek server error. Try again shortly.',
  503: 'DeepSeek is overloaded. Try again shortly.',
};

function getKey() {
  try {
    return (localStorage.getItem(KEY_STORAGE) || '').trim();
  } catch (error) {
    return '';
  }
}

function setKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch (error) {
    /* private windows and blocked site data both land here; the field still
     * works for this session, it just will not be remembered */
  }
}

async function explain(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = (body.error && body.error.message) || '';
  } catch (error) {
    detail = '';
  }
  const hint = HTTP_HINTS[response.status] || `HTTP ${response.status}`;
  return `${hint} ${detail}`.trim();
}

/* One call. Streams when onChunk is given, buffers when it is not; either way
 * it resolves to the same shape, so callers do not branch on it. */
async function complete({ messages, model, temperature, signal, onChunk }) {
  const key = getKey();
  if (!key) throw new Error('No API key. Paste one into the key field above.');

  const started = performance.now();
  const stream = typeof onChunk === 'function';

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, stream }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not reach api.deepseek.com. Check your connection.');
  }

  if (!response.ok) throw new Error(await explain(response));

  if (!stream) {
    const body = await response.json();
    const choice = body.choices && body.choices[0];
    if (!choice) throw new Error('Unexpected response shape from DeepSeek.');
    return {
      text: choice.message.content || '',
      tokens: (body.usage && body.usage.completion_tokens) || 0,
      elapsed: (performance.now() - started) / 1000,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let tokens = 0;

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
      if (parsed.usage) tokens = parsed.usage.completion_tokens || tokens;
      const chunk = parsed.choices && parsed.choices[0] && parsed.choices[0].delta
        && parsed.choices[0].delta.content;
      if (chunk) {
        text += chunk;
        onChunk(chunk);
      }
    }
  }

  return { text, tokens, elapsed: (performance.now() - started) / 1000 };
}
