const el = (id) => document.getElementById(id);
const TIERS = ['low', 'mid', 'high'];

let controller = null;
let columns = [];
let runCount = 3;

function setStatus(text) {
  el('status').textContent = text;
}

function running(isRunning) {
  el('run').disabled = isRunning;
  el('stop').hidden = !isRunning;
  document.querySelectorAll('.model, #temperature, #maxTokens, #runs').forEach((node) => {
    node.disabled = isRunning;
  });
}

function seconds(value) {
  return `${value.toFixed(2)}s`;
}

function paint(column) {
  const record = column.runs[column.view];
  const reasoning = column.output.querySelector('.reasoning');
  const answer = column.output.querySelector('.answer');
  const formatted = effectiveMode(column) === 'formatted';

  column.output.classList.remove('failed');
  column.output.classList.toggle('rendered', formatted);
  reasoning.textContent = '';
  reasoning.hidden = true;
  answer.textContent = '';

  if (!record) return;
  if (record.error && !record.text) {
    column.output.classList.add('failed');
    answer.textContent = record.error;
    return;
  }
  if (record.reasoning) {
    reasoning.textContent = record.reasoning;
    reasoning.hidden = false;
  }
  if (formatted) answer.innerHTML = renderMarkdown(record.text);
  else answer.textContent = record.text;
}

function stream(column, index, chunk, kind) {
  const record = column.runs[index];
  if (kind === 'reasoning') record.reasoning += chunk;
  else record.text += chunk;
  if (column.view !== index) return;

  const target = column.output.querySelector(kind === 'reasoning' ? '.reasoning' : '.answer');
  if (kind === 'reasoning') target.hidden = false;
  target.append(chunk);
}

function isLanded(record) {
  return Boolean(record) && !record.error && typeof record.elapsed === 'number';
}

function effectiveMode(column) {
  return column.mode === 'formatted' && isLanded(column.runs[column.view]) ? 'formatted' : 'original';
}

function landed(column) {
  return column.runs.filter((record) => record && !record.error && typeof record.elapsed === 'number');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

function medianIndex(column) {
  const rows = column.runs
    .map((record, index) => ({ record, index }))
    .filter((row) => row.record && !row.record.error && typeof row.record.elapsed === 'number');
  if (!rows.length) return Math.max(0, column.runs.length - 1);
  rows.sort((a, b) => a.record.elapsed - b.record.elapsed);
  return rows[(rows.length - 1) >> 1].index;
}

function costOfRun(column, record) {
  if (typeof record.reportedCost === 'number') {
    return { value: record.reportedCost, source: 'reported' };
  }
  const value = costOf(column.select.value, record.promptTokens, record.completionTokens);
  return typeof value === 'number' ? { value, source: 'computed' } : null;
}

function spent(column) {
  return landed(column).reduce((total, record) => {
    const cost = costOfRun(column, record);
    return total + (cost ? cost.value : 0);
  }, 0);
}

function showPublished(column) {
  const entry = lookup(column.select.value);
  if (!entry) {
    column.published.textContent = '';
    return;
  }
  const bits = [`rank ${entry.rank}/${entry.total}`];
  if (entry.ttft) bits.push(`${Math.round(entry.ttft)} ms`);
  if (entry.throughput) bits.push(`${entry.throughput.toFixed(0)} tok/s`);
  column.published.textContent = `${bits.join(' · ')} published`;
}

function line(parent, text, className) {
  const node = document.createElement('div');
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
}

function renderMetrics(column, cheapest) {
  const box = column.metrics;
  box.textContent = '';

  const ok = landed(column);
  if (!ok.length) {
    line(box, column.runs.length ? 'no run landed' : 'waiting…', 'dim');
    return;
  }

  const elapsed = ok.map((record) => record.elapsed);
  const ttfts = ok.map((record) => record.ttft).filter((value) => typeof value === 'number');
  const rates = ok
    .filter((record) => record.completionTokens > 0 && record.elapsed > 0)
    .map((record) => record.completionTokens / record.elapsed);

  const headline = [`median ${seconds(median(elapsed))}`];
  if (ttfts.length) headline.push(`ttft ${seconds(median(ttfts))}`);
  if (rates.length) headline.push(`${median(rates).toFixed(0)} tok/s`);
  line(box, headline.join(' · '), 'headline');

  if (ok.length > 1) {
    line(box, `range ${seconds(Math.min(...elapsed))}–${seconds(Math.max(...elapsed))} over ${ok.length} runs`, 'dim');
  }

  const pick = column.runs[medianIndex(column)];
  const cost = costOfRun(column, pick);
  const tokens = `${pick.completionTokens} out / ${pick.promptTokens} in tokens`;
  line(box, cost ? `${tokens} · ${money(cost.value)} ${cost.source}` : tokens, 'dim');

  if (pick.reasoningTokens) {
    line(box, `${pick.reasoningTokens} of those were reasoning tokens`, 'dim');
  }
  if (cost && cheapest > 0) {
    const ratio = cost.value / cheapest;
    line(box, ratio <= 1.0001 ? 'cheapest column' : `${ratio.toFixed(1)}× the cheapest column`, 'dim');
  }
}

function renderTabs(column) {
  column.tabs.textContent = '';
  if (runCount < 2) {
    column.tabs.hidden = true;
    return;
  }
  column.tabs.hidden = false;

  const best = landed(column).length ? medianIndex(column) : -1;
  for (let index = 0; index < runCount; index += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    if (index === column.view) button.classList.add('active');
    if (index === best) button.classList.add('median');
    button.textContent = String(index + 1);
    button.disabled = !column.runs[index];
    if (index === best) button.title = 'median run — the one the numbers describe';
    button.addEventListener('click', () => {
      column.view = index;
      paint(column);
      renderTabs(column);
      renderViews(column);
    });
    column.tabs.append(button);
  }
}

function renderViews(column) {
  const ready = isLanded(column.runs[column.view]);
  const mode = effectiveMode(column);
  column.views.querySelectorAll('.view').forEach((button) => {
    button.disabled = button.dataset.mode === 'formatted' && !ready;
    button.classList.toggle('active', button.dataset.mode === mode);
  });
}

function renderAll() {
  const medians = columns
    .map((column) => {
      const ok = landed(column);
      if (!ok.length) return null;
      return costOfRun(column, column.runs[medianIndex(column)]);
    })
    .filter(Boolean)
    .map((cost) => cost.value)
    .filter((value) => value > 0);

  const cheapest = medians.length ? Math.min(...medians) : 0;
  columns.forEach((column) => {
    renderMetrics(column, cheapest);
    renderTabs(column);
    renderViews(column);
  });

  const total = columns.reduce((sum, column) => sum + spent(column), 0);
  el('spend').textContent = total > 0 ? `This comparison cost ${money(total)}.` : '';
}

async function run() {
  const prompt = el('prompt').value.trim();
  if (!prompt) {
    setStatus('The prompt is empty.');
    el('prompt').focus();
    return;
  }
  if (!getToken()) {
    setStatus('Paste a Hugging Face token first.');
    el('token').focus();
    return;
  }

  runCount = Number(el('runs').value) || 1;
  const temperature = Number(el('temperature').value);
  const maxTokens = Number(el('maxTokens').value);

  columns.forEach((column) => {
    column.runs = [];
    column.view = 0;
    paint(column);
  });
  renderAll();

  controller = new AbortController();
  running(true);
  setStatus('');
  const started = performance.now();

  try {
    await sweep(runCount, temperature, maxTokens, prompt);
  } finally {
    running(false);
    const wall = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(stopped() ? `Stopped after ${wall}s.` : `Done in ${wall}s.`);
    columns.forEach((column) => {
      column.view = medianIndex(column);
      paint(column);
    });
    renderAll();
  }
}

let aborted = false;

function stopped() {
  return aborted;
}

async function sweep(runCount, temperature, maxTokens, prompt) {
  aborted = false;

  outer:
  for (let index = 0; index < runCount; index += 1) {
    for (const column of columns) {
      if (controller.signal.aborted) {
        aborted = true;
        break outer;
      }

      setStatus(`run ${index + 1} of ${runCount} · ${column.tier}`);
      const record = { text: '', reasoning: '' };
      column.runs[index] = record;
      column.view = index;
      paint(column);
      renderTabs(column);
      renderViews(column);

      try {
        const reply = await complete({
          model: column.select.value,
          temperature,
          maxTokens,
          signal: controller.signal,
          messages: [{ role: 'user', content: prompt }],
          onChunk: (chunk, kind) => stream(column, index, chunk, kind),
        });
        Object.assign(record, reply);
      } catch (error) {
        record.error = error.name === 'AbortError' ? 'stopped' : error.message;
        if (error.name === 'AbortError') {
          aborted = true;
          paint(column);
          renderAll();
          break outer;
        }
      }

      paint(column);
      renderAll();
    }
  }
}

async function boot() {
  columns = TIERS.map((tier) => {
    const node = document.querySelector(`.column[data-tier="${tier}"]`);
    return {
      tier,
      select: node.querySelector('.model'),
      published: node.querySelector('.published'),
      metrics: node.querySelector('.metrics'),
      tabs: node.querySelector('.tabs'),
      views: node.querySelector('.views'),
      output: node.querySelector('.response'),
      runs: [],
      view: 0,
      mode: 'formatted',
    };
  });

  columns.forEach((column) => {
    column.views.addEventListener('click', (event) => {
      const button = event.target.closest('.view');
      if (!button || button.disabled) return;
      column.mode = button.dataset.mode;
      paint(column);
      renderViews(column);
    });
  });

  el('token').value = getToken();
  el('token').addEventListener('input', (event) => {
    setToken(event.target.value);
    el('tokenHint').textContent = event.target.value.trim()
      ? 'Kept in this browser only.'
      : 'Cleared.';
  });

  el('run').addEventListener('click', run);
  el('stop').addEventListener('click', () => controller && controller.abort());
  el('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) run();
  });

  const entries = await loadModels();
  columns.forEach((column) => {
    fillSelect(column.select, entries, defaultFor(column.tier, entries));
    showPublished(column);
    column.select.addEventListener('change', () => showPublished(column));
  });

  runCount = Number(el('runs').value) || 1;
  renderAll();
  el('catalogue').textContent = `${entries.length} model–provider pairs, cheapest first.`;
}

document.addEventListener('DOMContentLoaded', boot);
