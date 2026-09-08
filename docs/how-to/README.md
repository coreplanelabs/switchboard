# How-to guides

**"How do I do X?"** A how-to guide is a recipe for a goal you already have. It assumes you know the basics, it addresses the real world (including its complications), and it points at the [reference](../reference/) rather than repeating it.

If you're new and want a guided first success instead, start with a [tutorial](../tutorials/).

- [Set up accounts](set-up-accounts.md) — the Slack app from its manifest, model keys, the GitHub App step by step, and what Cloudflare, E2B and Brave each buy.
- [Deploy](deploy.md) — Cloudflare, the one supported target: the profile, `deploy init`, `deploy secrets`, `deploy config`, `deploy all`, and what the release workflow does with them.
- [Configure your defaults](configure-your-defaults.md) — agent, model, and effort, per you or per channel.
- [Connect an MCP server](connect-an-mcp-server.md) — give an agent tools from Linear, Notion, or your own service.
- [Onboard a repo](onboard-a-repo.md) — make a repo always-warm instead of cloning cold every time.
- [Watch a run and check spend](watch-a-run-and-check-spend.md) — the dashboard: live runs, history, stopping one, costs.
- [Restrict who can do what](restrict-who-can-do-what.md) — `grants` and `restrict`, built up from open to locked down.
- [Add a provider or an agent](add-a-provider-or-agent.md) — extend Switchboard without touching the dispatcher.
- [Deploy for the first time](deploy-for-the-first-time.md) — the profile, the secrets, the first `deploy all`, and what any other host must provide.
- [Deploy and rotate a secret](deploy-and-rotate-a-secret.md) — the one command to ship, the runbook to rotate a credential.
- [Configure the repository](configure-the-repository.md) — the GitHub settings a fork reproduces: squash-only merges, the required checks, the merge queue.
- [Operate production](operate-production.md) — deploys from the release, deploy order, preflights, rotating a bot secret, keeping the service graph current.
- [Turn features on and off](turn-features-on-and-off.md) — the capability matrix: the config block that turns each feature on, what appears, what disappears, what it costs.
