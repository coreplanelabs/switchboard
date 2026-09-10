# Rotate a secret

Replace a credential on a running installation, no image build or release: put the new value, then restart the bot.

**You need:**

- The deployment profile in reach: the operator directory, or `SWITCHBOARD_DEPLOY_PROFILE=github://…/profile.json@main` plus `CONFIG_REPO_TOKEN` for a private repository.
- `CLOUDFLARE_API_TOKEN` for the profile's account; a mis-scoped one fails the put with `Authentication error [code: 10000]`.
- The new value where the profile's `secretsSource` reads it: a `<NAME>` file in the secrets directory (`~/.secrets/switchboard` by default) or a field of the profile's 1Password item.
- For the restart, an ingress bearer whose subject holds `deploy:write`, in `SWITCHBOARD_DEPLOY_TOKEN`.

## Find every Worker that holds it

`deploy/secrets.manifest.json` lists each Worker's secrets. A **shared** bearer (`MEMORY_TOKEN`, `SANDBOX_TOKEN`, `RESIDENT_*_TOKEN`) must be the same value on every Worker listed for it; rotate it everywhere.

## Put the new value

```bash
npx @coreplane/switchboard deploy secrets <memory|bot|resident|sandbox> --only <NAME>
```

The command refuses before any upload when a required name is absent from the source, then passes each value to `wrangler secret put` on stdin; nothing is printed. It renders the Worker's `wrangler.jsonc` itself, so no `deploy init` first.

## Restart the bot

```bash
SWITCHBOARD_DEPLOY_TOKEN=<token> npx @coreplane/switchboard deploy restart
```

A put does not restart the container; it keeps the environment it started with. `deploy restart` drains it and starts the next request on the new environment; runs in flight hand off to the next container. It is done once `/healthz` reports a later `startedAt`, about 30 seconds.

Rotating `SWITCHBOARD_INGRESS_TOKENS` works the same way, the deployer's own entry included: `deploy restart` with the **new** token works right after the put, because the Worker authenticates it from its already-updated environment. Keep the subjects unchanged; `grants` entries key on them.

## Update CI where it holds a copy

`RESIDENT_READ_TOKEN` and `SANDBOX_TOKEN` are also held by the CI that deploys releases ([Deploy](deploy.md#deploy-from-your-ci)). Set the new value there too.

## Next

- [Operate production](operate-production.md#change-the-config-without-a-release): `deploy config` is the same put and restart.
- [Deploy](deploy.md#stage-the-secrets): the first-time secrets put.
