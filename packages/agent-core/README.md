# forge-agent-core

Portable AI coding-agent loop — the engine behind [ForgeStudio](https://github.com/Awaisdev01).

**Zero dependencies** (Node 18+ global fetch). MIT.

- OpenAI-compatible providers: Ollama, LM Studio, Gemini, Groq, Cerebras, OpenRouter, any custom
- Live local-model discovery (`/api/tags`, `/v1/models`)
- SSE streaming with tool-call accumulation + token usage capture
- Automatic free-tier fallback chain (429/402/quota → next provider, local models last)
- Generator-based run loop: `for await (const ev of agent.run(...))`

```js
const { createAgent } = require('forge-agent-core');
const agent = createAgent({ keys: { gemini: process.env.GEMINI_API_KEY } });
for await (const ev of agent.run({ messages, model: 'gemini/gemini-flash-latest', tools })) {
  if (ev.type === 'delta') process.stdout.write(ev.text);
  if (ev.type === 'await-tool') yield* myToolExecutor(ev); // your implementations
}
```
