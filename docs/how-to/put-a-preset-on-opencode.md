# Put a preset on OpenCode

Run one preset's runs on OpenCode instead of pi. One line in `config.yaml` names the preset and the harness; nothing else about the run changes — the same run bearer as its only key, the same gate deciding every tool call in the bot, the same record on the run page — and the same line flips it back. Nothing runs on OpenCode until you write that line: every preset is on pi by default, and there is no setting that makes OpenCode the default for all of them.

**You need:**

- A deployment on a release whose images carry OpenCode beside pi (every image does; nothing to install).
- `PUBLIC_BASE_URL` set on the bot for a preset with a workspace (the run's container reaches the model proxy through it), or `PORT` for a preset without one (the process runs as a child of the bot over loopback) — the same two variables pi needs.
- `config.yaml` and a way to make a change live: a restart, or on Cloudflare `deploy config` then `deploy restart` ([Operate production](operate-production.md#change-the-config-without-a-release)).

## Name the preset

```yaml
harness:
  coding: opencode
```

The word is the harness's own name; the two that exist are `pi` and `opencode`, and any other fails the load naming both (`harness.coding: codex is not a harness; the harnesses are pi and opencode`). A preset the block does not name stays on pi, so this puts coding runs on OpenCode and leaves review, general and the rest where they were. Name several presets with one line each.

A run keeps the harness it started on. Its row records which harness runs it, and a restart of the bot resumes it on that harness whatever the block says by then — so you can change the word while runs are live: they finish where they began, and the next run opens on the new word.

## Roll back

```yaml
harness:
  coding: pi
```

Or delete the block. Runs in flight finish on OpenCode; the next coding run opens on pi.

## Tune OpenCode's compaction (optional)

```yaml
opencode:
  compaction:
    buffer: 20000
    keepTokens: 8000
```

OpenCode's own words, in tokens: `buffer` is kept free of the model's window before a compaction runs, `keepTokens` how much of the newest turns it keeps. Positive integers only; unset, OpenCode's defaults stand. This is the OpenCode twin of the `pi` block ([Configuration](../reference/configuration.md)) and applies to every run on OpenCode.

## What a run on OpenCode looks like

- **The run page reads as a pi run does**: the request, each step with its tool calls and results, the reply. Tool names are the record's shared vocabulary — `bash`, `read`, `edit`, `write`, `find`, `grep` — so OpenCode's `shell` shows as `bash` and its `glob` as `find`, and the card's tool line is the same.
- **Every one of OpenCode's own tool calls is decided in the bot before it runs.** A refused command appears in the step as a `tool_refused` note carrying the reason the model was shown — a push to a branch that is not the run's own, a write under a read-only identity. Switchboard's relayed tools (GitHub, memory, the run tools) run in the bot and are gated there, exactly as on pi.
- **The record names its harness.** The run's metadata carries `harness: opencode` (`runs get <id>` shows it), and the row's facts carry the server's pid, port and session, which is how a restart finds or rebuilds the process.
- **Effort has no effect on an OpenCode preset today.** OpenCode maps Switchboard's effort tier onto a model's declared reasoning variants, and the deployment's OpenCode configuration declares none, so `effort:` on a request and `defaults.efforts` are accepted and leave OpenCode's default. When a deployment declares variants, the tier will select one.
- **Follow-ups, stops and restarts behave the same.** A thread follow-up is steered into the running process as its next turn, a hard stop interrupts it, and a bot restart resumes the run on OpenCode from its record.

## What the gate does not enforce

The gate decides intent — which call runs — and the walls bound what an approved call can do: the run's container, the proxy holding the credentials, the token's scope and branch protection. Two walls are deferred by decision and hold by rule alone on both harnesses; they are named here so the choice stands in the open:

- **A per-run credential scoped to the run's branch.** The one-push-target rule is decided by the gate, not enforced by the credential: the token the container holds can push any unprotected branch, and a GitHub API write with it is bounded only by branch protection and the token's scope.
- **The harness process and the model's shell as different users.** The shell runs as the same user as the harness, so it can read the harness's secrets from its environment; on OpenCode, where the approval lives in the server the shell shares a password with, the shell could forge an approval reply. The bot detects a reply it did not send and fails the run closed after at most one tool call — enforcement by detection, the honest limit of OpenCode's gate ([harness.md](../reference/specs/harness.md) item 2).

## Related

- [The harness contract](../reference/specs/harness.md): the roster and the configuration word (item 8), OpenCode as the contract's object (item 13).
- [The pi harness](../reference/specs/harness-pi.md): pi's rows, and the default every preset starts on.
- [Configuration](../reference/configuration.md): the `harness`, `pi` and `opencode` blocks.
- [Watch a run](watch-a-run.md): the run page and the card.
