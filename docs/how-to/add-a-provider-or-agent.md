# Add a provider or an agent

Goal: wire in a new model provider, or a new specialist agent, without touching the dispatcher.

Both of these are additions behind an existing seam — see [explanation: how a request flows](../explanation/how-a-request-flows.md) if you want the "why" before the "how".

## Add a provider

Anything that speaks the OpenAI `/chat/completions` shape needs **no code** — just a block in `config.yaml`:

```yaml
providers:
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

Set `GROQ_API_KEY` in the environment (API keys are only ever read from env vars, never from config files), then reference models anywhere a model is accepted as `groq/<model-id>` — a directive, a `config set`, or a `defaults.models` entry.

A provider with a genuinely different API (not OpenAI-shaped) needs a small adapter: implement the `Provider` interface in `src/providers/`, register it in `src/providers/registry.ts`. There are exactly two implementations today (`anthropic`, `openai-compatible`) to use as a template.

## Add an agent

An agent is data, not code — a prompt, a toolset, and turn/token budgets:

```ts
// src/agents/registry.ts
export const AGENTS = {
  // ...
  docs: {
    systemPrompt: '...',
    toolset: 'readonly',   // one of the existing named toolsets
    maxTurns: 20,
  },
};
```

Give it a default model in `config.yaml`:

```yaml
defaults:
  models:
    docs: anthropic/claude-haiku-4-5
```

That's it — it's now reachable as `agent:docs`, subject to the exact same config layering, permission gates, and run tracking as every built-in agent. There's no separate registration for "this agent shows up in Slack" vs "this agent shows up on the CLI" — every surface reads the same registry.

## See also

- `AGENTS.md`'s Map table for the exact files behind each seam (channel, provider, executor, agent).
- [Explanation: how a request flows](../explanation/how-a-request-flows.md).
