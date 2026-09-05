const MODELS_URL = 'https://router.huggingface.co/v1/models';

const DEFAULTS = {
  low: 'Qwen/Qwen3-4B-Instruct-2507:nscale',
  mid: 'meta-llama/Llama-3.3-70B-Instruct:novita',
  high: 'deepseek-ai/DeepSeek-V4-Pro:deepinfra',
};

const FALLBACK_PERCENTILE = { low: 0.05, mid: 0.4, high: 0.85 };

const OFFLINE = [
  { model: 'Qwen/Qwen3-4B-Instruct-2507', provider: 'nscale', input: 0.01, output: 0.03 },
  { model: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'novita', input: 0.14, output: 0.4 },
  { model: 'deepseek-ai/DeepSeek-V4-Pro', provider: 'deepinfra', input: 1.3, output: 2.6 },
];

const catalogue = new Map();

function entryFrom(model, provider) {
  const pricing = provider.pricing || {};
  return {
    id: `${model}:${provider.provider}`,
    model,
    provider: provider.provider,
    input: pricing.input,
    output: pricing.output,
    ttft: provider.first_token_latency_ms,
    throughput: provider.throughput,
  };
}

async function loadModels() {
  let entries = [];

  try {
    const response = await fetch(MODELS_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();

    for (const item of body.data || []) {
      for (const provider of item.providers || []) {
        if (provider.status !== 'live') continue;
        if (!provider.pricing || typeof provider.pricing.output !== 'number') continue;
        entries.push(entryFrom(item.id, provider));
      }
    }
  } catch (error) {
    entries = OFFLINE.map((row) => ({ ...row, id: `${row.model}:${row.provider}` }));
  }

  entries.sort((a, b) => a.output - b.output || a.input - b.input);

  catalogue.clear();
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
    entry.total = entries.length;
    catalogue.set(entry.id, entry);
  });

  return entries;
}

function lookup(id) {
  return catalogue.get(id) || null;
}

function costOf(id, promptTokens, completionTokens) {
  const entry = lookup(id);
  if (!entry || typeof entry.output !== 'number') return null;
  return (promptTokens * entry.input + completionTokens * entry.output) / 1e6;
}

function defaultFor(tier, entries) {
  if (catalogue.has(DEFAULTS[tier])) return DEFAULTS[tier];
  const index = Math.min(entries.length - 1, Math.round(FALLBACK_PERCENTILE[tier] * (entries.length - 1)));
  return entries[index] ? entries[index].id : '';
}

function money(value) {
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value >= 0.0001) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(7)}`;
}

function labelFor(entry) {
  return `${money(entry.output)}/M · ${entry.model} · ${entry.provider}`;
}

function fillSelect(select, entries, selectedId) {
  select.textContent = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = labelFor(entry);
    select.append(option);
  }
  if (selectedId) select.value = selectedId;
}
