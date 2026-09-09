# Add a model provider

Route models from a new provider — a hosted API or a server on your own machine — through OpenSwitchboard, so a `model:` directive and `defaults.models` can name them.

## Before you start

- Access to the installation's `config.yaml` and the environment the bot runs in.
- The provider's API base URL and an API key. Keys are read from environment variables only, never from config files.

## 1. If the API is OpenAI-compatible, add a block

Anything that speaks the OpenAI `/chat/completions` shape needs no code:

```yaml
providers:
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

A local server works the same way: `baseUrl: http://localhost:11434/v1` for Ollama.

## 2. Set the key and restart

Put `GROQ_API_KEY` in the bot's environment (`.env` locally) and restart. A missing key fails fast, by name.

## 3. Use it

The provider's models are now valid anywhere a model is accepted, as `groq/<model-id>`: a `model:` directive, `config set`, or a `defaults.models` entry ([Configure your defaults](configure-your-defaults.md)).

## If the API is not OpenAI-shaped

Write an adapter. Implement the `Provider` interface from `src/providers/types.ts` in a new file beside the two existing implementations (`anthropic.ts`, `openaiCompat.ts`), add its `type` to the switch in `src/providers/registry.ts`, and give it tests beside theirs. An adapter turns "call this model with these messages and tools" into one vendor's HTTP shape and back; it knows nothing about channels, permissions or where tools run. Effort (`low` through `max`) is passed through only when the model supports it. The contract an adapter must keep is in the [run loop](../reference/specs/run-loop.md) spec.

## What you did

You added a provider behind the seam every other provider sits behind; the dispatcher never learned it exists. Why the boundary is an interface with more than one implementation: [the decision record](../decisions/0001-seams-with-two-implementations.md).

## See also

- [How a request flows](../explanation/how-a-request-flows.md) — where the provider sits in the pipeline.
- [Add an agent](add-an-agent.md) — the other seam you extend without touching the dispatcher.
