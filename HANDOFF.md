# ForgeStudio / ForgeGateway — Project Handoff Document

_Generated 2026-11. Purpose: share full project state with Claude (or any AI assistant) to continue development._

---

## 1. What this project is

**ForgeStudio** is a local desktop AI coding agent app (Electron, macOS/Windows), built as a self-hosted, architecture-study mirror of DeepAI Code (the free AI coding IDE by DeepAI). It is **private — never pushed to GitHub**.

It consists of:

1. **ForgeGateway** — a local HTTP gateway (`http://127.0.0.1:4180`) that sits between the app UI and AI model providers. It mirrors the 4-layer architecture of real commercial agent gateways:
   - Layer 1: HMAC-signed 30-minute session tokens (timing-safe comparison, fixed after a `timingSafeEqual` length-mismatch crash was caught in testing)
   - Layer 2: OpenAI-compatible proxy (`/v1/chat/completions`, `/v1/models`)
   - Layer 3: credit metering per model (1× default, 5× for deep models), persisted in `gateway-state.json`
   - Layer 4: rate limits (session / weekly / credit caps per plan — study: 1,000 credits, heavy: 7,000)
   - Master key for local access: `forge-local-master`
   - Source: `src/index.ts` (headless TypeScript version) + `app/main.js` (the Electron-embedded version, which is the live one)

2. **ForgeStudio app** (`app/` directory) — Electron desktop app, CommonJS (`main.js` + `preload.js` + `ui/`), features:
   - Chat with an AI agent that has 5 tools: read_file, write_file, list_dir, run_command, edit_file
   - **Multi-file diff preview**: agent `write_file` calls are STAGED, not written — they appear in a Diffs pane with line-level +/− diffs; user clicks Apply (writes to disk) or Discard per file (mirrors DeepAI Code's review-keep-undo model)
   - **Session resume + history**: each chat auto-saves to `userData/sessions/{id}.json` (id, title, created, updated, workspace, model, messages, pending); click to restore
   - **MCP tool support**: add stdio MCP servers; JSON-RPC handshake (initialize → tools/list) shows tool counts
   - **Multi-provider model picker** (just completed):
     | Provider | Base URL | Free tier |
     |---|---|---|
     | Google Gemini ⭐ default | `https://generativelanguage.googleapis.com/v1beta/openai/` | ~1,500 req/day, no card |
     | Groq | `https://api.groq.com/openai/v1` | ~1,000 req/day |
     | Cerebras | `https://api.cerebras.ai/v1` | 1M tokens/day |
     | OpenRouter | `https://openrouter.ai/api/v1` | 50 req/day on `:free` models (Gemma 4 31B, Nemotron 3.5, Ling 3.2) |
     | Z.ai GLM (paid) | `https://api.z.ai/api/paas/v4` | none — user's key currently has insufficient balance (error 1113) |
   - Model IDs are namespaced `provider/model` (e.g. `gemini/gemini-flash-latest`); keys stored per-provider in `userData/keys.json`; free-first ordering in the picker; OpenRouter requests get `HTTP-Referer`/`X-Title` headers
   - **Verified working**: gateway serves all 10 models across 5 providers; app boots clean

## 2. File map (~/Downloads/forgecode-gateway)

```
forgecode-gateway/
├── src/index.ts              # headless gateway (TypeScript, v0.2)
├── app/                      # ForgeStudio Electron app (v0.3, the live one)
│   ├── main.js               # CJS main process (~520 lines): gateway server,
│   │                         #   agent loop, 5 tools, diff staging, sessions,
│   │                         #   MCP handshake, PROVIDERS registry, workspace IPC
│   ├── preload.js            # contextBridge: studio.* API (getModels, getProviders,
│   │                         #   setProviderKey, pickFolder, fileTree, readFile,
│   │                         #   sendPrompt, applyAll, discardAll, mcp*, sessions)
│   ├── preload.cjs           # older preload (legacy)
│   ├── package.json          # main: main.js
│   └── ui/
│       ├── index.html        # current UI (v0.3 dark #0B0C0F / accent #B7FF45)
│       └── ui.js             # UI logic (~250 lines)
├── release/ForgeGateway-0.3.0-arm64.dmg   # built macOS DMG (94MB)
├── gateway-state.json        # persisted credit usage
├── .env.local                # z.ai GLM key (gitignored)
└── README.md                 # includes free-models research + launch notes
```

## 3. Key technical decisions / gotchas (important for continuation)

- **Electron launch**: this dev environment sets `ELECTRON_RUN_AS_NODE=1` globally, which silently breaks Electron (it runs as plain Node, `app` = undefined). MUST launch with:
  ```bash
  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron app
  ```
- **path.txt fix**: if `node_modules/electron/` is missing `path.txt`, the shim falls back to system Node. Correct content: `Electron.app/Contents/MacOS/Electron` (relative — the shim prepends `dist/`).
- **CJS discipline**: main process is CommonJS (`require`), no `"type": "module"` in app/package.json.
- **Staged writes**: agent `write_file` → pending diff entries `{path, before, after, status}` → applied only on user click. `run_command` executes immediately.
- **Model namespacing**: `provider/model` IDs everywhere; `resolveModel(fullId)` splits and looks up `PROVIDERS[providerId]`; z.ai fallback for bare IDs.
- **Metering**: `MODEL_MULTIPLIER = { 'zai/glm-5.3': 5 }`, everything else 1 credit.
- Session token: base64url payload + HMAC signature with `CONFIG.masterKey`, TTL 30 min.

## 4. Current state of the UI (and what's next)

Current UI (v0.3) works but is basic. **A full redesign was just started** (DeepAI Code-style: left sidebar with Project folder picker + chat thread list + model picker; center chat column with welcome screen + composer; right rail with Files tree / Diffs review / MCP / Keys panes). A new `index.html` was drafted but NOT yet written to disk, and `ui.js` was not rewritten to match. Remaining UI work:

1. Write the redesigned `ui/index.html` + rewrite `ui/ui.js` (new `window.studio` API surface is already in preload.js: `pickFolder`, `fileTree`, `readFile`)
2. New IPC already added in main.js: `studio:pickFolder` (dialog.showOpenDialog), `studio:fileTree` (3-level walk, skips node_modules/.git/dist/build), `studio:readFile`, plus `currentWorkspace` global used as agent default cwd
3. File viewer pane (click a file in tree → view contents in right rail)
4. Toast notifications, diff keep/discard per file, diff count badge
5. Rebuild DMG after UI is done

Design language: bg `#0B0C0F`, rail `#101216`, panels `#14161B`, line `#232528`, accent `#B7FF45` (lime), accent2 `#9AA7FF`, danger `#FF6157`, mono font for labels/model ids, 10px radii.

## 5. Related projects (same author's ecosystem, for context)

- **ForgeCode** (`~/Downloads/forgecode`) — multi-platform monorepo sibling: `packages/core` (platform-agnostic Agent + Executor interface), `packages/web` (browser IDE on WebContainer), `packages/desktop` (Electron), `packages/vscode-ext` + `packages/vscode-webview`. All targets compile; commit `cca4b5d`. This is the public/open version; ForgeGateway is the private learning version.
- **pubdev-mcp** — published npm MCP server for pub.dev package intelligence (`npx -y pubdev-mcp`).
- GitHub: `Awaisdev01` (active account, 20 repos). Old account `awaisdev5765` is suspended/404.

## 6. Verified research on free models (so future work doesn't redo it)

- FREE and OpenAI-compatible: Gemini API free tier (best, ~1,500 req/day), Groq (~1,000/day), Cerebras (1M tok/day), OpenRouter `:free` (50/day, rotating list — currently Gemma 4, Nemotron 3.5 family, Ling 3.2, Ernie 5.5 preview)
- NOT free: DeepSeek API, Qwen (free OAuth tier discontinued Apr 2026), MiMo/Xiaomi (no public API), GLM/z.ai (pay-per-token)
- Total free stack ≈ 2,500+ requests/day at $0/month

## 7. How to run / test

```bash
cd ~/Downloads/forgecode-gateway
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron app
# gateway on http://127.0.0.1:4180, master key: forge-local-master
curl -s localhost:4180/v1/models -H "Authorization: Bearer forge-local-master"
```

User needs to paste a free Gemini key (aistudio.google.com) into the app's Keys pane (or `userData/keys.json`) for live agent runs; z.ai key is present but out of balance.
