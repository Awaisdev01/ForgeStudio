/* ForgeStudio renderer — sidebar · streaming chat · files · diffs · terminal · mcp · keys · palette */
const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
const sfx = { read: '📄', write: '✏️', cmd: '▸', dir: '📁' };
const fileIco = (n) => /\.tsx?$/.test(n) ? '🟦' : /\.py$/.test(n) ? '🐍' : /\.json$/.test(n) ? '🧩' : /\.md$/.test(n) ? '📖' : /\.(png|jpe?g|gif|svg|webp|ico)$/.test(n) ? '🖼' : /\.(js|mjs|cjs)$/.test(n) ? '🟨' : /\.(html?|css)$/.test(n) ? '🎨' : /\.(rs)$/.test(n) ? '🦀' : /\.(go)$/.test(n) ? '🐹' : /\.(dart)$/.test(n) ? '🎯' : /\.swift$/.test(n) ? '🕊' : '📄';

const state = {
  models: [], providers: [], model: null,
  messages: [],           // {role:'user'|'assistant', content, streaming?, error?}
  steps: [],              // {name, detail, status:'run'|'done', ms}
  pendingDiffs: [],
  sessionId: null, sessions: [], mcpServers: [],
  workspace: null, busy: false, mode: 'code',
  expandedDirs: {}, openFile: null,
  ctxFiles: [],           // @ mentions attached
  termLines: [],
  thinking: '',           // live reasoning stream (muted, collapsible)
};

/* ── toasts ── */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast-i ${kind}`;
  t.textContent = msg;
  $('toast-wrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 2600);
}

/* ═══════════ FILES TREE ═══════════ */
async function loadChildren(dir, container) {
  const entries = await window.studio.listDir(dir);
  if (entries.error || !entries.length) {
    container.innerHTML = '<div class="empty-dir">empty</div>';
    return;
  }
  container.innerHTML = entries.map((e) => `
    <div class="node" data-path="${esc(e.path)}" data-dir="${e.dir}">
      ${e.dir ? '<span class="caret">▶</span>' : '<span class="caret"></span>'}
      <span class="f-ico">${e.dir ? '📁' : fileIco(e.name)}</span>
      <span class="n-label">${esc(e.name)}</span>
    </div>`).join('');
  container.querySelectorAll('.node').forEach((n) => n.addEventListener('click', () => void onNodeClick(n)));
}
async function onNodeClick(node) {
  const p = node.dataset.path, isDir = node.dataset.dir === 'true';
  if (isDir) {
    let kids = node.nextElementSibling;
    const isOpen = node.classList.contains('open');
    if (kids && kids.classList.contains('children') && isOpen) { // collapse
      node.classList.remove('open'); node.querySelector('.caret').textContent = '▶'; kids.remove(); return;
    }
    node.classList.add('open'); node.querySelector('.caret').textContent = '▼';
    kids = document.createElement('div'); kids.className = 'children';
    node.after(kids);
    node.querySelector('.f-ico').textContent = '📂';
    await loadChildren(p, kids);
  } else {
    document.querySelectorAll('.tree .node.active').forEach((x) => x.classList.remove('active'));
    node.classList.add('active');
    await openFileViewer(p);
  }
}
async function openFileViewer(absPath) {
  state.openFile = absPath;
  const rel = state.workspace ? absPath.replace(state.workspace + '/', '') : absPath;
  const content = await window.studio.readFile(absPath);
  const pane = $('pane-files');
  if (content === null) { pane.innerHTML = `<div class="empty">Cannot read ${esc(rel)}</div>`; return; }
  const lines = content.split('\n').slice(0, 4000);
  const ext = rel.split('.').pop() ?? '';
  pane.innerHTML = `
    <div class="fv-head"><span class="fv-path">${esc(rel)}</span><button class="copy-btn" id="fv-copy">copy</button></div>
    <div class="fv-body">${lines.map((l, i) =>
      `<div class="fv-line"><span class="fv-ln">${i + 1}</span><span class="fv-code">${MD.hl(l, ext) || ' '}</span></div>`).join('')}</div>`;
  $('fv-copy').addEventListener('click', () => { navigator.clipboard.writeText(content); toast('copied', 'ok'); });
}

/* ═══════════ DIFFS ═══════════ */
function splitHtml(d) {
  const a = (d.original ?? '').split('\n'), b = (d.updated ?? '').split('\n');
  const max = Math.max(a.length, b.length);
  let out = '';
  for (let i = 0; i < Math.min(max, 120); i++) {
    const old_ = a[i] ?? '', new_ = b[i] ?? '';
    const changed = old_ !== new_;
    out += `<div style="display:grid;grid-template-columns:1fr 1fr;font-family:var(--mono);font-size:10.5px;line-height:1.55">
      <span style="padding:0 8px;color:${changed ? 'var(--danger)' : 'var(--faint)'};background:${changed ? 'rgba(255,97,87,.06)' : ''}">${esc(old_) || ' '}</span>
      <span style="padding:0 8px;color:${changed ? 'var(--accent)' : 'var(--faint)'};background:${changed ? 'rgba(183,255,69,.06)' : ''};border-left:1px solid var(--line)">${esc(new_) || ' '}</span></div>`;
  }
  return out;
}
function toggleSplit() { state.diffSplit = !state.diffSplit; window.studio.setSettings({ diffSplit: state.diffSplit }); renderDiffs(); }
if (state.diffSplit === undefined) void window.studio.getSettings().then((st) => {
  state.diffSplit = st.diffSplit ?? window.innerWidth > 1500;
  renderDiffs();
});
window.toggleSplit = toggleSplit;
function diffHtml(d) {
  if (state.diffSplit) return splitHtml(d);
  if (d.kind === 'new') return d.updated.split('\n').slice(0, 120).map((l) => `<span class="dl">+ ${esc(l) || ' '}</span>`).join('');
  const a = (d.original ?? '').split('\n'), b = (d.updated ?? '').split('\n');
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 120; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`<span class="dmin">- ${esc(a[i]) || ' '}</span>`);
      if (b[i] !== undefined) out.push(`<span class="dl">+ ${esc(b[i]) || ' '}</span>`);
    } else out.push(`<span class="dctx">  ${esc(a[i] ?? '') || ' '}</span>`);
  }
  return out.join('');
}
function diffStats(d) {
  const a = (d.original ?? '').split('\n'), b = (d.updated ?? '').split('\n');
  let plus = 0, minus = 0;
  if (d.kind === 'new') return { plus: b.length, minus: 0 };
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { if (a[i] !== undefined) minus++; if (b[i] !== undefined) plus++; }
  }
  return { plus, minus };
}
function renderDiffs() {
  const pane = $('pane-diffs');
  const active = state.pendingDiffs.filter((d) => d.status !== 'applied');
  $('diff-badge').textContent = active.length ? String(active.length) : '';
  if (!state.pendingDiffs.length) {
    pane.innerHTML = '<div class="empty"><span class="e-ico">✏️</span>Agent edits collect here for review.<br>Nothing is written until you approve.</div>';
    return;
  }
  pane.innerHTML = `
    <div class="diffbar">
      <button class="btn sm primary" onclick="applyAllDiffs()">Keep all</button>
      <button class="btn sm danger-ghost" onclick="discardAllDiffs()">Discard all</button>
      <button class="btn sm" onclick="toggleSplit()">${state.diffSplit ? '◐ Unified' : '◑ Side-by-side'}</button>
      ${state.busy ? '<span class="hint" style="font-family:var(--mono);font-size:9.5px;color:var(--faint);align-self:center">agent may add more…</span>' : ''}
    </div>` + state.pendingDiffs.map((d, i) => {
    const st = diffStats(d);
    const badge = d.status === 'applied' ? '<span class="badge applied">applied ✓</span>'
      : d.kind === 'new' ? '<span class="badge new">new file</span>' : '<span class="badge mod">modified</span>';
    const note = d.status === 'applied' ? '' : `
      <button class="btn sm" onclick="applyDiff(${i})">Keep</button>
      <button class="btn sm danger-ghost" onclick="discardDiff(${i})">Discard</button>`;
    return `<div class="diffcard">
      <div class="head">${badge}<span class="path" style="cursor:pointer" onclick="jumpToDiffFile(${i})" title="Open in Files">${esc(d.path)}</span>
        <span class="diff-stat"><span class="plus">+${st.plus}</span> <span class="minus">−${st.minus}</span></span>${note}</div>
      <pre>${diffHtml(d)}</pre></div>`;
  }).join('');
}
function applyDiff(i) {
  const d = state.pendingDiffs[i];
  window.studio.applyDiff(d).then((ok) => {
    if (ok) { d.status = 'applied'; toast(`kept ${d.path}`, 'ok'); }
    else toast(`failed to write ${d.path}`, 'warn');
    renderDiffs();
  });
}
function discardDiff(i) { state.pendingDiffs.splice(i, 1); renderDiffs(); toast('discarded'); }
async function applyAllDiffs() {
  const active = state.pendingDiffs.filter((d) => d.status !== 'applied');
  if (!active.length) return;
  const ok = await window.studio.applyDiffs(active);
  if (ok) {
    active.forEach((d) => (d.status = 'applied'));
    toast(`kept ${active.length} files (one checkpoint — Undo restores all)`, 'ok');
    void refreshGitChip();
    // verify-after-keep: run project checks, surface results
    const v = await window.studio.runVerify(state.workspace);
    if (v && v.ok !== null) {
      state.termLines.push(`<span class="cmdline">✓ verify (${v.label})</span>\n${esc((v.output ?? '').slice(0, 1200))}`);
      renderTerm(); switchTab('term');
      toast(v.ok ? `✓ ${v.label} passed after Keep` : `✗ ${v.label} FAILED — see Terminal`, v.ok ? 'ok' : 'warn');
      if (!v.ok) {
        state.messages.push({ role: 'assistant', content: `⚠️ Verification after applying changes **failed** (\`${v.label}\`). Errors are in the Terminal pane — ask me to fix them, or press ⟲ on your last message to let me retry.` });
        renderTranscript();
      }
    }
  } else toast('batch apply failed', 'warn');
  renderDiffs();
}
async function jumpToDiffFile(i) {
  const d = state.pendingDiffs[i];
  await openFileViewer(d.workspace + '/' + d.path);
  switchTab('files');
}
window.jumpToDiffFile = jumpToDiffFile;
function discardAllDiffs() {
  state.pendingDiffs = state.pendingDiffs.filter((d) => d.status === 'applied');
  renderDiffs(); toast('all discarded');
}
window.applyDiff = applyDiff; window.discardDiff = discardDiff;
window.applyAllDiffs = applyAllDiffs; window.discardAllDiffs = discardAllDiffs;

/* ═══════════ TRANSCRIPT ═══════════ */
function renderTranscript() {
  const tr = $('transcript');
  const has = state.messages.length || state.steps.length;
  $('welcome').style.display = has ? 'none' : '';
  tr.innerHTML = state.messages.map((m, i) => {
    if (m.role === 'user') {
      const chips = (m.ctx ?? []).map((f) => `<span class="ctx-chip">@${esc(f)}</span>`).join(' ');
      return `<div class="msg user" data-mi="${i}">${chips}${esc(m.content)}<span class="msg-acts"><button class="icon-btn" data-act="copy" data-mi="${i}" title="Copy">⧉</button><button class="icon-btn" data-act="retry" data-mi="${i}" title="Resend from here">⟲</button></span></div>`;
    }
    if (m.role === 'assistant') {
      const tools = m.tools?.length ? `<div class="a-tools">${m.tools.map((t) => `<code>🔧 ${esc(t.replace('mcp__', 'mcp:'))}</code>`).join(' ')}</div>` : '';
      const streaming = m.streaming ? '<span class="cursor">▌</span>' : '';
      return `<div class="msg assistant ${m.streaming ? 'streaming' : ''}">${tools}${MD.render(m.content)}${streaming}</div>`;
    }
    if (m.role === 'artifact') {
      return `<div class="artifact">
        <div class="a-head"><span class="a-kind">ARTIFACT</span> Task plan &amp; walkthrough</div>
        <div class="a-body">
          <strong style="font-size:11px;color:var(--muted);font-family:var(--mono)">STEPS TAKEN</strong>
          <ol>${m.plan.map((p) => `<li>${esc(p)}</li>`).join('') || '<li>no reads</li>'}</ol>
          <strong style="font-size:11px;color:var(--muted);font-family:var(--mono)">FILES CHANGED</strong>
          <div>${m.writes.map((f) => `<code style="font-family:var(--mono);font-size:10.5px;color:var(--accent)">${esc(f)}</code>`).join('<br>') || '<em style="color:var(--muted)">none</em>'}</div>
        </div></div>`;
    }
    if (m.role === 'error') return `<div class="msg error">⚠️ ${esc(m.content)}</div>`;
    return '';
  }).join('') + (state.steps.length ? `<div class="steps">${state.steps.map((s) => `
    <div class="step ${s.open ? 'open' : ''}" data-step>
      <div class="step-head">
        ${s.status === 'run' ? '<span class="spin"></span>' : `<span class="step-ico ${s.cls ?? ''}">${sfx[s.cls ?? 'read'] ?? '📄'}</span>`}
        <span class="step-name ${s.cls ?? ''}">${esc(s.name)}</span>
        <span class="step-detail">${esc(s.detail ?? '')}</span>
        <span class="step-meta">${s.status === 'run' ? 'running…' : (s.ms != null ? (s.ms / 1000).toFixed(1) + 's' : '')}</span>
      </div>
      <div class="step-body">${esc(s.output ?? '')}</div>
    </div>`).join('')}</div>` : '');
  tr.scrollTop = tr.scrollHeight;
  $('btn-send').disabled = state.busy || !$('prompt').value.trim();
  $('btn-stop').style.display = state.busy ? '' : 'none';
}
// toggle step open
$('transcript').addEventListener('click', (e) => {
  const head = e.target.closest('.step-head');
  if (head) head.parentElement.classList.toggle('open');
  const ma = e.target.closest('.msg-acts .icon-btn');
  if (ma) {
    const mi = Number(ma.dataset.mi);
    if (ma.dataset.act === 'copy') { navigator.clipboard.writeText(state.messages[mi].content); toast('copied', 'ok'); }
    if (ma.dataset.act === 'retry') {
      state.messages = state.messages.slice(0, mi); // truncate: retry from this point
      promptEl.value = state.messages[mi - 1]?.content ?? '';
      autoSize(); $('btn-send').disabled = false; promptEl.focus();
      toast('resend from here — edit if needed, then Send');
    }
    return;
  }
  const cb = e.target.closest('.copy-btn');
  if (cb?.dataset.codeId) {
    navigator.clipboard.writeText($(cb.dataset.codeId).textContent);
    cb.textContent = 'copied ✓';
    setTimeout(() => (cb.textContent = 'copy'), 1500);
  }
  const sg = e.target.closest('.suggest');
  if (sg) { $('prompt').value = sg.dataset.p; $('prompt').focus(); autoSize(); $('btn-send').disabled = false; }
});

/* ═══════════ SIDEBAR: chats ═══════════ */
function groupWhen(iso) {
  const d = new Date(iso); const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (days <= 1) return 'Yesterday';
  if (days <= 7) return 'This week';
  return 'Earlier';
}
function renderSessions() {
  const q = ($('chat-search').value ?? '').toLowerCase();
  const list = state.sessions.filter((s) => s.title.toLowerCase().includes(q));
  const el = $('chat-list');
  if (!list.length) { el.innerHTML = `<div class="chat-empty">${q ? 'No matches' : 'No chats yet.<br>Every conversation is saved automatically.'}</div>`; return; }
  const groups = {};
  list.forEach((s) => (groups[s.group ?? groupWhen(s.when)] ??= []).push(s));
  el.innerHTML = Object.entries(groups).map(([g, items]) => `
    <div class="chat-group">${g}</div>` + items.map((s) => `
    <div class="chat-item ${s.id === state.sessionId ? 'active' : ''}" data-sid="${s.id}" title="${esc(s.title)}">
      <span class="t">${esc(s.title)}</span>
      <span class="acts">
        <button class="icon-btn" data-act="rename" data-sid="${s.id}" title="Rename">✎</button>
        <button class="icon-btn" data-act="del" data-sid="${s.id}" title="Delete">🗑</button>
      </span>
    </div>`).join('')).join('');
  el.querySelectorAll('.chat-item').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn')) return;
    void resumeChat(c.dataset.sid);
  }));
  el.querySelectorAll('.icon-btn').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const sid = b.dataset.sid;
    if (b.dataset.act === 'del') {
      await window.studio.deleteSession(sid);
      if (sid === state.sessionId) newChat();
      await refreshSessions(); toast('chat deleted');
    } else {
      const cur = state.sessions.find((s) => s.id === sid)?.title ?? '';
      const nt = prompt('Rename chat:', cur);
      if (nt && nt.trim()) { await window.studio.renameSession(sid, nt.trim()); await refreshSessions(); }
    }
  }));
}
async function refreshSessions() {
  state.sessions = await window.studio.listSessions();
  renderSessions();
}
async function renderRecents() {
  const rec = await window.studio.listRecent();
  $('recent-list').innerHTML = rec.filter((r) => r !== state.workspace).slice(0, 3).map((r) =>
    `<div class="chat-item" onclick="switchWorkspace('${esc(r).replace(/'/g, "")}')" title="${esc(r)}">
      <span class="f-ico">📁</span><span class="t" style="font-family:var(--mono);font-size:10px">${esc(r.split('/').filter(Boolean).pop())}</span></div>`).join('');
}
async function switchWorkspace(ws) {
  state.workspace = ws; state.openFile = null;
  window.studio.setSettings({ workspace: ws });
  updateWorkspaceUi(); await initTree(); void projectSuggestions();
  toast('switched workspace', 'ok');
}
window.switchWorkspace = switchWorkspace;

/* ═══════════ MODEL PICKER ═══════════ */
function modelMeta(id) {
  const [pid] = id.split('/');
  const p = state.providers.find((x) => x.id === pid) ?? {};
  const isLocal = !!p.local;
  const isOpen = (p.models ?? []).some((m) => m.openWeights && id.endsWith(m.id));
  const isFree = ['gemini', 'groq', 'cerebras'].includes(pid) || id.includes(':free');
  return { pid, p, isLocal, isOpen, isFree };
}
function renderModelButton() {
  state.providers ??= [];
  const m = state.models.find((x) => x.id === state.model);
  if (!m) return;
  const meta = modelMeta(state.model);
  $('model-name').textContent = m.label?.replace(/ · .*$/, '').replace(/ \(.*\)$/, '') || m.id.split('/').pop();
  $('model-prov').textContent = meta.p.label ?? meta.pid;
  const dot = $('model-dot');
  dot.className = 'status-dot ' + (meta.isLocal ? (meta.p.online ? 'ready' : 'offline')
    : meta.p.hasKey ? 'ready' : 'nokey');
  const tag = meta.isLocal ? 'local · no key' : meta.isFree ? 'free tier' : 'paid';
  $('model-prov').textContent = `${meta.p.label?.replace(/\s*\(.*\)$/, '') ?? meta.pid} · ${tag}`;
}

/* keyless onboarding hint on the welcome screen */
function renderSetupHint() {
  const sub = $('welcome-sub');
  if (!sub) return;
  const meta = state.model ? modelMeta(state.model) : null;
  if (meta?.isLocal && meta.p.online) {
    sub.innerHTML = `<strong style="color:var(--accent)">AI is running 100% locally — no keys, no cost, fully private.</strong><br>Open a project folder, then describe what you want. Edits collect in the Diffs pane for your approval.`;
  } else if (meta && !meta.isLocal && !meta.p.hasKey) {
    sub.innerHTML = `No API keys yet. Two ways to get free AI:<br>
      <strong style="color:var(--fg)">1 · No keys at all —</strong> install <a class="keylink" href="https://ollama.com/download" target="_blank">Ollama</a>, open it, then <button class="btn sm primary" onclick="rescanLocal()">⟳ Rescan local models</button><br>
      <strong style="color:var(--fg)">2 · Free cloud key —</strong> paste a Gemini key in the <a href="#" onclick="switchTab('keys');return false" class="keylink">Keys pane ↗</a>.`;
  }
}
async function rescanLocal() {
  toast('scanning for local models…');
  state.models = await window.studio.scanLocal();
  state.providers = await window.studio.getProviders();
  await refreshProvidersAndModels();
  const meta = state.model ? modelMeta(state.model) : null;
  toast(meta?.isLocal ? `✓ local AI found: ${state.model.split('/').pop()} — no keys needed` : 'no local models found — is Ollama running?', meta?.isLocal ? 'ok' : 'warn');
}
window.rescanLocal = rescanLocal;
function renderModelList(q = '') {
  const el = $('model-plist');
  const list = state.models.filter((m) => m.id.toLowerCase().includes(q.toLowerCase()) || m.label.toLowerCase().includes(q.toLowerCase()));
  if (!list.length) { el.innerHTML = '<div class="empty">No models</div>'; return; }
  const byProv = {};
  list.forEach((m) => (byProv[m.provider] ??= []).push(m));
  el.innerHTML = Object.entries(byProv).map(([pid, ms]) => {
  const meta = modelMeta(state.model);
  const tags = `${meta.isLocal ? '<span class="tag local">LOCAL · 0 credits</span>' : '<span class="tag cloud">CLOUD</span>'}${meta.isOpen ? ' <span class="tag free">OPEN WEIGHTS</span>' : ''}${meta.isFree ? ' <span class="tag free">FREE</span>' : ''}`;
    return `<div class="chat-group">${esc(state.providers.find((p) => p.id === pid)?.label ?? pid)} ${tags}</div>` +
      ms.map((m) => `<div class="pitem" data-mid="${esc(m.id)}"><span class="p-ico">◇</span>${esc(m.label)}<span class="pk kbd mono" style="font-family:var(--mono);font-size:9px;color:var(--faint)">${esc(m.id.split('/').slice(1).join('/'))}</span></div>`).join('');
  }).join('');
  el.querySelectorAll('.pitem').forEach((p) => p.addEventListener('click', () => {
    state.model = p.dataset.mid;
    window.studio.setSettings({ model: state.model });
    renderModelButton(); closePop(); toast(`model → ${state.model.split('/').pop()}`, 'ok');
  }));
}
function closePop() { $('model-pop').classList.remove('open'); $('palette').classList.remove('open'); }
$('model-btn').addEventListener('click', () => {
  $('model-pop').classList.add('open');
  $('model-search').value = ''; renderModelList();
  $('model-search').focus();
});
$('model-search').addEventListener('input', () => renderModelList($('model-search').value));

/* ═══════════ KEYS PANE ═══════════ */
async function renderKeys() {
  const providers = await window.studio.getProviders();
  state.providers = providers;
  renderModelButton();
  const gw = await window.gateway.getState();
  const stats = gw.usage?.providerStats ?? {};
  $('pane-keys').innerHTML = providers.map((p) => {
    const status = p.local
      ? (p.online ? '<span class="test-result ok">running · ' + (p.models?.length ?? 0) + ' models</span>'
                  : '<span class="test-result bad">not running</span>')
      : (p.hasKey ? '<span class="test-result ok" data-kst="' + p.id + '">key set</span>'
                  : '<span class="test-result bad">no key</span>');
    const link = /aistudio|google/.test(p.keyHint) ? 'https://aistudio.google.com/apikey'
      : /groq/.test(p.keyHint) ? 'https://console.groq.com/keys'
      : /cerebras/.test(p.keyHint) ? 'https://cloud.cerebras.ai'
      : /openrouter/.test(p.keyHint) ? 'https://openrouter.ai/keys'
      : /ollama\.com/.test(p.keyHint) ? 'https://ollama.com/download'
      : null;
    return `<div class="keyrow">
      <div class="kh"><span class="kn">${esc(p.label)}</span>
        ${p.local ? '<span class="tag local">LOCAL · 0 credits</span>' : /paid/.test(p.label) ? '<span class="tag paid">PAID</span>' : '<span class="tag free">FREE TIER</span>'}
        ${status}</div>
      <div class="tools" style="font-size:10.5px;color:var(--muted);margin-bottom:5px">${esc(p.keyHint)}${link ? ` · <a class="keylink" href="${link}" target="_blank">get key ↗</a>` : ''}</div>
      ${p.local
        ? `<div class="krow2"><button class="btn sm" onclick="testProvider('${p.id}')">Check connection</button></div>`
        : `<div class="krow2">
            <input type="password" id="pk-${p.id}" placeholder="${p.id} API key" value="${p.hasKey ? '••••••••••••' : ''}" autocomplete="off">
            <button class="btn sm" onclick="saveKey('${p.id}')">Save</button>
            <button class="btn sm" onclick="testProvider('${p.id}')">Test</button>
          </div>`}
      <div class="test-result" id="kt-${p.id}"></div>
    </div>`;
  }).join('') + `<div class="mcpcard" style="margin-top:12px"><div class="nm">Provider telemetry <span class="tag local">LOCAL ONLY</span></div>
    <div class="tools">${Object.entries(stats).map(([pid, st]) => `<span style="font-family:var(--mono);font-size:10px">${esc(pid)}: ${st.requests} req · ${st.fails} fail · ${st.fallbacks} fallback</span>`).join('<br>') || 'no provider calls yet'}</div></div>`;
}
async function saveKey(provider) {
  const inp = $('pk-' + provider);
  const key = inp.value.trim();
  if (!key || key.startsWith('••')) return;
  await window.studio.setProviderKey(provider, key);
  toast(`${provider} key saved`, 'ok');
  await refreshProvidersAndModels();
  void renderKeys();
}
async function testProvider(pid) {
  const out = $('kt-' + pid);
  out.textContent = 'testing…'; out.className = 'test-result';
  const r = await window.studio.testProvider(pid);
  out.textContent = r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`;
  out.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
  if (pid === 'ollama' && !r.ok) out.textContent = '✗ not running — install from ollama.com, then `ollama serve` + `ollama pull qwen3:8b`';
  await refreshProvidersAndModels();
}
window.saveKey = saveKey; window.testProvider = testProvider;

/* ═══════════ MCP ═══════════ */
function renderMcp() {
  $('mcp-list').innerHTML = state.mcpServers.map((s, i) =>
    `<div class="mcpcard"><div class="nm">${esc(s.name)} <span style="color:var(--accent);font-size:10px">${s.status}</span></div>
     <div class="tools">${esc(s.cmd)}</div>
     ${s.tools?.length ? `<div class="tools" style="margin-top:4px">${s.tools.slice(0, 6).map((t) => `<code style="font-family:var(--mono);font-size:9.5px;color:var(--sec)">${esc(t.name)}</code>`).join(' · ')}</div>` : ''}
     <div style="margin-top:7px"><button class="btn sm danger-ghost" onclick="removeMcp(${i})">Remove</button></div></div>`
  ).join('') || '<div class="empty"><span class="e-ico">🔌</span>No MCP servers connected.<br>Add a stdio server — its tools join the agent.</div>';
}
async function removeMcp(i) { await window.studio.removeMcp(i); state.mcpServers = await window.studio.listMcp(); renderMcp(); }
window.removeMcp = removeMcp;
$('btn-mcp-add').addEventListener('click', async () => {
  const name = $('mcp-name').value.trim(), cmd = $('mcp-cmd').value.trim();
  if (!name || !cmd) return toast('name + command required', 'warn');
  await window.studio.addMcp({ name, cmd });
  $('mcp-name').value = ''; $('mcp-cmd').value = '';
  state.mcpServers = await window.studio.listMcp();
  renderMcp(); toast(`${name} connected`, 'ok');
});

/* ═══════════ TABS ═══════════ */
document.querySelectorAll('.rtab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.rtab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  ['files', 'diffs', 'term', 'mcp', 'keys', 'checkpoints', 'manager'].forEach((p) => { $('pane-' + p).style.display = 'none'; });
  const pane = $('pane-' + t.dataset.pane);
  pane.style.display = t.dataset.pane === 'files' ? 'flex' : 'block';
  pane.style.flexDirection = 'column';
  if (t.dataset.pane === 'keys') void renderKeys();
  if (t.dataset.pane === 'files' && state.workspace && !pane.querySelector('.tree') && !state.openFile) void initTree();
  if (t.dataset.pane === 'checkpoints') void renderCheckpoints();
  if (t.dataset.pane === 'manager') void renderManager();
}));

/* ═══════════ CHECKPOINTS TIMELINE ═══════════ */
async function renderCheckpoints() {
  const list = await window.studio.listCheckpoints();
  $('pane-checkpoints').innerHTML = list.length ? `
    <div class="diffbar"><button class="btn sm" onclick="undoLast()">↩ Undo most recent</button></div>` +
    list.map((c) => `<div class="mcpcard">
      <div class="nm">${new Date(c.when).toLocaleString()}</div>
      <div class="tools">${c.files.map((f) => `<code style="font-family:var(--mono);font-size:9.5px;color:var(--sec)">${esc(f)}</code>`).join(' · ')}</div>
      <div style="margin-top:6px"><button class="btn sm" onclick="restoreCp('${c.id}')">Restore</button></div>
    </div>`).join('')
    : '<div class="empty"><span class="e-ico">⏱</span>No checkpoints yet.<br>Auto-applied changes and Kept diffs are snapshotted here — restore any point.</div>';
}
async function restoreCp(id) {
  const r = await window.studio.restoreCheckpoint(id);
  toast(r.ok ? `✓ ${r.detail}` : r.detail, r.ok ? 'ok' : 'warn');
  if (r.ok && state.workspace) void initTree();
}
function undoLast() { void restoreCp((window.__cps ?? [])[0]); }
async function undoLastWrap() { const l = await window.studio.listCheckpoints(); if (l[0]) void restoreCp(l[0].id); else toast('no checkpoints yet'); }
window.restoreCp = restoreCp; window.undoLast = undoLastWrap;

/* ═══════════ AGENT MANAGER ═══════════ */
async function renderManager() {
  const sessions = await window.studio.listSessions();
  $('pane-manager').innerHTML = sessions.length ? sessions.map((s) => `
    <div class="mcpcard" style="display:flex;align-items:center;gap:8px">
      <span class="status-dot ${s.id === state.sessionId && state.busy ? 'ready' : ''}" style="background:${s.id === state.sessionId && state.busy ? 'var(--accent)' : 'var(--faint)'}"></span>
      <div style="flex:1;min-width:0;cursor:pointer" onclick="void resumeChat('${s.id}')">
        <div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</div>
        <div class="tools">${esc(s.when)}</div>
      </div>
      <button class="icon-btn" onclick="void (async()=>{await window.studio.exportSession('${s.id}'); toast('exported');})()" title="Export markdown">⤓</button>
    </div>`).join('')
    : '<div class="empty"><span class="e-ico">🤖</span>No agent runs yet.<br>Every run across threads shows here with status.</div>';
}

/* ═══════════ TREE INIT ═══════════ */
async function initTree() {
  const pane = $('pane-files');
  pane.innerHTML = `
    <div style="padding:8px 10px;border-bottom:1px solid var(--line);display:flex;gap:6px;background:var(--rail);position:sticky;top:0;z-index:2">
      <input id="grep-input" placeholder="Search in project…" style="flex:1;font-family:var(--mono);font-size:11px">
      <button class="btn sm" id="grep-btn">Find</button>
    </div>
    <div id="grep-out"></div>
    <div class="tree" id="ftree"><div class="skeleton" style="height:14px;margin:6px 12px"></div><div class="skeleton" style="height:14px;margin:6px 24px;width:60%"></div><div class="skeleton" style="height:14px;margin:6px 24px;width:80%"></div></div>`;
  await loadChildren(state.workspace, $('ftree'));
  $('grep-btn').addEventListener('click', () => void runGrep());
  $('grep-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') void runGrep(); });
}
async function runGrep() {
  const q = $('grep-input').value.trim();
  if (!q) return;
  $('grep-out').innerHTML = '<div class="skeleton" style="height:12px;margin:8px 12px"></div>';
  const res = await window.studio.grep(q);
  if (!res || res.error) { $('grep-out').innerHTML = '<div class="empty">search failed</div>'; return; }
  $('grep-out').innerHTML = res.length ? res.map((h) => {
    const [file, line, ...rest] = h.split(':');
    return `<div class="grep-hit" onclick="openGrepHit('${esc(file)}')" style="padding:5px 12px;font-family:var(--mono);font-size:10.5px;cursor:pointer;border-bottom:1px solid var(--line)">
      <span style="color:var(--sec)">${esc(file)}:${esc(line)}</span><br><span style="color:var(--muted)">${esc(rest.join(':').trim().slice(0, 120))}</span></div>`;
  }).join('') : '<div class="empty" style="padding:6px">no matches</div>';
}
async function openGrepHit(rel) {
  await openFileViewer(state.workspace + '/' + rel);
}
window.openGrepHit = openGrepHit;

/* ═══════════ WORKSPACE ═══════════ */
$('proj-btn').addEventListener('click', async () => {
  const dir = await window.studio.pickFolder();
  if (!dir) return;
  state.workspace = dir;
  state.openFile = null;
  window.studio.setSettings({ workspace: dir });
  updateWorkspaceUi();
  await initTree();
  void projectSuggestions();
  toast('workspace set', 'ok');
});
function updateWorkspaceUi() {
  if (!state.workspace) return;
  window.studio.pushRecent(state.workspace);
  void refreshGitChip(); void renderRecents();
  const name = state.workspace.split('/').filter(Boolean).pop();
  $('proj-ico').textContent = name.slice(0, 2).toUpperCase();
  $('proj-ico').classList.add('folder');
  $('proj-name').textContent = name;
  $('proj-path').textContent = state.workspace;
  $('ws-hint').textContent = name;
  $('welcome-sub').innerHTML = `Working in <strong style="color:var(--fg)">${esc(name)}</strong>. Edits collect in the Diffs pane — nothing touches your files until you approve.`;
}

/* project-aware suggestions: read package.json/pubspec to tailor cards */
async function projectSuggestions() {
  if (!state.workspace) return;
  const hints = [];
  const tryRead = async (f) => { try { return await window.studio.readFile(path.join(state.workspace, f)); } catch { return null; } };
  const pkg = await tryRead('package.json');
  const pubspec = await tryRead('pubspec.yaml');
  const readme = await tryRead('README.md');
  let cards = [
    ['🔍 Explain this project', 'Architecture walkthrough of the open folder', 'Explain this project\'s structure and what it does'],
    ['📝 Add a README', 'Setup + usage docs for this project', 'Add a README with setup instructions'],
    ['🐛 Find & fix bugs', 'Audit the main entry for issues', 'Find and fix any bugs in the main entry file'],
    ['🧪 Write tests', 'Test the core module end to end', 'Write tests for the core module'],
  ];
  if (pubspec) cards[0] = ['🔍 Explain this Flutter/Dart project', 'Analyze pubspec + lib structure', 'Explain this project\'s structure, dependencies in pubspec.yaml, and what it does'];
  if (pkg?.includes('"dev"') || pkg?.includes('"scripts"')) cards[2] = ['⚙️ Audit npm scripts', 'Check package.json scripts for issues', 'Review package.json scripts and suggest improvements'];
  if (readme) cards[1] = ['✍️ Update README', 'Refresh docs to match current code', 'Review the README and update it to match the current code'];
  document.querySelectorAll('.suggest').forEach((el, i) => {
    if (!cards[i]) return;
    el.querySelector('.st').textContent = cards[i][0];
    el.querySelector('.sd').textContent = cards[i][1];
    el.dataset.p = cards[i][2];
  });
}

/* auto-mode first-run explainer */
function autoExplainer() {
  const seen = window.__autoExplained;
  if (seen) return;
  window.__autoExplained = true;
  toast('Auto applies changes immediately — checkpoints kept, Undo available', 'warn');
}

/* ═══════════ GIT CHIP ═══════════ */
async function createThreadBranch() {
  if (!state.workspace || !state.sessionId) return toast('open a folder + start a chat first', 'warn');
  const r = await window.studio.createThreadBranch(state.sessionId, state.workspace);
  if (r.ok) {
    state.workspace = r.worktree;
    window.studio.setSettings({ workspace: r.worktree });
    updateWorkspaceUi(); await initTree(); void projectSuggestions();
    toast(`isolated in worktree → ${r.branch}`, 'ok');
  } else toast(r.error, 'warn');
}
async function mergeThreadBranch() {
  if (!state.sessionId) return toast('no chat', 'warn');
  const r = await window.studio.mergeThreadBranch(state.sessionId, state.workspace);
  if (r.ok) {
    toast('merged into main ✓', 'ok');
    // jump back to the main workspace
    const rec = await window.studio.listRecent();
    if (rec.length) { state.workspace = rec[0]; window.studio.setSettings({ workspace: rec[0] }); updateWorkspaceUi(); await initTree(); }
  } else toast(r.error, 'warn');
}
async function discardThreadBranch() {
  if (!state.sessionId) return toast('no chat', 'warn');
  const r = await window.studio.discardThreadBranch(state.sessionId, state.workspace);
  if (r.ok) toast('branch discarded', 'ok');
}
window.createThreadBranch = createThreadBranch;

async function refreshGitChip() {
  if (!state.workspace) { $('git-chip').textContent = ''; return; }
  const g = await window.studio.gitInfo(state.workspace);
  $('git-chip').textContent = g.repo ? `⑂ ${g.branch}${g.dirty ? ' · ' + g.dirty + '±' : ''}` : 'no git';
  $('git-chip').title = g.repo ? `branch ${g.branch}, ${g.dirty} changed files — agent commits before each run` : 'git will be initialized on first run';
}

/* ═══════════ PREVIEW PANE ═══════════ */
$('btn-preview-start').addEventListener('click', async () => {
  const r = await window.studio.previewStart(state.workspace);
  if (r.ok) showPreview();
});
$('btn-preview-reload').addEventListener('click', () => { const f = $('preview-frame'); if (f.style.display !== 'none') f.src = f.src; });
$('btn-preview-stop').addEventListener('click', async () => {
  await window.studio.previewStop();
  $('preview-frame').style.display = 'none';
  $('preview-empty').style.display = '';
});
function showPreview() {
  $('preview-frame').style.display = '';
  $('preview-empty').style.display = 'none';
  $('preview-frame').src = 'http://127.0.0.1:4185/?t=' + Date.now();
}

/* ═══════════ SETTINGS ═══════════ */
$('btn-settings').addEventListener('click', async () => {
  const st = await window.studio.getSettings();
  $('set-accent').value = st.accent ?? '#B7FF45';
  $('set-font').value = st.fontSize ?? '13px';
  $('set-sound').checked = st.sound !== false;
  $('set-telemetry').checked = st.telemetry !== false;
  $('settings-modal').classList.add('open');
});
$('btn-set-save').addEventListener('click', async () => {
  const accent = $('set-accent').value, fontSize = $('set-font').value;
  await window.studio.setSettings({ accent, fontSize, sound: $('set-sound').checked, telemetry: $('set-telemetry').checked });
  applyTheme(accent, fontSize);
  $('settings-modal').classList.remove('open');
  toast('settings saved', 'ok');
});
function applyTheme(accent, fontSize) {
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-dim', accent + '1f');
  document.documentElement.style.setProperty('--accent-border', accent + '66');
  if (fontSize) document.body.style.fontSize = fontSize;
}
$('settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') $('settings-modal').classList.remove('open'); });

/* onboarding (first launch) */
(async () => {
  const st = await window.studio.getSettings();
  window.__settings = st;
  if (!st.onboarded) {
    $('onboard').classList.add('open');
    $('btn-ob-done').addEventListener('click', () => {
      window.studio.setSettings({ onboarded: true });
      $('onboard').classList.remove('open');
    });
  }
  applyTheme(st.accent, st.fontSize);
})();

/* completion sound */
function dingDone() {
  const st = window.__settings ?? {};
  if (st.telemetry === false) { /* respect user choice: nothing to mute for sound, kept for clarity */ }
  if (st.sound === false) return;
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .25);
    o.start(); o.stop(ctx.currentTime + .26);
  } catch {}
}

/* image paste/attach */
state.images = [];
document.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  const reader = new FileReader();
  reader.onload = async () => {
    const r = await window.studio.saveImage(reader.result);
    if (r.ok) { state.images.push(r.rel); renderImageChips(); toast('image attached — describe what to do with it', 'ok'); }
  };
  reader.readAsDataURL(file);
});
function renderImageChips() {
  const el = $('ctx-chips');
  const imgs = (state.images ?? []).map((im, i) => `<span class="ctx-chip">🖼 ${esc(im.rel.split('/').pop())}<button class="icon-btn" data-img="${i}" style="padding:0 3px">×</button></span>`).join('');
  el.innerHTML = imgs + state.ctxFiles.map((f, i) =>
    `<span class="ctx-chip">@${esc(f)}<button class="icon-btn" data-i="${i}" style="padding:0 3px">×</button></span>`).join('');
  el.style.display = el.innerHTML ? 'flex' : 'none';
  el.querySelectorAll('[data-img]').forEach((b) => b.addEventListener('click', () => { state.images.splice(+b.dataset.img, 1); renderImageChips(); }));
}

/* ═══════════ COMPOSER ═══════════ */
const promptEl = $('prompt');
function autoSize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
  $('btn-send').disabled = state.busy || !promptEl.value.trim();
}
promptEl.addEventListener('input', () => { autoSize(); void mentionCheck(); });
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  if (e.key === 'Escape') $('mention-pop').style.display = 'none';
});
let mentionState = null;
async function mentionCheck() {
  const v = promptEl.value;
  const m = v.match(/@([\w./-]*)$/);
  const pop = $('mention-pop');
  if (!m || !state.workspace) { pop.style.display = 'none'; mentionState = null; return; }
  // gather files (flat from tree cache)
  if (!state.flatFiles) {
    const tree = await window.studio.fileTree(state.workspace);
    state.flatFiles = [];
    const walk = (nodes, prefix) => (nodes ?? []).forEach((n) => {
      if (n.dir) walk(n.children, prefix + n.name + '/');
      else state.flatFiles.push(prefix + n.name);
    });
    walk(tree, '');
  }
  const matches = state.flatFiles.filter((f) => f.toLowerCase().includes(m[1].toLowerCase())).slice(0, 8);
  if (!matches.length) { pop.style.display = 'none'; mentionState = null; return; }
  mentionState = { matches, sel: 0, queryStart: m.index };
  pop.innerHTML = matches.map((f, i) => `<div class="mention-item ${i === 0 ? 'sel' : ''}" data-f="${esc(f)}">${esc(f)}</div>`).join('');
  pop.style.display = 'block';
  pop.querySelectorAll('.mention-item').forEach((mi) => mi.addEventListener('click', () => pickMention(mi.dataset.f)));
}
function pickMention(f) {
  promptEl.value = promptEl.value.replace(/@[\w./-]*$/, '@' + f + ' ');
  if (!state.ctxFiles.includes(f)) state.ctxFiles.push(f);
  renderCtxChips();
  $('mention-pop').style.display = 'none';
  mentionState = null;
  promptEl.focus();
}
function renderCtxChips() {
  const el = $('ctx-chips');
  el.style.display = state.ctxFiles.length ? 'flex' : 'none';
  el.innerHTML = state.ctxFiles.map((f, i) =>
    `<span class="ctx-chip">@${esc(f)}<button class="icon-btn" data-i="${i}" style="padding:0 3px">×</button></span>`).join('');
  el.querySelectorAll('.icon-btn').forEach((b) => b.addEventListener('click', () => {
    state.ctxFiles.splice(Number(b.dataset.i), 1); renderCtxChips();
  }));
}
promptEl.addEventListener('keydown', (e) => {
  if (mentionState && $('mention-pop').style.display !== 'none') {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.sel = (mentionState.sel + 1) % mentionState.matches.length; highlightMention(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.sel = (mentionState.sel - 1 + mentionState.matches.length) % mentionState.matches.length; highlightMention(); }
    if (e.key === 'Tab' || (e.key === 'Enter' && e.altKey)) { e.preventDefault(); pickMention(mentionState.matches[mentionState.sel]); }
  }
});
function highlightMention() {
  if (!mentionState) return;
  $('mention-pop').querySelectorAll('.mention-item').forEach((el, i) => el.classList.toggle('sel', i === mentionState.sel));
}

/* mode toggle */
document.querySelectorAll('.mode-opt').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.mode-opt').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.mode = b.dataset.mode;
  if (state.mode === 'auto') autoExplainer();
  if (state.mode === 'ask') toast('Ask mode: read-only, no file changes');
}));

/* ═══════════ SEND / AGENT ═══════════ */
let abortFlag = false;
$('btn-send').addEventListener('click', () => void send());
$('btn-stop').addEventListener('click', () => {
  abortFlag = true;
  void window.studio.stopAgent(state.sessionId);
  toast('stopping…');
});

async function send() {
  const text = promptEl.value.trim();
  if (!text || state.busy) return;
  promptEl.value = ''; autoSize(); $('mention-pop').style.display = 'none';
  state.messages.push({ role: 'user', content: text, ctx: [...state.ctxFiles] });
  state.ctxFiles = []; state.images = []; renderCtxChips(); renderImageChips();
  state.steps = [];
  state.busy = true; abortFlag = false;
  clearThinking();
  const msg = { role: 'assistant', content: '', streaming: true };
  state.messages.push(msg);
  renderTranscript();

  const result = await window.studio.runAgent({
    sessionId: state.sessionId,
    prompt: [
      text,
      state.ctxFiles?.length ? '(referenced files: ' + state.ctxFiles.join(', ') + ')' : '',
      state.images?.length ? '(analyzing the attached image(s) directly)' : '',
    ].filter(Boolean).join(' '),
    images: (state.images ?? []).map((im) => im.dataUrl),
    model: state.model,
    mode: state.mode,
  });
  // sync canonical history from main (keeps tool context across turns)
  if (result.messages) {
    state.messages = result.messages.map((m) => ({
      role: m.role,
      content: m.content,
      tools: m.tools,
    }));
  }
  msg.streaming = false;
  state.busy = false;
  if (result.usage) state.usage = result.usage;
  if (result.error) state.messages.push({ role: 'error', content: result.error });
  if (result.sessionId) { state.sessionId = result.sessionId; }
  await refreshSessions();
  maybeArtifact();
  dingDone();
  void refreshGitChip();
  renderTranscript();
}

/* events from main */
window.studio.onAgentEvent((e) => {
  if (state.busy && abortFlag && !['done'].includes(e.type)) { /* still draining */ }
  switch (e.type) {
    case 'text-delta': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') { last.content += e.payload; renderTranscript(); }
      break;
    }
    case 'thinking-delta':
      state.thinking += e.payload;
      renderThinking();
      break;
    case 'tool-start':
      state.steps.push({ name: e.payload.name, detail: e.payload.detail, status: 'run', open: false, cls: e.payload.name === 'write_file' ? 'write' : e.payload.name === 'run_command' ? 'cmd' : 'read' });
      renderTranscript();
      break;
    case 'tool-end': {
      const s = [...state.steps].reverse().find((x) => x.name === e.payload.name && x.status === 'run');
      if (s) { s.status = 'done'; s.ms = e.payload.ms; s.output = e.payload.output ?? ''; }
      if (e.payload.name === 'run_command') {
        state.termLines.push(`<span class="cmdline">$ ${esc(s?.detail ?? '')}</span>\n${esc((e.payload.output ?? '').slice(0, 800))}`);
        renderTerm();
        switchTab('term');
      }
      renderTranscript();
      break;
    }
    case 'diff':
      state.pendingDiffs.push(e.payload);
      renderDiffs(); switchTab('diffs');
      break;
    case 'auto-applied':
      toast(`applied ${e.payload.path} (checkpoint kept)`, 'ok');
      state.termLines.push(`<span class="cmdline">✎ applied ${esc(e.payload.path)}</span>`);
      renderTerm();
      break;
    case 'notice': toast(e.payload, 'warn'); break;
    case 'step-end': /* noop, steps track tools */ break;
    case 'done': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') last.streaming = false;
      clearThinking();
      renderTranscript();
      break;
    }
    case 'status': if (!state.busy) toast(e.payload); break;
  }
});
function renderThinking() {
  let el = $('thinking-block');
  if (!el) {
    el = document.createElement('div');
    el.id = 'thinking-block';
    el.className = 'thinking-block';
    $('transcript').appendChild(el);
  }
  el.innerHTML = `<div class="th-head"><span class="spin"></span> thinking…</div><div class="th-body">${esc(state.thinking.slice(-600))}</div>`;
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
function clearThinking() { state.thinking = ''; $('thinking-block')?.remove(); }

function renderTerm() {
  $('term-log').innerHTML = state.termLines.slice(-200).join('\n') || '<span style="color:var(--faint)">command output appears here (Auto mode)</span>';
  $('pane-term').scrollTop = $('pane-term').scrollHeight;
}
function switchTab(name) {
  const t = document.querySelector(`.rtab[data-pane="${name}"]`);
  if (t && !t.classList.contains('active')) t.click();
}

/* resume: map API-format history to renderer messages */
async function resumeChat(sid) {
  const s = await window.studio.resumeSession(sid);
  if (s.error) { toast('could not load chat', 'warn'); return; }
  state.sessionId = s.id;
  state.workspace = s.workspace ?? state.workspace;
  if (s.workspace) { state.workspace = s.workspace; window.studio.setSettings({ workspace: s.workspace }); updateWorkspaceUi(); void initTree(); void projectSuggestions(); }
  if (s.model) { state.model = s.model; renderModelButton(); }
  if (s.mode) {
    state.mode = s.mode;
    document.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('active', x.dataset.mode === s.mode));
  }
  state.messages = (s.messages ?? []).map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content, tools: (m.tool_calls ?? []).map((t) => t.function.name) };
    return null;
  }).filter(Boolean);
  state.usage = s.usage ?? null;
  state.pendingDiffs = s.pending ?? [];
  state.steps = [];
  renderTranscript(); renderDiffs(); renderUsage();
  toast('chat restored', 'ok');
}

/* context meter */
const CTX_WINDOWS = { ollama: 32_000, lmstudio: 32_000, gemini: 1_000_000, groq: 131_000, cerebras: 131_000, openrouter: 131_000, zai: 131_000 };
function renderUsage() {
  const u = state.usage;
  const el = $('ctx-meter');
  if (!u || !state.model) { el.style.display = 'none'; return; }
  const [pid] = state.model.split('/');
  const win = CTX_WINDOWS[pid] ?? 128_000;
  const used = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
  const pct = Math.min(100, Math.round(used / win * 100));
  el.style.display = '';
  el.innerHTML = `<span class="mono" style="font-family:var(--mono);font-size:9.5px;color:${pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warn)' : 'var(--muted)'}">ctx ${pct}% · ${used > 1000 ? (used / 1000).toFixed(1) + 'k' : used} / ${win / 1000}k</span>`;
}
window.studio.onUsage?.((u) => { state.usage = u; renderUsage(); });

/* artifact: task plan + walkthrough card after a run with writes */
function maybeArtifact() {
  const writeSteps = state.steps.filter((s) => s.cls === 'write' && s.status === 'done');
  if (!writeSteps.length) return;
  const files = [...new Set(state.pendingDiffs.map((d) => d.path).concat(writeSteps.map((s) => s.detail?.match(/"path":"([^"]+)"/)?.[1] ?? '')))].filter(Boolean);
  const card = {
    role: 'artifact',
    plan: state.steps.filter((s) => s.cls !== 'write').slice(0, 5).map((s) => s.name + (s.detail ? ` (${s.detail.slice(0, 40)})` : '')),
    writes: files,
  };
  state.messages.push(card);
}
/* ═══════════ CHAT ACTIONS ═══════════ */
function newChat() {
  state.messages = []; state.steps = []; state.sessionId = null; state.pendingDiffs = []; state.usage = null;
  renderTranscript(); renderDiffs(); renderUsage();
}
$('btn-new-chat').addEventListener('click', () => { newChat(); toast('new chat'); });
$('btn-undo').addEventListener('click', async () => {
  const r = await window.studio.undoCheckpoint();
  toast(r.ok ? `undone: ${r.detail}` : r.detail, r.ok ? 'ok' : 'warn');
});
$('btn-rail-toggle').addEventListener('click', () => $('right-rail').classList.toggle('collapsed'));
$('chat-search').addEventListener('input', renderSessions);
document.querySelectorAll('.suggest').forEach((s) => s.addEventListener('click', () => {
  promptEl.value = s.dataset.p; autoSize(); promptEl.focus(); $('btn-send').disabled = false;
}));

/* ═══════════ COMMAND PALETTE ═══════════ */
const PROMPT_LIBRARY = [
  { name: '🐞 Bugfix template', body: 'There is a bug in this project: [describe the symptom].\nSteps to reproduce: [steps].\nFind the root cause, fix it minimally, and run the tests to verify.' },
  { name: '♻️ Refactor template', body: 'Refactor [file/module] to [goal: e.g. reduce duplication / extract helpers].\nKeep behavior identical. Run the test suite after to confirm.' },
  { name: '🚀 Feature template', body: 'Implement [feature description].\nRequirements: [list].\nFollow the existing patterns in this codebase; add tests if a test framework exists.' },
  { name: '📝 Docs template', body: 'Update the README and any doc comments to match the current code. Include setup, usage examples, and a short architecture note.' },
  { name: '🧪 Tests template', body: 'Add tests for [module]. Cover the happy path and edge cases. Use the existing test framework and naming conventions.' },
  { name: '⚡ Perf template', body: 'Profile and improve performance in [area]. Identify the bottleneck first, state it, then optimize and verify with [benchmark/test].' },
];
const commands = [
  { ico: '📚', name: 'Prompt library: insert a task template', act: () => void showPromptLibrary() },
  { ico: '📋', name: 'Edit project rules (.forge/RULES.md)', act: () => void editRules() },
  { ico: '⑂', name: 'Git: commit current state', act: async () => { await window.studio.gitCommit(state.workspace, 'forge: manual commit'); void refreshGitChip(); toast('committed', 'ok'); } },
  { ico: '🌿', name: 'Branch: isolate this chat in its own worktree', act: () => void createThreadBranch() },
  { ico: '🔀', name: 'Branch: merge this chat\'s branch into main', act: () => void mergeThreadBranch() },
  { ico: '🗑', name: 'Branch: discard this chat\'s branch', act: () => void discardThreadBranch() },
  { ico: '⌫', name: 'Git: undo all changes since last commit', act: async () => { if (!confirm('Hard reset to last commit? Agent-made and your uncommitted changes will be lost.')) return; await window.studio.gitUndo(state.workspace); void refreshGitChip(); void initTree(); toast('reset to last commit', 'ok'); } },
  { ico: '⤓', name: 'Export current chat as markdown', act: () => state.sessionId ? void window.studio.exportSession(state.sessionId) : toast('no chat to export') },
  { ico: '▶', name: 'Start live preview', act: async () => { await window.studio.previewStart(state.workspace); showPreview(); switchTab('preview'); } },
  { ico: '⚙', name: 'Open settings', act: () => $('btn-settings').click() },
  { ico: '✚', name: 'New chat', act: () => { newChat(); toast('new chat'); } },
  { ico: '📂', name: 'Open workspace folder', act: () => $('proj-btn').click() },
  { ico: '◇', name: 'Change model', act: () => { $('model-pop').classList.add('open'); $('model-search').focus(); } },
  { ico: '✏️', name: 'Show Diffs pane', act: () => switchTab('diffs') },
  { ico: '📂', name: 'Show Files pane', act: () => switchTab('files') },
  { ico: '▸', name: 'Show Terminal pane', act: () => switchTab('term') },
  { ico: '🔑', name: 'Show Keys pane', act: () => switchTab('keys') },
  { ico: '🔌', name: 'Show MCP pane', act: () => switchTab('mcp') },
  { ico: '↩', name: 'Undo last change (checkpoint)', act: () => $('btn-undo').click() },
  { ico: '⟳', name: 'Rescan local models (Ollama / LM Studio)', act: async () => { state.models = await window.studio.scanLocal(); renderModelList(); toast('local providers rescanned', 'ok'); } },
];
const palInput = $('palette-input');
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    $('palette').classList.add('open');
    palInput.value = ''; renderPalette('');
    palInput.focus();
  }
  if (e.key === 'Escape') closePop();
});
function renderPalette(q) {
  const list = commands.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  $('palette-list').innerHTML = list.map((c, i) =>
    `<div class="pitem ${i === 0 ? 'sel' : ''}"><span class="p-ico">${c.ico}</span>${esc(c.name)}</div>`).join('') || '<div class="empty">No commands</div>';
  $('palette-list').querySelectorAll('.pitem').forEach((p, i) => p.addEventListener('click', () => { closePop(); list[i].act(); }));
}
palInput.addEventListener('input', () => renderPalette(palInput.value));
function showPromptLibrary() {
  $('palette').classList.add('open');
  palInput.value = '';
  $('palette-list').innerHTML = PROMPT_LIBRARY.map((t, idx) =>
    `<div class="pitem" data-tpl="${idx}"><span class="p-ico">${t.name.slice(0, 2)}</span><span style="flex:1">${esc(t.name.slice(2).trim())}</span></div>`).join('');
  $('palette-list').querySelectorAll('.pitem').forEach((el) => el.addEventListener('click', () => {
    closePop();
    promptEl.value = PROMPT_LIBRARY[Number(el.dataset.tpl)].body;
    autoSize(); promptEl.focus();
    toast('template inserted — fill in the [brackets]');
  }));
}
async function editRules() {
  if (!state.workspace) return toast('open a folder first', 'warn');
  const cur = await window.studio.getRules(state.workspace);
  const next = prompt('.forge/RULES.md — rules the agent follows in this project:', cur || '# Project rules\n\n- Use TypeScript strict mode\n- Run `npm test` after changes\n');
  if (next === null) return;
  await window.studio.setRules(state.workspace, next);
  toast('rules saved — agent uses them from the next run', 'ok');
}
window.editRules = editRules;
palInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const items = [...$('palette-list').querySelectorAll('.pitem')];
    const sel = items.findIndex((x) => x.classList.contains('sel'));
    const list = commands.filter((c) => c.name.toLowerCase().includes(palInput.value.toLowerCase()));
    if (list[sel >= 0 ? sel : 0]) { closePop(); list[sel >= 0 ? sel : 0].act(); }
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...$('palette-list').querySelectorAll('.pitem')];
    const sel = items.findIndex((x) => x.classList.contains('sel'));
    items.forEach((x) => x.classList.remove('sel'));
    const next = e.key === 'ArrowDown' ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
    items[next]?.classList.add('sel');
  }
});
$('palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePop(); });
$('model-pop').addEventListener('click', (e) => { if (e.target.id === 'model-pop') closePop(); });

/* gutters (panel resize) */
function makeGutter(gid, panel, dir) {
  const g = $(gid);
  g.addEventListener('mousedown', (e) => {
    e.preventDefault(); g.classList.add('dragging');
    const startX = e.clientX, startW = panel.offsetWidth;
    const move = (ev) => {
      const w = dir === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX);
      panel.style.width = Math.max(180, Math.min(560, w)) + 'px';
    };
    const up = () => { g.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
}
makeGutter('gutter-left', $('sidebar'), 'left');
makeGutter('gutter-right', $('right-rail'), 'right');

/* dev hook: scripted screenshots + debugging (window.__forge) */
window.__forge = { state, renderTranscript, renderDiffs, renderKeys, renderCheckpoints, renderManager, switchTab, openFileViewer, initTree, updateWorkspaceUi, refreshGitChip, renderModelButton, showPreview, autoSize };

/* ═══════════ BOOT ═══════════ */
async function refreshProvidersAndModels() {
  state.models = await window.studio.getModels();
  if (!state.providers?.length) state.providers = await window.studio.getProviders();
  const saved = (await window.studio.getSettings()).model;
  // keyless-first default: prefer an online local model, else first free-tier model.
  // a saved model only wins if its provider actually has a key (or is local/online)
  const local = state.models.find((m) => m.provider === 'ollama' || m.provider === 'lmstudio');
  const free = state.models.find((m) => ['gemini', 'groq', 'cerebras', 'openrouter'].includes(m.provider));
  const savedMeta = saved ? modelMeta(saved) : null;
  const savedUsable = savedMeta && state.models.some((m) => m.id === saved)
    && (savedMeta.isLocal ? savedMeta.p.online : savedMeta.p.hasKey);
  const chosen = savedUsable ? state.models.find((m) => m.id === saved)
    : local ?? free ?? state.models[0];
  state.model = chosen?.id ?? 'gemini/gemini-flash-latest';
  window.studio.setSettings({ model: state.model });
  renderModelButton();
  renderSetupHint();
}
(async () => {
  const settings = await window.studio.getSettings();
  if (settings.workspace) {
    state.workspace = settings.workspace;
    updateWorkspaceUi();
    await initTree();
  }
  state.mcpServers = await window.studio.listMcp();
  renderMcp();
  await refreshProvidersAndModels();
  await refreshSessions();
  // warm local scan in background — if it finds local models and current model has no key,
  // switch to keyless local (also covers the boot race where scan finished after default pick)
  window.studio.scanLocal().then((models) => {
    state.models = models;
    void refreshProvidersAndModels();
  });
})();
