# @coreplane/switchboard

The OpenSwitchboard command line: the installer and the operator commands of [Switchboard](https://github.com/coreplanelabs/switchboard), an agent gateway — mention it in Slack and an agent reviews the PR, ships the fix, or answers the question, on the model you choose, with its tools running where you decide.

```bash
mkdir switchboard && cd switchboard
npx @coreplane/switchboard init --organization <your GitHub org> --anthropic-key <your key>
npx @coreplane/switchboard ask "what can you do?"
```

`init` writes `.env` (mode 600) and `config/config.yaml` into the current directory from the examples this package ships; `ask` runs the whole pipeline with your terminal as the channel. `switchboard help` lists every command; `switchboard <group> <verb> --help` explains one.

The bot itself — the always-on process that connects to Slack — is the published container image, `ghcr.io/coreplanelabs/switchboard`; deploying it on Cloudflare starts from a checkout of the repository. Everything else: <https://openswitchboard.dev>.
