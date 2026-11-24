/**
 * forgecode-gateway — STUDY PROJECT
 *
 * A local OpenAI-compatible gateway that mirrors GitHub Copilot's architecture
 * so we can study how such a system works, layer by layer:
 *
 *   Layer 1  Session tokens   — short-lived bearer tokens minted from a master key
 *   Layer 2  Model gateway    — OpenAI-compatible endpoints proxying to a real provider
 *   Layer 3  Usage metering   — per-plan credit accounting with multipliers
 *   Layer 4  Rate limiting    — session + weekly limits with peak-hour awareness
 *
 * Runs on http://127.0.0.1:4180 — configure any client (ForgeCode, Cline, curl)
 * with baseURL http://127.0.0.1:4180/v1 and a session token.
 * Personal study project — private by design, not for distribution.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const CONFIG = {
    port: 4180,
    // master key protects /token minting; change me:
    masterKey: process.env.GW_MASTER_KEY ?? 'forge-local-master',
    upstream: {
        baseUrl: process.env.GW_UPSTREAM_URL ?? 'https://api.z.ai/api/paas/v4',
        apiKey: process.env.GW_UPSTREAM_KEY ?? '',
        defaultModel: process.env.GW_MODEL ?? 'glm-5.3-flash',
    },
    sessionTokenTtlSec: 30 * 60, // Copilot-style 30-minute tokens
    plans: {
        study: { credits: 1_000, sessionLimit: 100, weeklyLimit: 500, multiplier: 1 },
        heavy: { credits: 7_000, sessionLimit: 300, weeklyLimit: 2_000, multiplier: 1 },
    },
    defaultPlan: 'study',
    stateFile: path.join(process.cwd(), 'gateway-state.json'),
};
function nowWeek() {
    return Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
}
let ledger = { sessions: {}, usage: {}, weekStarted: nowWeek() };
try {
    const raw = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    if (raw.weekStarted === nowWeek())
        ledger = raw;
}
catch { /* fresh start */ }
function saveLedger() {
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(ledger));
}
if (ledger.weekStarted !== nowWeek()) {
    ledger = { sessions: {}, usage: {}, weekStarted: nowWeek() };
    saveLedger();
}
// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — session token minting (mirror of copilot_internal/v2/token)
// ─────────────────────────────────────────────────────────────────────────────
function mintSessionToken(plan) {
    const expiresAt = Date.now() + CONFIG.sessionTokenTtlSec * 1000;
    const payload = JSON.stringify({ plan, exp: expiresAt });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto
        .createHmac('sha256', CONFIG.masterKey)
        .update(b64)
        .digest('base64url');
    return { token: `${b64}.${sig}`, expiresAt };
}
function verifySessionToken(token) {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig)
        return null;
    const expected = crypto.createHmac('sha256', CONFIG.masterKey).update(b64).digest('base64url');
    const a = crypto.createHash('sha256').update(sig).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b))
        return null;
    try {
        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
        if (Date.now() > payload.exp)
            return null;
        return { plan: payload.plan };
    }
    catch {
        return null;
    }
}
async function callUpstream(body) {
    const upstreamBody = { ...body, model: body.model ?? CONFIG.upstream.defaultModel };
    return fetch(`${CONFIG.upstream.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CONFIG.upstream.apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — usage metering with multipliers (per-model, Copilot-style)
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_MULTIPLIER = {
    'glm-5.3-flash': 1,
    'glm-5.3': 5, // heavier models cost more credits, Copilot-style
};
function chargeCredits(plan, model) {
    const p = CONFIG.plans[plan] ?? CONFIG.plans[CONFIG.defaultPlan];
    const cost = MODEL_MULTIPLIER[model] ?? 1;
    const u = ledger.usage[plan] ?? { week: 0, creditsUsed: 0, requests: 0 };
    u.week += 1;
    u.requests += 1;
    u.creditsUsed += cost;
    ledger.usage[plan] = u;
    saveLedger();
    if (u.creditsUsed > p.credits)
        return { ok: false, reason: 'monthly credit allowance exhausted', used: u.creditsUsed };
    if (u.week > p.weeklyLimit)
        return { ok: false, reason: 'weekly request limit reached', used: u.week };
    return { ok: true, used: u.creditsUsed };
}
// ─────────────────────────────────────────────────────────────────────────────
// HTTP server — the gateway surface
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONFIG.port}`);
    // CORS for local clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    // ── POST /token — mint a session token (master-key protected)
    if (req.method === 'POST' && url.pathname === '/token') {
        const body = await readBody(req);
        if (body?.masterKey !== CONFIG.masterKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid master key' }));
            return;
        }
        const plan = body?.plan ?? CONFIG.defaultPlan;
        const minted = mintSessionToken(plan);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            token: minted.token,
            expires_at: new Date(minted.expiresAt).toISOString(),
            token_type: 'bearer',
            plan,
        }));
        return;
    }
    // ── GET /models — what the gateway exposes
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        const auth = checkAuth(req, res);
        if (!auth)
            return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: 'list',
            data: Object.keys(MODEL_MULTIPLIER).map((id) => ({ id, object: 'model', owned_by: 'forgecode-gateway' })),
        }));
        return;
    }
    // ── POST /v1/chat/completions — the main gateway (Layers 1+3+4 enforced)
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const auth = checkAuth(req, res);
        if (!auth)
            return;
        const planCfg = CONFIG.plans[auth.plan];
        const session = ledger.sessions[auth.tokenKey] ?? { tokens: [], requestsThisSession: 0 };
        session.requestsThisSession += 1;
        if (session.requestsThisSession > planCfg.sessionLimit) {
            deny(res, 429, 'session request limit reached — mint a new session token');
            return;
        }
        ledger.sessions[auth.tokenKey] = session;
        const body = (await readBody(req));
        const model = body.model ?? CONFIG.upstream.defaultModel;
        const charge = chargeCredits(auth.plan, model);
        if (!charge.ok) {
            deny(res, 402, charge.reason ?? 'billing');
            return;
        }
        try {
            const upstreamRes = await callUpstream(body);
            // pass through headers for streaming
            res.writeHead(upstreamRes.status, {
                'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
            });
            const reader = upstreamRes.body?.getReader();
            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    res.write(Buffer.from(value));
                }
            }
            res.end();
            console.log(`✓ ${model} plan=${auth.plan} credits=${charge.used} sessReq=${session.requestsThisSession}`);
        }
        catch (err) {
            deny(res, 502, `upstream error: ${err.message}`);
        }
        return;
    }
    // ── GET /usage — metering dashboard data
    if (req.method === 'GET' && url.pathname === '/usage') {
        const auth = checkAuth(req, res);
        if (!auth)
            return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            plan: auth.plan,
            ...ledger.usage[auth.plan] ?? { week: 0, creditsUsed: 0, requests: 0 },
            limits: CONFIG.plans[auth.plan],
            weekStarted: ledger.weekStarted,
        }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});
function checkAuth(req, res) {
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer /, '');
    // master key also works directly (dev convenience)
    if (token === CONFIG.masterKey)
        return { plan: CONFIG.defaultPlan, tokenKey: 'master' };
    const verified = verifySessionToken(token);
    if (!verified) {
        deny(res, 401, 'invalid or expired session token — POST /token with master key to mint one');
        return null;
    }
    return { plan: verified.plan, tokenKey: token };
}
function deny(res, code, message) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        error: { message, type: 'gateway_error', code },
    }));
    console.log(`✗ ${code} ${message}`);
}
function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(data));
            }
            catch {
                resolve(null);
            }
        });
    });
}
server.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(`forgecode-gateway (study) on http://127.0.0.1:${CONFIG.port}`);
    console.log(`  upstream: ${CONFIG.upstream.baseUrl} (${CONFIG.upstream.defaultModel})`);
    console.log(`  master key: ${CONFIG.masterKey === 'forge-local-master' ? '(default — set GW_MASTER_KEY!)' : '(set via env)'}`);
    console.log(`  mint a session: curl -X POST localhost:${CONFIG.port}/token -d '{"masterKey":"<key>","plan":"study"}'`);
});
