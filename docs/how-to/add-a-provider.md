# Add a model provider

Route a new provider's models through Switchboard, so a `model:` directive and `defaults.models` can name them.

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

## Any other wire shape

There is no adapter to write: Switchboard holds no model adapters of its own. A run's model calls are made by pi inside the run's container and go through the bot's model proxy, which forwards exactly two wire shapes — Anthropic Messages (`POST /v1/messages`) and OpenAI Chat Completions (`POST /v1/chat/completions`) — with the deployment's key ([model-proxy.md](../reference/specs/model-proxy.md)); the request router's and memory reflection's calls go through pi's model library (`@earendil-works/pi-ai`, `src/core/harness/piAi.ts`), which reads the same two `type`s — `anthropic` and `openai-compatible` — off the same block ([harness-pi.md](../reference/specs/harness-pi.md) item 13). A new block of either type needs nothing in code. A vendor that speaks neither shape needs a third `type`: its API named in `piApiFor` (`src/core/harness/piAi.ts`) for the router and reflection, the shape `piModelsJson` writes for a run's pi (`src/core/harness/pi/process.ts`), the proxy's forward and meter for it (`src/channels/modelProxy.ts`, `src/core/modelProxy/usage.ts`), and the validator that admits the `type` (`src/config/validate.ts`) — with tests beside each.

## Next

- [Seams with two implementations](../decisions/0001-seams-with-two-implementations.md): why the boundary is an interface.
- [How a request flows](../explanation/how-a-request-flows.md): where the provider sits in the pipeline.
- [Add an agent](add-an-agent.md): the other seam you extend without touching the dispatcher.
