/**
 * ForgeStudio — main process (CJS).
 * Layers: gateway server (from v0.2) + agent loop with:
 *   1. multi-file diff preview (writes are staged, not written, until approved)
 *   2. session resume + history (persisted in userData/sessions)
 *   3. MCP stdio servers (tools exposed to the agent)
 *   4. multi-provider model picker (z.ai GLM + any OpenAI-compatible custom)
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');


// ── config ──
// Provider registry — all OpenAI-compatible. Free tiers first.
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyHint: 'free key: aistudio.google.com → Get API key',
    models: [
      { id: 'gemini-flash-latest', label: 'Gemini Flash (free)' },
      { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (free)' },
    ],
  },
  groq: {
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: 'free key: console.groq.com',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (free, fast)' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (free, instant)' },
    ],
  },
  cerebras: {
    label: 'Cerebras (free tier)',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyHint: 'free key: cloud.cerebras.ai',
    models: [
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B (1M tok/day free)' },
    ],
  },
  openrouter: {
    label: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'free key: openrouter.ai/keys (50 req/day on :free models)',
    models: [
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)' },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (free)' },
      { id: 'inclusionai/ling-3.2-flash:free', label: 'Ling 3.2 Flash (free)' },
    ],
  },
  ollama: {
    label: 'Ollama (local, open weights)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyHint: 'local — install: https://ollama.com then `ollama pull qwen3:8b`',
    local: true,
    models: [], // discovered live from /api/tags
  },
  lmstudio: {
    label: 'LM Studio (local, open weights)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyHint: 'local — start LM Studio and load a model (Developer → Start Server)',
    local: true,
    models: [],
  },
  zai: {
    label: 'Z.ai GLM (paid)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyHint: 'paid: your z.ai key',
    models: [
      { id: 'glm-5.3-flash', label: 'GLM-5.3-flash (paid)' },
      { id: 'glm-5.3', label: 'GLM-5.3 (paid, deep)' },
    ],
  },
};

// keys: { providerId: key } — persisted in userData/keys.json
let providerKeys = {};
const keysFile = () => path.join(userData(), 'keys.json');
function loadKeys() {
  try { providerKeys = JSON.parse(fs.readFileSync(keysFile(), 'utf8')); } catch { providerKeys = {}; }
  // seed z.ai key from env/baked default if present
  if (!providerKeys.zai && process.env.GW_UPSTREAM_KEY) {
    providerKeys.zai = process.env.GW_UPSTREAM_KEY;
  }
}
function saveKeys() { try { fs.writeFileSync(keysFile(), JSON.stringify(providerKeys)); } catch {} }

function resolveModel(fullId) {
  // model ids arrive as "provider/model", e.g. "gemini/gemini-flash-latest"
  const slash = fullId.indexOf('/');
  const providerId = slash > 0 ? fullId.slice(0, slash) : 'zai';
  const modelId = slash > 0 ? fullId.slice(slash + 1) : fullId;
  const provider = PROVIDERS[providerId] ?? PROVIDERS.zai;
  return { providerId, modelId, provider, key: providerKeys[providerId] ?? '' };
}

const CONFIG = {
  port: 4180,
  fallbackOrder: ['gemini', 'github', 'groq', 'cerebras', 'openrouter', 'ollama', 'lmstudio'],
  masterKey: 'forge-local-master',
  upstream: {
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKey: process.env.GW_UPSTREAM_KEY ?? '',
    defaultModel: 'gemini/gemini-flash-latest',
  },
  plans: {
    study: { credits: 1000, sessionLimit: 100, weeklyLimit: 500, multiplier: 1 },
    heavy: { credits: 7000, sessionLimit: 300, weeklyLimit: 2000, multiplier: 1 },
  },
  defaultPlan: 'study',
};
function allModels() {
  // local providers first (0 credits), then free tiers, then paid
  const order = ['ollama', 'lmstudio', 'gemini', 'groq', 'cerebras', 'github', 'openrouter', 'zai'];
  return order.flatMap((pid) => {
    const p = PROVIDERS[pid];
    if (p.local && !p.models.length) return []; // offline local server: hide instead of error
    return (p.models ?? []).map((m) => ({ id: `${pid}/${m.id}`, label: m.label, provider: pid }));
  });
}

/* local model discovery: /api/tags (ollama) and /v1/models (lmstudio), cached 30s */
let localScanCache = { t: 0 };
async function scanLocalProviders(force = false) {
  if (!force && Date.now() - localScanCache.t < 30_000) return localScanCache.result;
  const scan = async (pid, url, pick) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(String(r.status));
      PROVIDERS[pid].models = pick(await r.json());
      PROVIDERS[pid].online = true;
    } catch {
      PROVIDERS[pid].models = [];
      PROVIDERS[pid].online = false;
    }
  };
  await Promise.all([
    scan('ollama', 'http://127.0.0.1:11434/api/tags',
      (j) => (j.models ?? []).map((m) => ({
        id: m.name,
        label: `${m.name} · ${(m.size / 1e9).toFixed(1)} GB (local, 0 credits)`,
        openWeights: true,
      }))),
    scan('lmstudio', 'http://127.0.0.1:1234/v1/models',
      (j) => (j.data ?? []).map((m) => ({ id: m.id, label: `${m.id} (local, 0 credits)`, openWeights: true }))),
  ]);
  localScanCache = { t: Date.now(), result: true };
  return true;
}
const MODEL_MULTIPLIER = { 'zai/glm-5.3': 5 };
// local models cost 0 credits: chargeCredits skips providers marked local via resolveModel

const userData = () => app.getPath('userData');
function nowWeek() { return Math.floor(Date.now() / (7 * 24 * 3600 * 1000)); }
let ledger = { sessions: {}, usage: {}, weekStarted: nowWeek(), providerStats: {} };
const stateFile = () => path.join(userData(), 'gateway-state.json');
function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (raw.weekStarted === nowWeek()) ledger = raw;
  } catch { /* fresh */ }
}
function saveLedger() { try { fs.writeFileSync(stateFile(), JSON.stringify(ledger)); } catch {} }

let events = [];
let currentWorkspace = null;
let win = null;
function logEvent(kind, detail) {
  events.unshift({ t: new Date().toLocaleTimeString(), kind, detail });
  if (events.length > 200) events.pop();
  try { win?.webContents.send('studio:agent-event', { events }); } catch {}
}


/* ════ GIT LAYER ════ */
const { execFileSync } = require('node:child_process');
function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
  catch { return null; }
}
function ensureGitRepo(workspace) {
  if (!workspace || git(['rev-parse', '--is-inside-work-tree'], workspace) !== 'true') {
    git(['init', '-q'], workspace);
    git(['config', 'user.name', git(['config', 'user.name'], workspace) || 'ForgeStudio'], workspace);
    git(['config', 'user.email', git(['config', 'user.email'], workspace) || 'forge@local'], workspace);
  }
}
function gitSnapshot(workspace, label) {
  // commit current state so any change is revertable; silently skips if nothing changed
  ensureGitRepo(workspace);
  git(['add', '-A'], workspace);
  const dirty = git(['status', '--porcelain'], workspace);
  if (dirty) git(['commit', '-qm', `forge: ${label}`], workspace);
}
function gitInfo(workspace) {
  if (!workspace || git(['rev-parse', '--is-inside-work-tree'], workspace) !== 'true') return { repo: false };
  return {
    repo: true,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace) ?? 'main',
    dirty: (git(['status', '--porcelain'], workspace) ?? '').split('\n').filter(Boolean).length,
  };
}
ipcMain.handle('studio:gitInfo', (_e, ws) => gitInfo(ws ?? currentWorkspace));
ipcMain.handle('studio:gitUndo', (_e, ws) => {
  const w = ws ?? currentWorkspace;
  // reset working tree to last commit (agent damage control)
  ensureGitRepo(w);
  git(['reset', '--hard'], w);
  git(['clean', '-fd'], w);
  logEvent('git', 'reset --hard (undo)');
  return { ok: true };
});
/* thread branches: each chat can work in its own git worktree */
const worktreeRoot = () => path.join(userData(), 'worktrees');
ipcMain.handle('studio:createThreadBranch', (_e, { sessionId, baseWs }) => {
  try {
    const ws = baseWs ?? currentWorkspace;
    ensureGitRepo(ws);
    const branch = `forge/chat-${sessionId.slice(0, 8)}`;
    const dir = path.join(worktreeRoot(), sessionId.slice(0, 8));
    fs.mkdirSync(worktreeRoot(), { recursive: true });
    if (!fs.existsSync(dir)) {
      execFileSync('git', ['worktree', 'add', dir, '-b', branch], { cwd: ws, encoding: 'utf8' });
    }
    logEvent('branch', `${branch} → ${dir}`);
    return { ok: true, branch, worktree: dir };
  } catch (err) { return { ok: false, error: String(err.message).slice(0, 200) }; }
});
ipcMain.handle('studio:mergeThreadBranch', (_e, { sessionId, baseWs }) => {
  try {
    const ws = baseWs ?? currentWorkspace;
    ensureGitRepo(ws);
    const branch = `forge/chat-${sessionId.slice(0, 8)}`;
    // snapshot main first, then merge
    git(['add', '-A'], ws);
    git(['commit', '-qm', 'forge: before merge'], ws);
    const merge = git(['merge', '--no-edit', branch], ws);
    // clean up worktree + branch
    const dir = path.join(worktreeRoot(), sessionId.slice(0, 8));
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ws, encoding: 'utf8' });
    git(['branch', '-D', branch], ws);
    logEvent('branch', `merged ${branch}`);
    return { ok: true, detail: merge ?? 'merged' };
  } catch (err) { return { ok: false, error: String(err.message).slice(0, 300) }; }
});
ipcMain.handle('studio:discardThreadBranch', (_e, { sessionId, baseWs }) => {
  try {
    const ws = baseWs ?? currentWorkspace;
    const branch = `forge/chat-${sessionId.slice(0, 8)}`;
    const dir = path.join(worktreeRoot(), sessionId.slice(0, 8));
    try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ws, encoding: 'utf8' }); } catch {}
    git(['branch', '-D', branch], ws);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message).slice(0, 200) }; }
});
ipcMain.handle('studio:gitCommit', (_e, { ws, msg }) => {
  const w = ws ?? currentWorkspace;
  ensureGitRepo(w);
  git(['add', '-A'], w);
  git(['commit', '-qm', msg ?? 'forge: manual commit'], w);
  return { ok: true };
});

/* ════ SESSION PERSISTENCE ════ */
const sessionsDir = () => path.join(userData(), 'sessions');
function listSessions() {
  try {
    return fs.readdirSync(sessionsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
        return { id: s.id, title: s.title, when: new Date(s.updated).toLocaleString() };
      })
      .sort((a, b) => b.when.localeCompare(a.when));
  } catch { return []; }
}
function saveSession(session) {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(), `${session.id}.json`), JSON.stringify(session));
}

/* ════ MCP (stdio servers) ════ */
const mcpFile = () => path.join(userData(), 'mcp-servers.json');
function loadMcp() {
  try { return JSON.parse(fs.readFileSync(mcpFile(), 'utf8')); } catch { return []; }
}
function saveMcp(list) { fs.writeFileSync(mcpFile(), JSON.stringify(list)); }

async function mcpListTools(serverEntry) {
  // Minimal MCP stdio handshake: initialize → tools/list → shutdown
  return new Promise((resolve) => {
    const proc = spawn(serverEntry.cmd, [], { shell: true });
    let buf = '';
    const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
    const done = (tools) => { try { proc.kill(); } catch {} resolve(tools); };
    const timer = setTimeout(() => done([]), 8000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          done(msg.result.tools.map((t) => ({ name: t.name, description: t.description ?? '' })));
        }
      }
    });
    proc.stderr.on('data', () => { /* server logs */ });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'forgegateway', version: '0.2' } } });
  });
}

/* ════ AGENT LOOP ════ */
function toolDefs(mode, mcpTools) {
  const base = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file in the workspace (up to ~16k chars; notes when truncated)', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_dir', description: 'List a directory in the workspace', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'grep', description: 'Search text across workspace files (regex, case-insensitive)', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  ];
  if (mode === 'ask') return [...base, ...(mcpTools ?? [])];
  const write = { type: 'function', function: { name: 'write_file', description: mode === 'auto' ? 'Write a file (auto-applied; a checkpoint is taken first so the user can undo)' : 'Stage a file write (goes to the Diffs pane; NOT applied until approved)', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } };
  const edit = { type: 'function', function: { name: 'edit_file', description: 'Edit an existing file by exact string replacement (old → new). Cheaper and safer than rewriting whole files. Staged for review in code mode.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } };
  const verify = { type: 'function', function: { name: 'verify', description: '(internal) runs the project test/lint/build and returns results', parameters: { type: 'object', properties: {} } } };
  const writes = mode === 'auto'
    ? [write, edit, { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the workspace (auto mode only; dangerous commands are blocked)', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } }]
    : [write, edit];
  return [...base, ...writes, verify, ...(mcpTools ?? [])];
}

/* run-level checkpoint: atomic snapshot of every file a run touches */
let checkpointSeq = 0;
function checkpointRun(workspace, files) {
  const dir = path.join(userData(), 'checkpoints', `${Date.now()}-${checkpointSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    workspace, when: Date.now(),
    files: files.map((f) => ({ path: f.path, hadContent: f.original !== null })),
  }));
  for (const f of files) {
    if (f.original !== null) fs.writeFileSync(path.join(dir, path.basename(f.path)), f.original);
    else fs.writeFileSync(path.join(dir, path.basename(f.path) + '.NULL'), '');
  }
  return dir;
}

/* dangerous-command blocklist for auto mode */
const CMD_BLOCK = [
  /rm\s+(-[a-z]+\s+)*-?[rf][rf]?\s+\/(?!tmp\b|Users\b)/, /sudo\b/, /\bmkfs\b/, /dd\s+if=/,
  /curl[^|]*\|\s*(ba)?sh/, /wget[^|]*\|\s*(ba)?sh/, /chmod\s+-R\s+777\s+\//, /\bshutdown\b/, /\breboot\b/,
];

function providerHeaders(providerId, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (providerId === 'openrouter') { headers['HTTP-Referer'] = 'http://localhost:4180'; headers['X-Title'] = 'ForgeStudio'; }
  return headers;
}

/* one attempt against one provider; returns {res} or {retry: reason} for fallback */
async function tryProvider(providerId, modelId, body, abortSignal) {
  const provider = PROVIDERS[providerId];
  const key = providerKeys[providerId] ?? '';
  if (!provider.local && !key) return { retry: `no API key for ${provider.label}` };
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: providerHeaders(providerId, key),
      body: JSON.stringify({ ...body, model: modelId }),
      signal: abortSignal ?? AbortSignal.timeout(180_000),
    });
    ledger.providerStats[providerId] ??= { requests: 0, fails: 0, fallbacks: 0 };
    ledger.providerStats[providerId].requests += 1;
    if (res.status === 429 || res.status === 402 || res.status === 403) {
      ledger.providerStats[providerId].fails += 1;
      saveLedger();
      return { retry: `${provider.label} ${res.status === 429 ? 'rate limited' : 'quota exhausted'}` };
    }
    if (res.status >= 500) { ledger.providerStats[providerId].fails += 1; saveLedger(); return { retry: `${provider.label} server error ${res.status}` }; }
    return { res };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('__aborted__');
    ledger.providerStats[providerId] ??= { requests: 0, fails: 0, fallbacks: 0 };
    ledger.providerStats[providerId].fails += 1;
    saveLedger();
    return { retry: `${provider.label} unreachable (${String(err.message).slice(0, 60)})` };
  }
}

/* primary attempt then free-provider fallback chain. reports which provider served. */
async function callUpstreamFallback(body, model, onNotice, abortSignal) {
  const { providerId, modelId } = resolveModel(model ?? 'gemini/gemini-flash-latest');
  const chain = [providerId, ...CONFIG.fallbackOrder.filter((p) => p !== providerId && !PROVIDERS[p].local)];
  let lastReason = null;
  for (const pid of chain) {
    const attempt = await tryProvider(pid, pid === providerId ? modelId : (PROVIDERS[pid].models[0]?.id ?? modelId), body, abortSignal);
    if (attempt.res) {
      ledger.providerStats[pid] ??= { requests: 0, fails: 0, fallbacks: 0 };
      ledger.providerStats[pid].fallbacks += 1; saveLedger();
      if (pid !== providerId && onNotice) onNotice(`⚠️ ${lastReason ?? 'provider failed'} — switched to ${PROVIDERS[pid].label}`);
      return { res: attempt.res, providerId: pid };
    }
    lastReason = attempt.retry;
  }
  for (const pid of ['ollama', 'lmstudio']) {
    if (!PROVIDERS[pid].online) continue;
    const attempt = await tryProvider(pid, PROVIDERS[pid].models[0]?.id, body, abortSignal);
    if (attempt.res) {
      if (onNotice) onNotice(`⚠️ ${lastReason ?? 'provider failed'} — switched to ${PROVIDERS[pid].label}`);
      return { res: attempt.res, providerId: pid };
    }
  }
  throw new Error(lastReason ?? 'no provider available');
}

/* streaming call: OpenAI-compatible SSE. Emits deltas via onDelta; accumulates tool_calls + usage. */
async function callUpstreamStream(messages, model, onNotice, mode, onDelta, abortSignal, mcpTools, workspace, onReasoning) {
  const sysPrompt = { role: 'system', content: buildSystemPrompt(mode ?? 'code', workspace) };
  const hasSystem = messages.some((m) => m.role === 'system');
  const full = hasSystem ? messages : [sysPrompt, ...messages];
  const { res, providerId } = await callUpstreamFallback(
    { messages: full, tools: toolDefs(mode ?? 'code', mcpTools), stream: true, temperature: 0.6 }, model, onNotice, abortSignal);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`upstream ${res.status}: ${t.slice(0, 160)}`);
  }
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
      if (delta.reasoning) onReasoning?.(delta.reasoning); // qwen3-style thinking tokens
      if (delta.content) { content += delta.content; onDelta?.(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        toolCalls[i] ??= { id: tc.id ?? `call_${i}_${Date.now()}`, name: '', argsStr: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].argsStr += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean).map((t) => ({ id: t.id, name: t.name, args: t.argsStr })), usage, providerId };
}


/* ════ SYSTEM PROMPTS ════ */
function rulesPath(workspace) { return path.join(workspace ?? currentWorkspace ?? '', '.forge', 'RULES.md'); }
function loadRules(workspace) {
  try { return fs.readFileSync(rulesPath(workspace), 'utf8').slice(0, 4000); } catch { return ''; }
}
function workspaceTree(workspace, max = 60) {
  try {
    const out = [];
    const walk = (d, prefix, depth) => {
      if (depth > 2 || out.length >= max) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target'].includes(e.name) || e.name.startsWith('.')) continue;
        out.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + '/', depth + 1);
      }
    };
    walk(workspace, '', 0);
    return out.join('\n');
  } catch { return ''; }
}
function buildSystemPrompt(mode, workspace) {
  const rules = loadRules(workspace);
  const tree = workspaceTree(workspace);
  const base = `You are ForgeStudio's coding agent working inside the user's local project.
Workspace file tree:
${tree || '(empty)'}

Rules for the user's project (.forge/RULES.md)${rules ? ':' : ': (none yet)'}
${rules || '(none)'}

Guidelines:
- ALWAYS read a file (read_file) before editing it.
- Prefer edit_file (exact string replacement) over write_file for existing files — cheaper and safer.
- To make any change you MUST call edit_file/write_file. NEVER describe an edit in prose instead of calling the tool.
- Start your reply with the direct answer. No preamble, no restating the task.
- Keep edits minimal and focused: one logical change per call.
- After making changes, suggest or run a verification command (tests / build / lint) when one exists.
- Be concise in prose. Code speaks.
- If a task is ambiguous, make a reasonable choice and state it in one line.`;
  if (mode === 'ask') return base + '\nYou are in ASK mode: use read-only tools only (read_file, list_dir, grep). Explain, do not modify.';
  if (mode === 'auto') return base + '\nYou are in AUTO mode: write_file/edit_file apply immediately (checkpoints are kept so the user can undo). run_command is available — use it to verify your work. Still confirm destructive actions with the user.';
  return base + '\nYou are in CODE mode: write_file/edit_file are STAGED as diffs for user review — do not claim a change is applied until the user keeps it. State clearly what you staged.';
}

/* ════ SELF-VERIFICATION ════ */
function detectVerifyCommand(workspace) {
  try {
    if (fs.existsSync(path.join(workspace, 'package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
      const scripts = pkg.scripts ?? {};
      for (const key of ['test', 'lint', 'build']) {
        if (scripts[key]) return { cmd: `npm run ${key}${key === 'test' ? ' -- --silent' : ''}`, label: `npm run ${key}` };
      }
    }
  } catch {}
  try {
    const pub = fs.readFileSync(path.join(workspace, 'pubspec.yaml'), 'utf8');
    return { cmd: pub.includes('sdk: flutter') ? 'flutter analyze' : 'dart analyze', label: 'analyzer' };
  } catch {}
  try {
    if (fs.existsSync(path.join(workspace, 'go.mod'))) return { cmd: 'go build ./...', label: 'go build' };
    if (fs.existsSync(path.join(workspace, 'Cargo.toml'))) return { cmd: 'cargo check', label: 'cargo check' };
    if (fs.existsSync(path.join(workspace, 'requirements.txt')) || fs.existsSync(path.join(workspace, 'pyproject.toml'))) return { cmd: 'python3 -m pytest --tb=short -q', label: 'pytest' };
  } catch {}
  return null;
}
function runVerify(workspace, timeout = 120_000) {
  const v = detectVerifyCommand(workspace);
  if (!v) return null;
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(v.cmd, { cwd: workspace, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ...v, ok: true, output: out.slice(0, 3000) };
  } catch (e) {
    return { ...v, ok: false, output: String(e.stderr ?? e.stdout ?? e.message).slice(0, 3000) };
  }
}

/* MCP tool execution: real tools/call over stdio */
async function mcpCallTool(serverEntry, toolName, argsJson) {
  return new Promise((resolve) => {
    const proc = spawn(serverEntry.cmd, [], { shell: true });
    let buf = '';
    const send = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} };
    const done = (out) => { try { proc.kill(); } catch {} resolve(out); };
    const timer = setTimeout(() => done('mcp tool timeout (30s)'), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: argsJson } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          const c = msg.result?.content;
          done(c ? c.map((x) => x.text ?? JSON.stringify(x)).join('\n') : JSON.stringify(msg.result ?? msg.error ?? {}));
        }
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => { clearTimeout(timer); done(`mcp spawn error: ${e.message}`); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'forgegateway', version: '0.4' } } });
  });
}
/* mcp tool names arrive namespaced: mcp__<server>__<tool> */
function mcpToolMap() {
  const map = {};
  for (const s of loadMcp()) {
    for (const t of s.tools ?? []) map[`mcp__${s.name}__${t.name}`] = { server: s, tool: t.name };
  }
  return map;
}

/* session compaction: summarize old turns when near the context window */
function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}
async function compactIfNeeded(session, sendEvent) {
  const [pid] = (session.model ?? '').split('/');
  const windows = { ollama: 28_000, lmstudio: 28_000, gemini: 900_000, groq: 120_000, cerebras: 120_000, openrouter: 120_000, zai: 120_000 };
  const limit = windows[pid] ?? 100_000;
  if (estimateTokens(session.messages) < limit * 0.7) return;
  const keep = 6; // recent messages kept verbatim
  const old = session.messages.slice(0, -keep);
  if (old.length < 4) return;
  try {
    const res = await callUpstreamFallback({
      messages: [
        { role: 'system', content: 'Summarize this coding conversation compactly: what was done, files changed, decisions, open items. Max 250 words.' },
        { role: 'user', content: old.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n---\n').slice(0, 40_000) },
      ], stream: false, temperature: 0.2,
    }, session.model, null);
    if (!res.res.ok) return;
    const data = await res.res.json();
    const summary = data.choices?.[0]?.message?.content ?? '';
    if (!summary) return;
    session.messages = [
      { role: 'user', content: '[Conversation summary of earlier turns]\n' + summary },
      ...session.messages.slice(-keep),
    ];
    sendEvent({ type: 'notice', payload: `📚 context compacted — ${old.length} older messages summarized` });
    logEvent('compact', session.id);
  } catch { /* compaction is best-effort */ }
}

async function runAgent(session, sendEvent, abortSignal) {
  const MAX_ITER = 12;
  // git: snapshot before the run so any damage is revertable
  if ((session.mode ?? 'code') !== 'ask') gitSnapshot(session.workspace, `before run (${session.model})`);
  const runTouched = new Map(); // path -> original (for the run-level checkpoint)
  let verifyRounds = 0;
  const mcpMap = mcpToolMap();
  const mcpTools = Object.entries(mcpMap).map(([full, m]) => ({
    type: 'function',
    function: { name: full, description: m.server.tools?.find((t) => t.name === m.tool)?.description || `MCP tool ${m.tool} from ${m.server.name}`, parameters: { type: 'object' } },
  }));
  session.usage ??= { prompt_tokens: 0, completion_tokens: 0 };
  await compactIfNeeded(session, sendEvent);
  for (let i = 0; i < MAX_ITER; i++) {
    if (abortSignal?.aborted) { sendEvent({ type: 'done', payload: { stopped: true } }); return { sessionId: session.id, stopped: true }; }
    const stepStart = Date.now();
    sendEvent({ type: 'step-start', payload: { step: i } });
    let r;
    try {
      r = await callUpstreamStream(session.messages, session.model,
        (msg) => { sendEvent({ type: 'notice', payload: msg }); sendEvent({ type: 'status', payload: msg }); },
        session.mode ?? 'code',
        (delta) => sendEvent({ type: 'text-delta', payload: delta }),
        abortSignal, mcpTools, session.workspace,
        (r) => sendEvent({ type: 'thinking-delta', payload: r }));
    } catch (err) {
      sendEvent({ type: 'step-end', payload: { step: i, ms: Date.now() - stepStart } });
      const aborted = err.message === '__aborted__';
      sendEvent({ type: 'done', payload: aborted ? { stopped: true } : { error: err.message } });
      return { sessionId: session.id, stopped: aborted, error: aborted ? undefined : err.message };
    }
    if (r.content) {
      session.messages.push({ role: 'assistant', content: r.content });
    }
    if (r.usage) {
      session.usage.prompt_tokens += r.usage.prompt_tokens ?? 0;
      session.usage.completion_tokens += r.usage.completion_tokens ?? 0;
      sendEvent({ type: 'usage', payload: session.usage });
    }
    sendEvent({ type: 'step-end', payload: { step: i, ms: Date.now() - stepStart } });
    // tool-call recovery: small open models sometimes emit tool arguments as prose JSON.
    // since everything is staged/reviewable, converting it is safe and keeps weak models useful.
    if (!r.toolCalls.length && (session.mode ?? 'code') !== 'ask' && /\{[\s\S]*"path"[\s\S]*\}/.test(r.content ?? '')) {
      try {
        const m = (r.content ?? '').match(/\{[\s\S]*?"path"[\s\S]*?\}/);
        const obj = JSON.parse(m[0]);
        let rescue = null;
        if (obj.path && obj.old_str !== undefined && obj.new_str !== undefined) {
          const abs = path.join(session.workspace, obj.path);
          try {
            const orig = fs.readFileSync(abs, 'utf8');
            const n = orig.split(obj.old_str).length - 1;
            if (n === 1) rescue = { id: `rescue_${i}`, name: 'edit_file', args: JSON.stringify(obj) };
          } catch {}
        } else if (obj.path && obj.content !== undefined && (obj.content.length > 80)) {
          rescue = { id: `rescue_${i}`, name: 'write_file', args: JSON.stringify({ path: obj.path, content: obj.content }) };
        }
        if (rescue) {
          r.toolCalls.push(rescue);
          sendEvent({ type: 'notice', payload: 'ℹ️ converted a described edit into a staged change (tool-recovery)' });
        }
      } catch { /* not valid JSON — leave as prose */ }
    }
    if (!r.toolCalls.length) {
      // self-verification: if this run staged/applied writes, verify and let the agent fix failures
      const wrote = r.toolCalls.length === 0 && (runTouched.size > 0 || session.pending.some((d) => d.status !== 'applied')) && verifyRounds < 2;
      if (wrote) {
        verifyRounds++;
        const v = runVerify(session.workspace);
        if (v) {
          sendEvent({ type: 'notice', payload: v.ok ? `✓ ${v.label} passed` : `✗ ${v.label} failed — agent is fixing…` });
          sendEvent({ type: 'tool-start', payload: { name: 'verify', detail: v.label } });
          session.messages.push({ role: 'assistant', content: r.content ?? '', tool_calls: [{ id: `verify_${i}`, type: 'function', function: { name: 'verify', arguments: '{}' } }] });
          session.messages.push({ role: 'tool', tool_call_id: `verify_${i}`, name: 'verify', content: v.ok ? `${v.label} PASSED:\n${v.output}` : `${v.label} FAILED — fix the errors:\n${v.output}` });
          sendEvent({ type: 'tool-end', payload: { name: 'verify', ms: 0, output: v.output.slice(0, 500) } });
          continue; // next iteration with verification results in context
        }
      }
      break;
    }

    // assistant message must carry tool_calls for API validity
    session.messages.push({
      role: 'assistant',
      content: r.content ?? '',
      tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })),
    });

    for (const tc of r.toolCalls) {
      if (abortSignal?.aborted) break;
      let args = {};
      try { args = JSON.parse(tc.args || '{}'); } catch {}
      const name = tc.name;
      const toolStart = Date.now();
      sendEvent({ type: 'tool-start', payload: { name, detail: JSON.stringify(args).slice(0, 200) } });

      let result = '';
      if (name === 'read_file') {
        try {
          const full = fs.readFileSync(path.join(session.workspace, args.path), 'utf8');
          const cap = 16_000;
          result = full.length > cap ? full.slice(0, cap) + `\n\n[file truncated: ${full.length - cap} more chars — read specific sections with edit-based tools or grep]` : full;
        } catch (e) { result = `error: ${e.message}`; }
      } else if (name === 'list_dir') {
        try {
          result = fs.readdirSync(path.join(session.workspace, args.path ?? '.'), { withFileTypes: true })
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
        } catch (e) { result = `error: ${e.message}`; }
      } else if (name === 'grep') {
        try {
          const re = new RegExp(args.pattern, 'i');
          const hits = [];
          const walk = (d, depth) => {
            if (depth > 5 || hits.length >= 40) return;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target'].includes(e.name) || e.name.startsWith('.')) continue;
              const full = path.join(d, e.name);
              if (e.isDirectory()) walk(full, depth + 1);
              else {
                try {
                  const lines = fs.readFileSync(full, 'utf8').split('\n');
                  lines.forEach((l, li) => { if (re.test(l) && hits.length < 40) hits.push(`${path.relative(session.workspace, full)}:${li + 1}: ${l.trim().slice(0, 160)}`); });
                } catch {}
              }
            }
          };
          walk(session.workspace, 0);
          result = hits.length ? hits.join('\n') : 'no matches';
        } catch (e) { result = `error: ${e.message}`; }
      } else if (name === 'run_command' && (session.mode ?? 'code') === 'auto') {
        if (CMD_BLOCK.some((re) => re.test(args.cmd ?? ''))) {
          result = `BLOCKED: command matches the dangerous-command blocklist. Ask the user to run it manually.`;
          sendEvent({ type: 'notice', payload: `🛡 blocked dangerous command: ${String(args.cmd).slice(0, 60)}` });
        } else {
          try {
            const { execSync } = require('node:child_process');
            result = execSync(args.cmd, { cwd: session.workspace, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).slice(0, 4000);
          } catch (e) { result = `error: ${String(e.stderr ?? e.message).slice(0, 1000)}`; }
        }
      } else if (name === 'write_file' || name === 'edit_file') {
        const abs = path.join(session.workspace, args.path);
        let original = null;
        try { original = fs.readFileSync(abs, 'utf8'); } catch { original = null; }
        let updated;
        if (name === 'write_file') updated = args.content;
        else {
          if (original === null) { result = `error: ${args.path} does not exist — use write_file to create it`; sendEvent({ type: 'tool-end', payload: { name, ms: Date.now() - toolStart } }); continue; }
          if (!original.includes(args.old_str)) { result = `error: old_str not found in ${args.path}. Read the file first and copy the exact text.`; sendEvent({ type: 'tool-end', payload: { name, ms: Date.now() - toolStart } }); continue; }
          if (original.split(args.old_str).length - 1 > 1) { result = `error: old_str appears ${original.split(args.old_str).length - 1} times — include more surrounding context to make it unique.`; sendEvent({ type: 'tool-end', payload: { name, ms: Date.now() - toolStart } }); continue; }
          updated = original.replace(args.old_str, args.new_str);
        }
        if ((session.mode ?? 'code') === 'auto') {
          if (!runTouched.has(args.path)) runTouched.set(args.path, original);
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, updated);
            result = `written (checkpoint saved — undo available)`;
            sendEvent({ type: 'auto-applied', payload: { path: args.path } });
          } catch (e) { result = `error: ${e.message}`; }
        } else {
          const pending = { path: args.path, kind: original === null ? 'new' : 'mod', original, updated, workspace: session.workspace };
          session.pending.push(pending);
          sendEvent({ type: 'diff', payload: pending });
          result = `staged for review in the Diffs pane (not written yet)`;
        }
      } else if (mcpMap[name]) {
        result = await mcpCallTool(mcpMap[name].server, mcpMap[name].tool, args);
      } else {
        result = `unknown tool ${name}`;
      }

      session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result });
      sendEvent({ type: 'tool-end', payload: { name, ms: Date.now() - toolStart, output: String(result).slice(0, 2000) } });
    }
    saveSession(session);
  }
  saveSession(session);
  if (runTouched.size) checkpointRun(session.workspace, [...runTouched.entries()].map(([p, o]) => ({ path: p, original: o })));
  sendEvent({ type: 'done', payload: {} });
  // macOS notification when the window isn't focused
  if (win && !win.isFocused()) {
    try {
      const { Notification } = require('electron');
      new Notification({ title: 'ForgeStudio', body: `Agent finished — ${session.title.slice(0, 60)}` }).show();
    } catch {}
  }
  return { sessionId: session.id };
}

/* ════ GATEWAY SERVER (v0.2, unchanged surface) ════ */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  });
}
async function callUpstreamPlain(body) {
  const { providerId } = resolveModel(body.model ?? 'gemini/gemini-flash-latest');
  const { res } = await callUpstreamFallback({ stream: false, temperature: 0.6, ...body }, body.model, null);
  return res;
}
function chargeCredits(plan, model) {
  const { providerId } = resolveModel(model);
  if (PROVIDERS[providerId]?.local) return { ok: true, cost: 0 }; // local models: 0 credits
  const p = CONFIG.plans[plan] ?? CONFIG.plans[CONFIG.defaultPlan];
  const cost = MODEL_MULTIPLIER[model] ?? 1;
  const u = ledger.usage[plan] ?? { week: 0, creditsUsed: 0, requests: 0 };
  u.week += 1; u.requests += 1; u.creditsUsed += cost;
  ledger.usage[plan] = u;
  saveLedger();
  if (u.creditsUsed > p.credits) return { ok: false, reason: 'monthly credit allowance exhausted' };
  if (u.week > p.weeklyLimit) return { ok: false, reason: 'weekly request limit reached' };
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONFIG.port}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const auth = (() => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token === CONFIG.masterKey) return { plan: CONFIG.defaultPlan, tokenKey: 'master' };
    try {
      const [b64, sig] = token.split('.');
      if (!b64 || !sig) return null;
      const expected = crypto.createHmac('sha256', CONFIG.masterKey).update(b64).digest('base64url');
      const a = crypto.createHash('sha256').update(sig).digest();
      const b = crypto.createHash('sha256').update(expected).digest();
      if (!crypto.timingSafeEqual(a, b)) return null;
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
      if (Date.now() > payload.exp) return null;
      return { plan: payload.plan, tokenKey: token.slice(0, 24) };
    } catch { return null; }
  })();

  if (req.method === 'POST' && url.pathname === '/token') {
    const body = await readBody(req);
    if (body?.masterKey !== CONFIG.masterKey) { res.writeHead(401); res.end(JSON.stringify({ error: 'invalid master key' })); return; }
    const plan = body?.plan ?? CONFIG.defaultPlan;
    const expiresAt = Date.now() + 1800 * 1000;
    const b64 = Buffer.from(JSON.stringify({ plan, exp: expiresAt })).toString('base64url');
    const sig = crypto.createHmac('sha256', CONFIG.masterKey).update(b64).digest('base64url');
    logEvent('token', `minted ${plan} session`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: `${b64}.${sig}`, expires_at: new Date(expiresAt).toISOString(), plan }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'invalid or expired session token' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const all = Object.entries(PROVIDERS).flatMap(([pid, p]) =>
      p.models.map((m) => ({ id: `${pid}/${m.id}`, object: 'model', owned_by: pid })));
    res.end(JSON.stringify({ object: 'list', data: all }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!auth) { logEvent('deny', 'invalid or expired session token'); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid or expired session token' } })); return; }
    const body = await readBody(req);
    const model = body.model ?? CONFIG.upstream.defaultModel;
    const charge = chargeCredits(auth.plan, model);
    if (!charge.ok) { logEvent('deny', charge.reason); res.writeHead(402, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: charge.reason } })); return; }
    try {
      const up = await callUpstreamPlain(body);
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') ?? 'application/json' });
      const reader = up.body?.getReader();
      if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } }
      res.end();
      logEvent('req', `${model} · plan ${auth.plan}`);
    } catch (err) {
      logEvent('error', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/usage') {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'invalid session token' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ plan: auth.plan, ...(ledger.usage[auth.plan] ?? { week: 0, creditsUsed: 0, requests: 0 }), limits: CONFIG.plans[auth.plan], weekStarted: ledger.weekStarted }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
});


/* ════ PREVIEW SERVER (serves the workspace for the Preview pane) ════ */
const previewServer = http.createServer((req, res) => {
  const w = currentWorkspace;
  if (!w) { res.writeHead(503); res.end('no workspace'); return; }
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const abs = path.join(w, rel);
  if (!abs.startsWith(w)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for unknown routes
      fs.readFile(path.join(w, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('not found'); }
        else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2); }
      });
      return;
    }
    const ext = path.extname(abs);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
});
ipcMain.handle('studio:previewStart', async (_e, ws) => {
  currentWorkspace = ws ?? currentWorkspace;
  if (previewServer.listening) return { ok: true, port: 4185 };
  await new Promise((r) => previewServer.listen(4185, '127.0.0.1', r));
  logEvent('preview', `serving ${currentWorkspace} on :4185`);
  return { ok: true, port: 4185 };
});
ipcMain.handle('studio:previewStop', () => { try { previewServer.close(); } catch {} return true; });

/* scripted UI scenarios for documentation screenshots (ui/scenarios/*.js) */
async function runScenario(wc, name) {
  const hasHook = await wc.executeJavaScript('typeof window.__forge');
  console.log('hook:', hasHook);
  // step-by-step boot for diagnosability
  const F = 'window.__forge';
  const steps = [
    [`${F}.state.workspace = '/Users/airtechsolutions/Downloads/forge-demo'; 'ok1'`],
    [`${F}.updateWorkspaceUi(); 'ok2'`],
    [`await ${F}.initTree(); 'ok3'`],
    [`${F}.state.model = (await window.studio.getModels())[0]?.id ?? ${F}.state.model; ${F}.renderModelButton(); 'ok4'`],
  ];
  for (const [code] of steps) {
    try { await wc.executeJavaScript(`(async () => { ${code} })()`, true); }
    catch (e) { console.log('boot step failed:', code.slice(0, 40), '→', String(e.message).slice(0, 200)); }
  }
  const file = path.join(__dirname, 'ui', 'scenarios', `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`unknown scenario ${name}`);
  const code = fs.readFileSync(file, 'utf8');
  const wrapped = `(async () => { try { ${code} } catch (err) { return 'SCENARIO_ERR: ' + (err && err.message); } })()`;
  const out = await wc.executeJavaScript(wrapped, true);
  if (String(out).startsWith('SCENARIO_ERR')) console.log('scenario error:', out);
}
/* ════ WINDOW + IPC ════ */
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1100, minHeight: 680,
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, '..', 'build', 'app.icns'),
    backgroundColor: '#0B0C0F',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  void win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // debug capture hook: FORGE_CAPTURE=path.png (+ optional FORGE_SCENARIO) screenshots the UI
  if (process.env.FORGE_CAPTURE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        if (process.env.FORGE_SCENARIO) {
          currentWorkspace = '/Users/airtechsolutions/Downloads/forge-demo';
          await runScenario(win.webContents, process.env.FORGE_SCENARIO);
        }
        await new Promise((r) => setTimeout(r, 2600));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.FORGE_CAPTURE, img.toPNG());
        console.log('captured', process.env.FORGE_SCENARIO ?? 'plain', '→', process.env.FORGE_CAPTURE);
        if (process.env.FORGE_SCENARIO) app.quit();
      } catch (e) { console.log('capture failed', e.message); }
    }, 5000));
  }
}

app.whenReady().then(() => {
  loadLedger();
  loadKeys();
  loadSettings();
  if (settings.workspace) currentWorkspace = settings.workspace;
  void scanLocalProviders();
  void new Promise((r) => server.listen(CONFIG.port, '127.0.0.1', r));
  logEvent('boot', `gateway on :${CONFIG.port} · ForgeStudio ready`);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('gw:getState', () => ({
  running: server.listening, port: CONFIG.port,
  upstream: { url: CONFIG.upstream.baseUrl, model: CONFIG.upstream.defaultModel, hasKey: !!CONFIG.upstream.apiKey },
  masterKey: CONFIG.masterKey, plans: CONFIG.plans, usage: ledger.usage, events,
}));
ipcMain.handle('gw:saveConfig', (_e, patch) => {
  if (patch?.upstreamKey !== undefined) CONFIG.upstream.apiKey = patch.upstreamKey;
  if (patch?.upstreamUrl !== undefined) CONFIG.upstream.baseUrl = patch.upstreamUrl;
  if (patch?.model !== undefined) CONFIG.upstream.defaultModel = patch.model;
  logEvent('config', 'settings updated');
  return true;
});
ipcMain.handle('gw:mintToken', (_e, plan) => {
  const expiresAt = Date.now() + 1800 * 1000;
  const b64 = Buffer.from(JSON.stringify({ plan, exp: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', CONFIG.masterKey).update(b64).digest('base64url');
  logEvent('token', `minted ${plan} from dashboard`);
  return { token: `${b64}.${sig}`, expiresAt: new Date(expiresAt).toISOString() };
});
ipcMain.handle('gw:testUpstream', async () => {
  try {
    const r = await callUpstreamPlain({ model: CONFIG.upstream.defaultModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
    logEvent('test', `upstream ${r.ok ? 'reachable ✓' : `error ${r.status}`}`);
    return { ok: r.ok, status: r.status };
  } catch (err) { logEvent('test', err.message); return { ok: false, error: err.message }; }
});

/* studio IPC */
ipcMain.handle('studio:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle('studio:fileTree', (_e, dir) => {
  try {
    const walk = (d, depth) => {
      if (depth > 3) return [];
      return fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => !['node_modules', '.git', 'dist', 'build'].includes(e.name) && !e.name.startsWith('.'))
        .flatMap((e) => {
          const full = path.join(d, e.name);
          if (e.isDirectory()) return [{ name: e.name, dir: true, children: walk(full, depth + 1) }];
          return [{ name: e.name, dir: false, path: full }];
        });
    };
    return walk(dir, 0);
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('studio:readFile', (_e, abs) => {
  try { return fs.readFileSync(abs, 'utf8'); } catch (err) { return null; }
});
ipcMain.handle('studio:getModels', () => allModels());
ipcMain.handle('studio:getProviders', () => Object.entries(PROVIDERS).map(([id, p]) => ({
  id, label: p.label, baseUrl: p.baseUrl, keyHint: p.keyHint, hasKey: !!providerKeys[id] || p.local, local: !!p.local,
  online: p.local ? !!p.online : undefined, models: p.models,
})));
ipcMain.handle('studio:scanLocal', async () => { await scanLocalProviders(true); return allModels(); });
ipcMain.handle('studio:testProvider', async (_e, pid) => {
  try {
    const p = PROVIDERS[pid];
    if (p.local) {
      await scanLocalProviders(true);
      return { ok: !!p.online, detail: p.online ? `${p.models.length} models` : 'not running' };
    }
    const r = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST', headers: providerHeaders(pid, providerKeys[pid] ?? ''),
      body: JSON.stringify({ model: p.models[0]?.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, detail: r.ok ? 'connected' : `error ${r.status}` };
  } catch (err) { return { ok: false, detail: String(err.message).slice(0, 80) }; }
});

/* settings persistence */
const settingsFile = () => path.join(userData(), 'settings.json');
let settings = {};
function loadSettings() { try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; } }
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch {} }
ipcMain.handle('studio:getSettings', () => settings);
ipcMain.handle('studio:setSettings', (_e, patch) => {
  settings = { ...settings, ...patch };
  if (patch.workspace !== undefined) currentWorkspace = patch.workspace;
  saveSettings();
  return true;
});

/* project-wide grep for agent + UI */
ipcMain.handle('studio:grep', (_e, pattern) => {
  try {
    const re = new RegExp(pattern, 'i');
    const hits = [];
    const walk = (d, depth) => {
      if (depth > 5 || hits.length >= 60) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target'].includes(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          try {
            const lines = fs.readFileSync(full, 'utf8').split('\n');
            lines.forEach((l, li) => { if (re.test(l) && hits.length < 60) hits.push(`${path.relative(currentWorkspace ?? d, full)}:${li + 1}:${l.trim().slice(0, 160)}`); });
          } catch {}
        }
      }
    };
    walk(currentWorkspace ?? app.getPath('home'), 0);
    return hits;
  } catch (err) { return { error: err.message }; }
});

/* lazy per-directory listing for big repos */
ipcMain.handle('studio:listDir', (_e, dir) => {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target'].includes(e.name) && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.join(dir, e.name) }));
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return entries;
  } catch (err) { return { error: err.message }; }
});

/* sessions: rename + delete */
ipcMain.handle('studio:renameSession', (_e, { id, title }) => {
  try {
    const f = path.join(sessionsDir(), `${id}.json`);
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    s.title = title;
    fs.writeFileSync(f, JSON.stringify(s));
    return true;
  } catch { return false; }
});
ipcMain.handle('studio:deleteSession', (_e, id) => {
  try { fs.unlinkSync(path.join(sessionsDir(), `${id}.json`)); return true; } catch { return false; }
});

/* undo last checkpoint */
ipcMain.handle('studio:undoCheckpoint', () => {
  try {
    const root = path.join(userData(), 'checkpoints');
    const dirs = fs.readdirSync(root).sort((a, b) => Number(b) - Number(a));
    if (!dirs.length) return { ok: false, detail: 'no checkpoints yet' };
    const dir = path.join(root, dirs[0]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    for (const f of meta.files) {
      const abs = path.join(meta.workspace, f.path);
      if (f.hadContent) fs.copyFileSync(path.join(dir, path.basename(f.path)), abs);
      else { try { fs.unlinkSync(abs); } catch {} }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    logEvent('undo', `restored ${meta.files.map((f) => f.path).join(', ')}`);
    return { ok: true, detail: meta.files.map((f) => f.path).join(', ') };
  } catch (err) { return { ok: false, detail: err.message };
  }
});
ipcMain.handle('studio:setProviderKey', (_e, { provider, key }) => {
  providerKeys[provider] = key;
  saveKeys();
  logEvent('config', `${provider} key saved`);
  return true;
});
ipcMain.handle('studio:listSessions', () => listSessions());
ipcMain.handle('studio:listMcp', () => loadMcp());
ipcMain.handle('studio:addMcp', async (_e, entry) => {
  const list = loadMcp();
  list.push({ name: entry.name, cmd: entry.cmd, status: 'checking…', tools: [] });
  saveMcp(list);
  const tools = await mcpListTools(entry);
  list[list.length - 1].status = `${tools.length} tools`;
  list[list.length - 1].tools = tools;
  saveMcp(list);
  logEvent('mcp', `${entry.name}: ${tools.length} tools`);
  return true;
});
ipcMain.handle('studio:removeMcp', (_e, i) => {
  const list = loadMcp();
  list.splice(i, 1);
  saveMcp(list);
  return true;
});
ipcMain.handle('studio:resumeSession', (_e, id) => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${id}.json`), 'utf8'));
    logEvent('session', `resumed "${s.title}"`);
    return s;
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('studio:applyDiff', (_e, diff) => {
  const abs = path.join(diff.workspace, diff.path);
  try {
    let original = null;
    try { original = fs.readFileSync(abs, 'utf8'); } catch {}
    checkpointRun(diff.workspace, [{ path: diff.path, original }]);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, diff.updated);
    logEvent('apply', diff.path);
    return true;
  } catch (err) { logEvent('error', `apply ${diff.path}: ${err.message}`); return false; }
});
/* agent run: main owns the message history (incl. tool calls); renderer only sends the new prompt */
const runningAgents = new Map(); // sessionId -> AbortController
ipcMain.handle('studio:runAgent', (_e, { sessionId, prompt, model, mode, images }) => {
  return new Promise((resolve) => {
    (async () => {
      let session;
      if (sessionId) {
        try { session = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${sessionId}.json`), 'utf8')); }
        catch { session = null; }
      }
      if (!session) {
        session = {
          id: crypto.randomUUID(),
          title: (prompt ?? 'chat').slice(0, 50),
          created: Date.now(), updated: Date.now(),
          workspace: currentWorkspace ?? app.getPath('home'),
          model: model ?? 'gemini/gemini-flash-latest',
          mode: mode ?? 'code',
          messages: [], usage: { prompt_tokens: 0, completion_tokens: 0 },
          pending: [],
        };
      }
      session.model = model ?? session.model;
      session.mode = mode ?? session.mode ?? 'code';
      session.updated = Date.now();
      if (prompt) {
        if (images?.length) {
          // multimodal: content array with image parts (Ollama + Gemini understand image_url)
          session.messages.push({
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          });
        } else {
          session.messages.push({ role: 'user', content: prompt });
        }
      }
      const ac = new AbortController();
      runningAgents.set(session.id, ac);
      const sendEvent = (e) => { try { win?.webContents.send('studio:agent-event', e); } catch {} };
      const result = await runAgent(session, sendEvent, ac.signal);
      runningAgents.delete(session.id);
      saveSession(session);
      // renderer-visible history: user + assistant text (+ tool names for cards)
      const visible = session.messages.map((m) => {
        if (m.role === 'tool') return null;
        if (m.role === 'assistant') {
          return { role: 'assistant', content: m.content, tools: (m.tool_calls ?? []).map((t) => t.function.name) };
        }
        return { role: m.role, content: m.content };
      }).filter(Boolean);
      resolve({ ...result, messages: visible, usage: session.usage, title: session.title });
    })();
  });
});
ipcMain.handle('studio:stopAgent', (_e, sessionId) => {
  const ac = sessionId ? runningAgents.get(sessionId) : [...runningAgents.values()][0];
  if (ac) { ac.abort(); return true; }
  return false;
});

ipcMain.handle('studio:applyDiffs', (_e, diffs) => {
  try {
    const files = diffs.map((d) => {
      let original = null;
      try { original = fs.readFileSync(path.join(d.workspace, d.path), 'utf8'); } catch {}
      return { path: d.path, original };
    });
    checkpointRun(diffs[0]?.workspace ?? app.getPath('home'), files);
    for (const d of diffs) {
      const abs = path.join(d.workspace, d.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, d.updated);
      logEvent('apply', d.path);
    }
    return true;
  } catch (err) { logEvent('error', `batch apply: ${err.message}`); return false; }
});

/* checkpoints timeline */
ipcMain.handle('studio:listCheckpoints', () => {
  try {
    const root = path.join(userData(), 'checkpoints');
    return fs.readdirSync(root).map((d) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, d, 'meta.json'), 'utf8'));
        return { id: d, when: meta.when, workspace: meta.workspace, files: meta.files.map((f) => f.path) };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.when - a.when).slice(0, 30);
  } catch { return []; }
});
ipcMain.handle('studio:restoreCheckpoint', (_e, id) => {
  try {
    const dir = path.join(userData(), 'checkpoints', id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    for (const f of meta.files) {
      const abs = path.join(meta.workspace, f.path);
      if (f.hadContent) fs.copyFileSync(path.join(dir, path.basename(f.path)), abs);
      else { try { fs.unlinkSync(abs); } catch {} }
    }
    logEvent('undo', `restored ${meta.files.length} files from ${id}`);
    return { ok: true, detail: `${meta.files.length} files restored` };
  } catch (err) { return { ok: false, detail: err.message }; }
});

/* manual verification (Code mode: after Keep all) */
ipcMain.handle('studio:runVerify', (_e, ws) => {
  const v = runVerify(ws ?? currentWorkspace);
  if (!v) return { ok: null, detail: 'no verify command detected (no package.json/pubspec/go.mod/Cargo.toml/pytest)' };
  logEvent('verify', `${v.label}: ${v.ok ? 'PASSED' : 'FAILED'}`);
  return { ok: v.ok, label: v.label, output: v.output };
});

/* rules file */
ipcMain.handle('studio:getRules', (_e, ws) => loadRules(ws ?? currentWorkspace));
ipcMain.handle('studio:setRules', (_e, { ws, content }) => {
  const w = ws ?? currentWorkspace;
  fs.mkdirSync(path.join(w, '.forge'), { recursive: true });
  fs.writeFileSync(rulesPath(w), content);
  logEvent('rules', 'RULES.md updated');
  return true;
});

/* save attached image to workspace/.forge/attachments so the agent can reference it */
ipcMain.handle('studio:saveImage', (_e, { dataUrl, name }) => {
  try {
    const dir = path.join(currentWorkspace ?? app.getPath('home'), '.forge', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const b64 = dataUrl.split(',')[1];
    const file = `${name ?? 'image-' + Date.now()}.png`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'));
    return { ok: true, rel: `.forge/attachments/${file}` };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* recent workspaces */
ipcMain.handle('studio:listRecent', () => settings.recents ?? []);
ipcMain.handle('studio:pushRecent', (_e, ws) => {
  settings.recents = [ws, ...(settings.recents ?? []).filter((x) => x !== ws)].slice(0, 6);
  saveSettings();
  return true;
});

/* export chat as markdown */
ipcMain.handle('studio:exportSession', async (_e, id) => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${id}.json`), 'utf8'));
    const r = await dialog.showSaveDialog(win, {
      title: 'Export chat', defaultPath: `${(s.title || 'chat').replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const md = [`# ${s.title}`, `_${new Date(s.created).toLocaleString()} · ${s.model}_`, '',
      ...s.messages.map((m) => {
        if (m.role === 'user') return `## 👤 You\n\n${m.content}`;
        if (m.role === 'assistant') {
          const tools = (m.tool_calls ?? []).map((t) => `> 🔧 \`${t.function.name}\``).join('\n');
          return `${tools}\n\n## 🤖 Assistant\n\n${m.content}`;
        }
        return '';
      })].join('\n\n');
    fs.writeFileSync(r.filePath, md);
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});
