# Add a model provider

Route a new provider's models through OpenSwitchboard, so a `model:` directive and `defaults.models` can name them.

**You need:**

- Write access to the installation's `config.yaml` and the environment the bot runs in.
- The provider's API base URL and an API key. Keys are read from environment variables only, never from config files.

## Add the block

Anything that speaks the OpenAI `/chat/completions` shape needs no code:

```yaml
providers:
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

An aggregator is the same shape too: the example config carries a commented OpenRouter block, and [Configure your defaults](configure-your-defaults.md) says what the compatible adapter does not do for it. A local server is the same shape; Ollama, for example:

```yaml
providers:
  local:
    type: openai-compatible
    baseUrl: http://localhost:11434/v1
```

## Set the key and restart

Put `GROQ_API_KEY` in the bot's environment (`.env` locally) and restart. A missing key fails fast, by name.

## Use it

The provider's models are now valid as `groq/<model-id>` anywhere a model is accepted:

- a `model:` directive
- `config set`
- a `defaults.models` entry ([Configure your defaults](configure-your-defaults.md))

## Write an adapter for any other shape

Implement the `Provider` interface from `src/providers/types.ts` in a new file beside `anthropic.ts` and `openaiCompat.ts`. Add its `type` to the switch in `src/providers/registry.ts`, with tests beside theirs.

An adapter turns one model call into a vendor's HTTP shape and back; it knows nothing about channels, permissions or where tools run. The contract is the [run loop](../reference/specs/run-loop.md) spec.

## Next

- [Seams with two implementations](../decisions/0001-seams-with-two-implementations.md): why the boundary is an interface.
- [How a request flows](../explanation/how-a-request-flows.md): where the provider sits in the pipeline.
- [Add an agent](add-an-agent.md): the other seam you extend without touching the dispatcher.
