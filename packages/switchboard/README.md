# @coreplane/switchboard

The OpenSwitchboard command line: the installer and the operator commands of [Switchboard](https://github.com/coreplanelabs/switchboard), an agent gateway — mention it in Slack and an agent reviews the PR, ships the fix, or answers the question, on the model you choose, with its tools running where you decide.

```bash
mkdir switchboard && cd switchboard
npx @coreplane/switchboard init --organization <your GitHub org> --anthropic-key <your key>
npx @coreplane/switchboard ask "what can you do?"
```

`init` writes `.env` (mode 600) and `config/config.yaml` into the current directory from the examples this package ships; `ask` runs the whole pipeline with your terminal as the channel. `switchboard help` lists every command; `switchboard <group> <verb> --help` explains one.

The bot itself — the always-on process that connects to Slack — is the published container image, `ghcr.io/coreplanelabs/switchboard`. The deploy commands (`init --cloudflare`, `deploy plan|init|secrets|config|images|all`) run from the directory you ran `init` in, no checkout needed: the profile `init` writes says `"images": "registry"`, so every Worker, the bot included, runs the image the release published, and `deploy all` copies it once per version into your Cloudflare account's registry itself — over HTTPS, with a Cloudflare API token that has Containers Edit; nothing is built where you deploy and no Docker is involved ([Deploy](https://openswitchboard.dev/how-to/deploy#deploying-from-the-package)). If you want the same command in CI, call the repository's reusable deploy workflow from a workflow of your own — `uses: <owner>/<repo>/.github/workflows/deploy-production.yml@v<version>` with `cli: package` ([Deploy from your CI](https://openswitchboard.dev/how-to/deploy#deploy-from-your-ci)). Everything else: <https://openswitchboard.dev>.
