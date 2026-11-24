# forgecode-gateway (study project)

A local OpenAI-compatible AI gateway that mirrors GitHub Copilot's real architecture,
built to understand how such systems work. **Personal study project — private, not
for distribution.**

## The 4 layers (and which Copilot system each mirrors)

| Layer | What it does | Copilot equivalent |
|---|---|---|
| 1 · Session tokens | HMAC-signed 30-min tokens minted from a master key; verified per request with timing-safe comparison | `copilot_internal/v2/token` (the reason Copilot "randomly errors" = token expiry + quota) |
| 2 · Model gateway | OpenAI-compatible `/v1/chat/completions` + `/v1/models`, proxying to a real provider | `api.githubcopilot.com` (an OpenAI-style proxy: GPT via Azure, Claude direct) |
| 3 · Usage metering | Per-plan credits with per-model multipliers, persisted weekly ledger | server-side premium-request counting (model multipliers!) |
| 4 · Rate limiting | Session request caps + weekly caps + credit exhaustion → distinct errors | session limits / weekly limits / 402-style billing errors |

## Run

```bash
GW_UPSTREAM_URL=https://api.z.ai/api/paas/v4 \
GW_UPSTREAM_KEY=<your key> \
GW_MASTER_KEY=<pick-a-secret> \
npm start
# → http://127.0.0.1:4180
```

## Use from any client

```bash
# mint a session token (30 min):
curl -X POST localhost:4180/token \
  -H 'Content-Type: application/json' \
  -d '{"masterKey":"<secret>","plan":"study"}'

# use it like an OpenAI API:
curl localhost:4180/v1/chat/completions \
  -H "Authorization: Bearer <session-token>" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

# check your metering:
curl localhost:4180/usage -H "Authorization: Bearer <session-token>"
```

Or point ForgeCode / Cline / any OpenAI-compatible client at
`http://127.0.0.1:4180/v1` with the session token as the API key.

## What I learned building it

- Why Copilot's bearer tokens are short-lived (leak window) and why refreshing
  mid-request is hard (the race is why Copilot sometimes errors)
- Why model multipliers exist (compute cost differs per model; the gateway
  meters credits, not requests)
- Why session limits differ from weekly limits (burst protection vs. fairness)
- Timing-safe comparison subtleties: `timingSafeEqual` throws on length mismatch
  — tampered signatures crash naive implementations (we hit it in testing!)

State is persisted to `gateway-state.json` so restarts don't reset your usage
(mirroring Copilot's server-side accounting).
