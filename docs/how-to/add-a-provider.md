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
    wire: openai-chat
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
```

OpenAI itself is the same shape, as the example configuration's `openai:` block shows — with the same limits that block's comment names (Chat Completions only, no reasoning control, tokens metered but not priced). An aggregator is the same shape too: the example config carries a commented OpenRouter block, and [Configure your defaults](configure-your-defaults.md) says what the compatible adapter does not do for it. A local server is the same shape; Ollama, for example:

```yaml
providers:
  local:
    wire: openai-chat
    baseUrl: http://localhost:11434/v1
```

`wire` is the new spelling for the shape — `anthropic-messages`, `openai-chat` or `openai-responses`. The old `type` words (`anthropic`, `openai-compatible`) still load as their wire for one release, and a block may declare either, never both.

## What else a block declares

A block carries what a run needs to know about its models (record 0052):

| Key | Means |
|---|---|
| `wire` | the shape the block speaks — `anthropic-messages`, `openai-chat` or `openai-responses` |
| `vendor` | the vendor whose models the block serves: a name, or `model` when the block is an aggregator and each model id names its vendor first (`openrouter/anthropic/claude-sonnet-4`) |
| `catalog` | the pi registry file this block's cards are read from — default, the block's own name when the library ships such a file; `none` for a local server with no catalog |
| `models.<id>` | the operator's per-model override: `levels` (our effort words → the wire's word, or `null` to refuse one), `capField`, `window`, `inputs`, `cache`, `price` |
| `passthrough` | extra body fields merged into every request (a vendor-only feature), never a control |

Nothing is required beyond `wire` (or its `type` alias) and, for a keyed provider, `apiKeyEnv`; the registry card and the wire's own defaults fill the rest, and a field no layer names goes out unvouched with a note on the run's record saying so. Set `models.<id>` where you know better than the registry.

## Set the key and restart

Put `GROQ_API_KEY` in the bot's environment (`.env` locally) and restart. A missing key fails fast, by name.

## Use it

The provider's models are now valid as `groq/<model-id>` anywhere a model is accepted:

- a `model:` directive
- `config set`
- a `defaults.models` entry ([Configure your defaults](configure-your-defaults.md))

## Check the block against the provider

The last step of adding a block: run `providers check` (chat, CLI — `npm run cli -- providers check` — HTTP or MCP). For each aggregator model the configuration names it reads the provider's own endpoints listing and prints where the resolved card disagrees — supported parameters, context length, modalities — with the `models.<id>` override that would pin each fact ([model-proxy.md](../reference/specs/model-proxy.md) item 12). Pin what it reports before leaning on the model: a fact no layer vouches for goes out unvouched with a note on the run's record. When a pi bump drops a card the example config still names, `npm run check:registry-drift` (part of `check:consistency`) fails by name.

## Any other wire shape

There is no adapter to write: Switchboard holds no model adapters of its own. A run's model calls are made by pi inside the run's container and go through the bot's model proxy, which forwards exactly two wire shapes — Anthropic Messages (`POST /v1/messages`) and OpenAI Chat Completions (`POST /v1/chat/completions`) — with the deployment's key ([model-proxy.md](../reference/specs/model-proxy.md)); the one door's, thread-reply gate's and memory reflection's calls go through pi's model library (`@earendil-works/pi-ai`, `src/core/harness/piAi.ts`), which reads the same two wires — `anthropic-messages` and `openai-chat` — off the same block ([harness-pi.md](../reference/specs/harness-pi.md) item 13). A block declaring `wire: openai-responses` is a declaration this release: the proxy serves that route in a later unit, and until then a run on it meets the provider's own answer. A new block of any declared wire needs nothing in code. A vendor that speaks none of the three needs a new wire: its API named in `piApiFor` (`src/core/harness/piAi.ts`) for the door, thread-reply gate and reflection, the shape `piModelsJson` writes for a run's pi (`src/core/harness/pi/process.ts`), the proxy's forward and meter for it (`src/channels/modelProxy.ts`, `src/core/modelProxy/usage.ts`), the card's cap field and cache rule (`src/core/modelCard.ts`), and the validator that admits the wire (`src/config/validate.ts`) — with tests beside each.

## Next

- [Seams with two implementations](../decisions/0001-seams-with-two-implementations.md): why the boundary is an interface.
- [How a request flows](../explanation/how-a-request-flows.md): where the provider sits in the pipeline.
- [Add an agent](add-an-agent.md): the other seam you extend without touching the dispatcher.
