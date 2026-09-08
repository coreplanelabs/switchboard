# How a request flows

Every entry point — a Slack mention, a CLI `ask`, an HTTP dispatch — reduces to the same four seams, in the same order, handled by the same code. There is exactly one orchestrator; everything else plugs into it.

```mermaid
flowchart LR
    subgraph channels ["Channel — pure transport"]
        SL["Slack"]
        CLI["CLI ask"]
        FUT["HTTP / MCP dispatch"]
    end

    D{"Core dispatcher<br/>the ONLY place orchestration lives"}

    subgraph providers ["Provider — the model"]
        P["anthropic / openai-compatible"]
    end

    subgraph exec ["Executor — where tools run"]
        E["local / sandbox / resident"]
    end

    SL & CLI & FUT -->|"IncomingMessage"| D
    D <-->|"complete()"| P
    D <-->|"bash / read / write"| E
    D -->|"reply"| SL & CLI & FUT
```

## What each seam refuses to know about the others

- **A channel adapter** turns a platform event into one shape (`IncomingMessage`) and turns a reply back into platform calls (chunking a Slack message, editing a status card, printing to stdout). It has zero opinion on which agent runs, which model answers, or where a tool executes — it doesn't import anything from `providers/` or `execution/`.
- **The dispatcher** is the only place that reads directives, resolves the six-layer config (see [config layers](config-layers.md)), checks permissions, assembles history, and runs the agent loop. It never imports a platform SDK — there is no `import bolt from '@slack/bolt'` anywhere near it. This is enforced, not just conventional: adding Slack-specific logic here would be a bug, not a style nit.
- **A provider adapter** turns "call this model with these messages and tools" into one vendor's HTTP shape and back. It knows nothing about Slack, permissions, or where the tools it's being asked to call will actually run.
- **An executor** runs a tool call somewhere — the bot host, a per-thread sandbox, an always-warm resident — and returns a result. It has no idea which agent asked, what model is driving the loop, or which channel started it.

The same pattern at every seam — one interface, more than one implementation, and a fixed way to add one:

| Seam | Interface | Implementations today | Adding one |
|---|---|---|---|
| Channel | `ChannelIO` + `IncomingMessage` (`src/core/types.ts`) | Slack (Socket Mode), the CLI's `ask`, HTTP ingress, MCP | one adapter file in `src/channels/` |
| Provider | `Provider` (`src/providers/types.ts`) | Anthropic; OpenAI-compatible, which covers OpenAI, Groq, Ollama and vLLM with config alone | one adapter file, or just a config block |
| Executor | `Executor` (`src/execution/executor.ts`) | the bot host; an E2B micro-VM per thread; a Cloudflare Sandbox per thread through the sandbox Worker; a resident repo environment through the resident Worker | one backend file plus config |
| Agent | `AgentDef` data (`src/agents/registry.ts`) | `general`, `coding`, `review`, `ship`, `research` | one registry entry |

A channel adapter translates exactly three things: an incoming platform event into an `IncomingMessage`, a history fetch into `HistoryItem[]`, and replies and status back into platform calls (chunking, formatting and message editing are the adapter's concern). Identifiers are namespaced by platform — `slack:C…` for a channel, `slack:U…` for a user, `slack:C…:<ts>` for a thread — so config scopes, grants and memory can key on them and a new adapter brings its own prefix. Everything else is the dispatcher's: directives, the six config layers, authorization against the resolved agent, one live run per thread, history assembly, and the agent loop itself.

## One real request, end to end

```mermaid
sequenceDiagram
    participant U as User (Slack)
    participant A as Slack adapter
    participant D as Dispatcher
    participant P as Provider
    participant E as Executor

    U->>A: "@switchboard agent:coding in acme/api: add retry to webhook sender"
    A->>D: IncomingMessage
    D->>D: parse directives → agent:coding
    D->>D: resolve config (request > thread > user > channel > defaults)
    D->>D: check permission: may this caller run coding?
    D->>D: assemble history from thread
    loop until the model stops, or the turn budget runs out
        D->>P: complete(messages, tools)
        P-->>D: text, or a tool call
        D->>E: run the tool call (read file, run tests, git push…)
        E-->>D: result
        D->>D: append result, continue
    end
    D->>A: final answer + status updates along the way
    A->>U: reply in-thread
```

Nothing above changes if `U` is typing at the CLI instead of Slack, or if `agent:review` runs against a local execution backend instead of a sandbox — the same four boxes, the same order, just different implementations plugged into each seam.

## Every step is measured

The request above is also one span tree ([docs/reference/specs/tracing.md](../reference/specs/tracing.md)). The adapter starts a root the moment the process sees the message; every awaited step the dispatcher takes is a child of it — reading the thread, resolving the repo, attaching the workspace, each model turn, each tool call, posting the reply — and the run's stream carries the streamed ones beside its content. The status card ticks from receipt and names the setup step in flight; when it closes, its detail leads with the request's shape: `32s getting ready · 2m 30s thinking · 55s in tools · 8s finishing up · 7s Switchboard overhead`. Nothing here is a second bookkeeping system: the spans are the timing, and the timeline, the card line and the friction report all read the same set. The bot's own work outside a request gets a root of its own on the same log — the reconnect catch-up pass, the shutdown drain — and so does every step of a deploy, with its live gate as a child whose `waitedMs` is the number the runner prints.

## One run per thread: replying while it works

A thread has one workspace (its sandbox or resident worktree), so it runs one agent at a time. Replying in a thread while its card is still spinning does not start a second run:

- **Every agent takes the reply as a follow-up.** You get a one-line ack — `↪ Folded into the *coding* run already in flight…` — and the running agent reads your message at its next step, alongside the results of the tool it was running. Nothing in flight is interrupted or redone. The run page stays one run: your follow-up is listed under the original request, with who sent it and when. If the agent had just finished writing its answer when your message landed, it keeps going with your message as the next turn instead of stopping. A review hears "also check the migration" or a re-review note mid-pass and folds it into the one review it posts; a ship pipeline hands your reply to whichever child round is running (coding or review), and a reply that lands between rounds is read by the next one.
- **Asking for a different agent mid-run is the one refusal**, for the one-workspace reason: `agent:review …` in a thread where coding is running gets `⏳ A *coding* run is already in flight…` and waits or goes in a new thread.
- **A follow-up is never lost.** If the run ends before reading it (it finished, hit its budget, or failed), the follow-up runs as its own turn in the thread. If an operator stopped the run from the dashboard, the follow-up is not run and you are told so — re-send it.

Operator commands (`help`, `runs stop …`, `config …`) are not runs and always answer inline, live run or not.

## Why this shape, not a framework-per-integration

The alternative — a Slack-specific pipeline, a separate CLI pipeline, HTTP handlers that reimplement resolution — is how integrations drift: fix a permission bug in one, forget the other three exist. Here, a bug fixed in the dispatcher is fixed everywhere at once, because there is nowhere else the logic could have been duplicated to. The same discipline shows up one layer down, in how operator commands (not agent runs — a separate, adjacent concept) are exposed identically across surfaces: see [one definition, every surface](one-command-many-surfaces.md).

## See also

- [Explanation: config layers](config-layers.md) — the resolution step in detail.
- [Explanation: execution and trust](execution-and-trust.md) — what "run the tool call" actually means once execution is sandboxed.
- [How-to: add a provider or agent](../how-to/add-a-provider-or-agent.md) — extending two of these seams without touching the other two.
