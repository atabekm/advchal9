// The web chat: the conversation lives in this browser (localStorage) and goes to the gateway's
// /v1/chat/completions whole on every turn, streamed back as SSE. Under each reply: how long it
// queued for a slot, time to first token, speed and tokens. Limits come back as readable notes.

const SYSTEM = "You are a helpful assistant running privately on a small server. Answer clearly and concisely.";
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let key = store.get("apiKey", "");
let turns = store.get("turns", []);   // {role, content, meta?, note?}
let limits = null;
let busy = null;                      // AbortController of the running request

const NOTES = {
  401: "The API key was refused.",
  413: "The conversation no longer fits the model's context window. Start a new chat.",
  429: "Rate limit reached for this key.",
  503: "The server is busy: every generation slot is taken and the queue is full.",
  502: "The model backend failed.",
};

// ---------------------------------------------------------------- status

async function refreshHealth() {
  try {
    const h = await (await fetch("/health")).json();
    limits = h.limits;
    $("model").textContent = `${h.model} · Ollama ${h.ollama ?? "down"} · context ${h.limits.max_context} tokens`;
    $("status").innerHTML = `<span class="dot ${h.status === "ok" ? "ok" : "bad"}"></span>` +
      `${h.load.active}/${h.limits.max_concurrent} generating · ${h.load.queued} queued`;
  } catch {
    $("status").innerHTML = `<span class="dot bad"></span>server unreachable`;
  }
}

// ---------------------------------------------------------------- views

function show() {
  $("login").hidden = !!key;
  $("chat").hidden = !key;
  $("newChat").hidden = $("forget").hidden = !key;
  if (key) { render(); $("input").focus(); } else { $("key").focus(); }
}

function bubble(t) {
  const el = document.createElement("div");
  if (t.note) {
    el.className = "note";
    el.textContent = t.note;
    return el;
  }
  el.className = `msg ${t.role}`;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = t.content;
  el.append(body);
  if (t.meta) {
    const m = document.createElement("div");
    m.className = "meta dim";
    m.textContent = t.meta;
    el.append(m);
  }
  return el;
}

function render() {
  const log = $("log");
  log.querySelectorAll(".msg, .note").forEach((n) => n.remove());
  $("empty").hidden = turns.length > 0;
  turns.forEach((t) => log.append(bubble(t)));
  log.scrollTop = log.scrollHeight;
  meter();
}

function meter() {
  const last = [...turns].reverse().find((t) => t.usage);
  const used = last ? last.usage.total_tokens : 0;
  const max = limits?.max_context ?? 4096;
  const pct = Math.min(100, (used / max) * 100);
  $("ctxBar").style.width = `${pct}%`;
  $("ctxBar").className = pct > 85 ? "hot" : "";
  $("ctxText").textContent = last ? `${used} / ${max}` : `0 / ${max}`;
}

function save() { store.set("turns", turns); }

// ---------------------------------------------------------------- talking

function history() {
  return [{ role: "system", content: SYSTEM },
          ...turns.filter((t) => !t.note && t.content).map(({ role, content }) => ({ role, content }))];
}

async function send(text) {
  turns.push({ role: "user", content: text });
  const reply = { role: "assistant", content: "" };
  turns.push(reply);
  save(); render();
  const el = $("log").lastElementChild;
  const body = el.querySelector(".body");
  el.classList.add("pending");

  busy = new AbortController();
  $("send").textContent = "Stop";
  const t0 = performance.now();
  let first = null, usage = null, res;
  try {
    res = await fetch("/v1/chat/completions", {
      method: "POST", signal: busy.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: history(), stream: true }),
    });
    rateInfo(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))).error ?? {};
      turns.pop();
      const retry = res.headers.get("Retry-After");
      turns.push({ note: `${res.status} · ${NOTES[res.status] ?? "Request failed."} ${err.message ?? ""}` +
                         (retry ? ` (retry in ${retry}s)` : "") });
      if (res.status === 401) { key = ""; store.del("apiKey"); }
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        const ev = JSON.parse(data);
        if (ev.error) throw new Error(ev.error.message);
        const delta = ev.choices[0].delta.content;
        if (delta) {
          first ??= performance.now();
          reply.content += delta;
          body.textContent = reply.content;
          $("log").scrollTop = $("log").scrollHeight;
        }
        if (ev.usage) { usage = ev.usage; reply.finish = ev.choices[0].finish_reason; }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") turns.push({ note: `Connection failed: ${e.message}` });
  } finally {
    busy = null;
    $("send").textContent = "Send";
    if (res?.ok) {
      const end = performance.now();
      const wait = +(res.headers.get("X-Queue-Wait-Ms") ?? 0);
      const parts = [];
      if (wait > 50) parts.push(`queued ${(wait / 1000).toFixed(1)}s`);
      if (first) parts.push(`first token ${((first - t0) / 1000).toFixed(1)}s`);
      if (usage) {
        const gen = (end - (first ?? end)) / 1000;
        if (gen > 0) parts.push(`${(usage.completion_tokens / gen).toFixed(1)} tok/s`);
        parts.push(`${usage.prompt_tokens} in · ${usage.completion_tokens} out`);
        reply.usage = usage;
      } else {
        parts.push("stopped");
      }
      if (reply.finish === "length") parts.push("cut at the output limit");
      reply.meta = parts.join(" · ");
      if (!reply.content) turns.splice(turns.indexOf(reply), 1);
    }
    save();
    show();
    refreshHealth();
  }
}

function rateInfo(res) {
  const lim = res.headers.get("X-RateLimit-Limit");
  const rem = res.headers.get("X-RateLimit-Remaining");
  if (lim) $("rate").textContent = `${rem}/${lim} requests left this minute`;
}

// ---------------------------------------------------------------- wiring

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const k = $("key").value.trim();
  const r = await fetch("/v1/models", { headers: { Authorization: `Bearer ${k}` } }).catch(() => null);
  if (r?.ok) {
    key = k; store.set("apiKey", k); $("loginError").hidden = true; show();
  } else {
    $("loginError").textContent = r ? "That key was refused." : "The server is unreachable.";
    $("loginError").hidden = false;
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { busy.abort(); return; }
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";
  send(text);
});

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("newChat").addEventListener("click", () => { busy?.abort(); turns = []; save(); render(); $("input").focus(); });
$("forget").addEventListener("click", () => { busy?.abort(); key = ""; store.del("apiKey"); show(); });

refreshHealth();
setInterval(refreshHealth, 3000);
show();
