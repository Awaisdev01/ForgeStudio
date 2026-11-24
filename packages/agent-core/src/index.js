/**
 * forge-agent-core — portable coding-agent loop.
 * Zero deps (Node 18+ global fetch). Powers ForgeStudio.
 *
 * Features:
 *  - OpenAI-compatible providers (Ollama, LM Studio, Gemini, Groq, Cerebras, OpenRouter, any custom)
 *  - Live local-model discovery (/api/tags, /v1/models)
 *  - SSE streaming with tool-call accumulation + usage capture
 *  - Automatic fallback chain on 429/402/quota/5xx (free tiers first)
 *  - Tool execution with run-level checkpoint support (bring your own fs ops)
 *
 * Usage:
 *   const { createAgent } = require('forge-agent-core');
 *   const agent = createAgent({ providers, keys, defaultModel });
 *   for await (const ev of agent.run({ messages, model, mode })) { ... }
 */
'use strict';

const DEFAULT_PROVIDERS = {
  ollama:     { baseUrl: 'http://127.0.0.1:11434/v1', local: true, models: [] },
  lmstudio:   { baseUrl: 'http://127.0.0.1:1234/v1',  local: true, models: [] },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', models: ['gemini-flash-latest', 'gemini-flash-lite-latest'] },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  cerebras:   { baseUrl: 'https://api.cerebras.ai/v1', models: ['llama3.1-8b'] },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', models: ['google/gemma-4-31b-it:free'] },
};

function resolveModel(fullId, providers, fallbackModel) {
  const slash = fullId?.indexOf('/') ?? -1;
  const pid = slash > 0 ? fullId.slice(0, slash) : 'gemini';
  const mid = slash > 0 ? fullId.slice(slash + 1) : (fullId ?? fallbackModel);
  const provider = providers[pid] ?? providers.gemini;
  return { providerId: pid, modelId: mid, provider };
}

function createAgent({ providers = DEFAULT_PROVIDERS, keys = {}, fallbackOrder = ['gemini', 'groq', 'cerebras', 'openrouter'], defaultModel = 'gemini/gemini-flash-latest' } = {}) {
  const stats = {};
  async function tryProvider(pid, modelId, body, signal) {
    const provider = providers[pid];
    const key = keys[pid] ?? '';
    if (!provider.local && !key) return { retry: `no key for ${pid}` };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      if (pid === 'openrouter') { headers['HTTP-Referer'] = 'http://localhost:4180'; headers['X-Title'] = 'forge-agent-core'; }
      const res = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, model: modelId }), signal });
      stats[pid] ??= { requests: 0, fails: 0, fallbacks: 0 };
      stats[pid].requests++;
      if ([429, 402, 403].includes(res.status)) { stats[pid].fails++; return { retry: `${pid} ${res.status}` }; }
      if (res.status >= 500) { stats[pid].fails++; return { retry: `${pid} 5xx` }; }
      return { res };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('__aborted__');
      return { retry: `${pid} unreachable` };
    }
  }

  async function callFallback(body, model, signal) {
    const { providerId, modelId } = resolveModel(model ?? defaultModel, providers, defaultModel);
    const chain = [providerId, ...fallbackOrder.filter((p) => p !== providerId && !providers[p]?.local)];
    let last = null;
    for (const pid of chain) {
      const a = await tryProvider(pid, pid === providerId ? modelId : providers[pid]?.models?.[0] ?? modelId, body, signal);
      if (a.res) return { res: a.res, providerId: pid };
      last = a.retry;
    }
    for (const pid of Object.keys(providers).filter((p) => providers[p].local)) {
      if (!providers[pid].models?.length) continue;
      const a = await tryProvider(pid, providers[pid].models[0].id ?? providers[pid].models[0], body, signal);
      if (a.res) return { res: a.res, providerId: pid };
      last = a.retry;
    }
    throw new Error(last ?? 'no provider available');
  }

  async function* run({ messages, model, mode = 'code', tools = [], maxIter = 12, onDelta, signal }) {
    const history = [...messages];
    for (let i = 0; i < maxIter; i++) {
      const { res, providerId } = await callFallback(
        { messages: history, tools, stream: true, temperature: 0.6 }, model, signal);
      if (!res.ok) { const t = await res.text(); throw new Error(`upstream ${res.status}: ${t.slice(0, 160)}`); }
      // parse SSE
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', content = '', usage = null;
      const toolCalls = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk; try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (delta.content) { content += delta.content; onDelta?.(delta.content); yield { type: 'delta', text: delta.content }; }
          for (const tc of delta.tool_calls ?? []) {
            const j = tc.index ?? 0;
            toolCalls[j] ??= { id: tc.id ?? `call_${j}`, name: '', args: '' };
            if (tc.id) toolCalls[j].id = tc.id;
            if (tc.function?.name) toolCalls[j].name += tc.function.name;
            if (tc.function?.arguments) toolCalls[j].args += tc.function.arguments;
          }
        }
      }
      yield { type: 'message', content, usage, providerId };
      if (!toolCalls.filter(Boolean).length) return;
      const calls = toolCalls.filter(Boolean);
      history.push({ role: 'assistant', content, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.args || '{}'); } catch {}
        yield { type: 'tool-call', name: c.name, args };
        // caller executes the tool and feeds the result back:
        const result = yield { type: 'await-tool', name: c.name, args, id: c.id };
        history.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: String(result) });
      }
    }
  }

  async function scanLocal() {
    const scan = async (pid, url, pick) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
        if (r.ok) { providers[pid].models = pick(await r.json()); providers[pid].online = true; }
        else { providers[pid].online = false; }
      } catch { providers[pid].online = false; }
    };
    await Promise.all([
      scan('ollama', 'http://127.0.0.1:11434/api/tags', (j) => (j.models ?? []).map((m) => ({ id: m.name, label: m.name }))),
      scan('lmstudio', 'http://127.0.0.1:1234/v1/models', (j) => (j.data ?? []).map((m) => ({ id: m.id, label: m.id }))),
    ]);
  }

  return { run, scanLocal, stats, providers, keys, resolveModel: (m) => resolveModel(m, providers, defaultModel) };
}

module.exports = { createAgent, DEFAULT_PROVIDERS };
