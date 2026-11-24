/**
 * ForgeGateway — Electron main process.
 * Runs the gateway server in-process + shows the dashboard window.
 * All state local; personal study app.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── config (same as gateway; state file lives in userData) ──
const CONFIG = {
  port: 4180,
  masterKey: 'forge-local-master',
  upstream: { baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: '', defaultModel: 'glm-5.3-flash' },
  sessionTokenTtlSec: 1800,
  plans: {
    study: { credits: 1000, sessionLimit: 100, weeklyLimit: 500, multiplier: 1 },
    heavy: { credits: 7000, sessionLimit: 300, weeklyLimit: 2000, multiplier: 1 },
  },
  defaultPlan: 'study',
};
const MODEL_MULTIPLIER = { 'glm-5.3-flash': 1, 'glm-5.3': 5 };

function nowWeek() { return Math.floor(Date.now() / (7 * 24 * 3600 * 1000)); }
const stateFile = () => path.join(app.getPath('userData'), 'gateway-state.json');
let ledger = { sessions: {}, usage: {}, weekStarted: nowWeek() };
function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (raw.weekStarted === nowWeek()) ledger = raw;
  } catch { /* fresh */ }
}
function saveLedger() {
  try { fs.writeFileSync(stateFile(), JSON.stringify(ledger)); } catch { /* ignore */ }
}
function resetWeekIfNeeded() {
  if (ledger.weekStarted !== nowWeek()) {
    ledger = { sessions: {}, usage: {}, weekStarted: nowWeek() };
    saveLedger();
  }
}

function mintSessionToken(plan) {
  const expiresAt = Date.now() + CONFIG.sessionTokenTtlSec * 1000;
  const b64 = Buffer.from(JSON.stringify({ plan, exp: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', CONFIG.masterKey).update(b64).digest('base64url');
  return { token: `${b64}.${sig}`, expiresAt };
}
function verifySessionToken(token) {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', CONFIG.masterKey).update(b64).digest('base64url');
  const a = crypto.createHash('sha256').update(sig).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (Date.now() > payload.exp) return null;
    return { plan: payload.plan };
  } catch { return null; }
}

function chargeCredits(plan, model) {
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

const events = []; // activity log for the dashboard
function logEvent(kind, detail) {
  events.unshift({ t: new Date().toLocaleTimeString(), kind, detail });
  if (events.length > 200) events.pop();
  try { win?.webContents.send('gw:event', { events }); } catch { /* window closed */ }
}

let win = null;

// ── gateway http server ──
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  });
}

async function callUpstream(body) {
  const upstreamBody = { ...body, model: body.model ?? CONFIG.upstream.defaultModel };
  return fetch(`${CONFIG.upstream.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.upstream.apiKey}` },
    body: JSON.stringify(upstreamBody),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONFIG.port}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && url.pathname === '/token') {
    const body = await readBody(req);
    if (body?.masterKey !== CONFIG.masterKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid master key' }));
      return;
    }
    const plan = body?.plan ?? CONFIG.defaultPlan;
    const minted = mintSessionToken(plan);
    logEvent('token', `minted ${plan} session (30 min)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: minted.token, expires_at: new Date(minted.expiresAt).toISOString(), token_type: 'bearer', plan }));
    return;
  }

  const auth = (() => {
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer /, '');
    if (token === CONFIG.masterKey) return { plan: CONFIG.defaultPlan, tokenKey: 'master' };
    const v = verifySessionToken(token);
    return v ? { plan: v.plan, tokenKey: token.slice(0, 24) } : null;
  })();

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (!auth) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid or expired session token' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: Object.keys(MODEL_MULTIPLIER).map((id) => ({ id, object: 'model', owned_by: 'forgegateway' })) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!auth) { logEvent('deny', 'invalid or expired session token'); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid or expired session token — mint a new one', type: 'gateway_error' } })); return; }
    const planCfg = CONFIG.plans[auth.plan] ?? CONFIG.plans[CONFIG.defaultPlan];
    const session = ledger.sessions[auth.tokenKey] ?? { tokens: [], requestsThisSession: 0 };
    session.requestsThisSession += 1;
    if (session.requestsThisSession > planCfg.sessionLimit) {
      logEvent('deny', 'session limit reached');
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'session request limit reached — mint a new session token' } }));
      return;
    }
    ledger.sessions[auth.tokenKey] = session;
    saveLedger();

    const body = await readBody(req);
    const model = body.model ?? CONFIG.upstream.defaultModel;
    const charge = chargeCredits(auth.plan, model);
    if (!charge.ok) {
      logEvent('deny', charge.reason ?? 'billing');
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: charge.reason } }));
      return;
    }

    try {
      const upstreamRes = await callUpstream(body);
      res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json' });
      const reader = upstreamRes.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      logEvent('req', `${model} · plan ${auth.plan} · req #${session.requestsThisSession}`);
    } catch (err) {
      logEvent('error', `upstream: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/usage') {
    if (!auth) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid or expired session token' } })); return; }
    resetWeekIfNeeded();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      plan: auth.plan,
      ...(ledger.usage[auth.plan] ?? { week: 0, creditsUsed: 0, requests: 0 }),
      limits: CONFIG.plans[auth.plan],
      weekStarted: ledger.weekStarted,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0E0F12',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  void win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  loadLedger();
  void new Promise((resolve) => server.listen(CONFIG.port, '127.0.0.1', resolve));
  logEvent('boot', `gateway on 127.0.0.1:${CONFIG.port}`);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC for the dashboard ──
ipcMain.handle('gw:getState', () => ({
  running: server.listening,
  port: CONFIG.port,
  upstream: { url: CONFIG.upstream.baseUrl, model: CONFIG.upstream.defaultModel, hasKey: !!CONFIG.upstream.apiKey },
  masterKey: CONFIG.masterKey,
  plans: CONFIG.plans,
  usage: ledger.usage,
  events,
}));
ipcMain.handle('gw:saveConfig', (_e, patch) => {
  if (patch?.upstreamKey !== undefined) CONFIG.upstream.apiKey = patch.upstreamKey;
  if (patch?.upstreamUrl !== undefined) CONFIG.upstream.baseUrl = patch.upstreamUrl;
  if (patch?.model !== undefined) CONFIG.upstream.defaultModel = patch.model;
  logEvent('config', 'upstream settings updated');
  return true;
});
ipcMain.handle('gw:mintToken', (_e, plan) => {
  const minted = mintSessionToken(plan);
  logEvent('token', `minted ${plan} session from dashboard`);
  return { token: minted.token, expiresAt: new Date(minted.expiresAt).toISOString() };
});
ipcMain.handle('gw:testUpstream', async () => {
  try {
    const res = await fetch(`${CONFIG.upstream.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.upstream.apiKey}` },
      body: JSON.stringify({ model: CONFIG.upstream.defaultModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 10 }),
    });
    const ok = res.ok;
    logEvent('test', `upstream ${ok ? 'reachable ✓' : `error ${res.status}`}`);
    return { ok, status: res.status };
  } catch (err) {
    logEvent('test', `upstream unreachable: ${err.message}`);
    return { ok: false, error: err.message };
  }
});
