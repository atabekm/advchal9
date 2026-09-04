/* One prompt, three temperatures, three columns.
 *
 * The three calls go out together rather than in sequence, so the columns fill
 * at whatever pace each response arrives and you are not waiting on the slowest
 * one to see the first.
 */

const el = (id) => document.getElementById(id);

let controller = null;

function columns() {
  return Array.from(document.querySelectorAll('.column')).map((node) => ({
    temperature: Number(node.querySelector('.temp').value),
    output: node.querySelector('.response'),
    meta: node.querySelector('.meta'),
  }));
}

function setStatus(text) {
  el('status').textContent = text;
}

function running(isRunning) {
  el('run').disabled = isRunning;
  el('stop').hidden = !isRunning;
  document.querySelectorAll('.temp').forEach((input) => { input.disabled = isRunning; });
}

async function run() {
  const prompt = el('prompt').value.trim();
  if (!prompt) { setStatus('The prompt is empty.'); el('prompt').focus(); return; }
  if (!getKey()) { setStatus('Paste an API key first.'); el('key').focus(); return; }

  const model = el('model').value;
  const targets = columns();

  targets.forEach((column) => {
    column.output.textContent = '';
    column.output.classList.remove('failed');
    column.meta.textContent = 'waiting…';
  });

  controller = new AbortController();
  running(true);
  setStatus('');

  const started = performance.now();

  await Promise.all(targets.map(async (column) => {
    try {
      const reply = await complete({
        model,
        temperature: column.temperature,
        signal: controller.signal,
        messages: [{ role: 'user', content: prompt }],
        onChunk: (chunk) => { column.output.append(chunk); },
      });
      column.meta.textContent = `${reply.tokens} tokens · ${reply.elapsed.toFixed(1)}s`;
    } catch (error) {
      if (error.name === 'AbortError') {
        column.meta.textContent = 'stopped';
        return;
      }
      column.output.textContent = error.message;
      column.output.classList.add('failed');
      column.meta.textContent = 'failed';
    }
  }));

  running(false);
  setStatus(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
}

function boot() {
  el('key').value = getKey();
  el('key').addEventListener('input', (event) => {
    setKey(event.target.value);
    el('keyHint').textContent = event.target.value.trim()
      ? 'Kept in this browser only.'
      : 'Cleared.';
  });

  el('run').addEventListener('click', run);
  el('stop').addEventListener('click', () => controller && controller.abort());

  /* Cmd/Ctrl-Enter from the prompt box runs it, since that is where you are. */
  el('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) run();
  });
}

document.addEventListener('DOMContentLoaded', boot);
