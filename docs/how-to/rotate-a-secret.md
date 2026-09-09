# Rotate a secret

Replace a credential on a running installation without rebuilding an image or cutting a release.

Putting a new secret value does **not** restart the running container: it keeps the environment it started with. Rotation is therefore two steps, a put and a restart.

## Before you start

- The deployment profile in reach. On a clean checkout export where it lives (`SWITCHBOARD_DEPLOY_PROFILE=github://…/profile.json@main`, plus `CONFIG_REPO_TOKEN` for a private repository); `deploy secrets` renders the Worker's `wrangler.jsonc` itself, so no `deploy init` is needed first.
- No `CLOUDFLARE_API_TOKEN` in the shell. Wrangler prefers such a token over your login, and a token scoped for another purpose fails the put with `Authentication error [code: 10000]`.
- The new value where the profile's `secretsSource` reads it: a `<NAME>` file in the secrets directory (`~/.secrets/switchboard` when the profile names none), or a field of the profile's 1Password item.
- For the restart, an ingress bearer whose subject holds `deploy:write`, in `SWITCHBOARD_DEPLOY_TOKEN`.

## 1. Find every Worker that holds it

`deploy/secrets.manifest.json` lists each Worker's secrets. A **shared** bearer (`MEMORY_TOKEN`, `SANDBOX_TOKEN`, `RESIDENT_*_TOKEN`) must be the same value on every Worker the manifest lists for it; rotate it everywhere it is listed, not only where you noticed it.

## 2. Put the new value

```bash
# in deploy/cloudflare/ — the bot Worker
npm run secrets -- --only <NAME>          # = `deploy secrets bot --only <NAME>`

# any Worker, from the repo root
npm run cli -- deploy secrets <memory|bot|resident|sandbox> --only <NAME>
```

The command asks the source which names it holds, refuses before any upload when a required one is absent, and passes each value to `wrangler secret put` on stdin; nothing is printed.

## 3. Restart the bot

```bash
SWITCHBOARD_DEPLOY_TOKEN=… npm run cli -- deploy restart
```

`deploy restart` drains the container and starts the next request on the new environment: no image build, no release. Runs in flight hand off to the next container the way a deploy's do. It is done once `/healthz` reports a later `startedAt`, about 30 seconds.

Rotating `SWITCHBOARD_INGRESS_TOKENS` works the same way, the deployer's own entry included: `deploy restart` with the **new** token works right after the put, because the Worker authenticates the token from its own, already-updated environment and tells the bot only the subject it authenticated. Keep the subjects unchanged when rotating; the `grants` entries key on them, not on the token values.

## 4. Update CI where it holds a copy

`RESIDENT_READ_TOKEN` and `SANDBOX_TOKEN` are also repository secrets the release deploy runs with. Set the new value there too.

## What you did

You replaced a credential everywhere it is held and restarted the one process that had the old one in memory. Why a put is not enough — the container keeps the environment it started with, exactly as it keeps its config — is the same fact that makes `deploy config` a two-step change ([Operate production](operate-production.md)).
