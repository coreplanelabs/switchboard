# Store run artifacts

Let runs move large files — a 1 GiB attachment out of a run, a 300 MB video dropped on a thread into a run's workspace — through one private R2 bucket instead of the inline caps (5 MiB per image, 10 MiB per document). The bot signs URLs and records keys; the container and the bot's Worker move the bytes.

**You need:**

- A Cloudflare account with R2 enabled, and `CLOUDFLARE_API_TOKEN` for it in your shell with **Workers R2 Storage: Edit** (the `deploy` commands already use this token; `deploy` creates the bucket with it).
- A second, bucket-scoped R2 token for the bot: in the dashboard, R2 → Manage API tokens → **Object Read & Write** on the one bucket. Save its two halves as `ARTIFACTS_R2_ACCESS_KEY_ID` and `ARTIFACTS_R2_SECRET_ACCESS_KEY` where the profile's `secretsSource` reads them (`~/.secrets/switchboard/<NAME>` by default).
- A bearer you mint yourself for the bot's copy route, saved as `ARTIFACTS_COPY_TOKEN` beside them (`openssl rand -hex 32`).
- `PUBLIC_BASE_URL` set on the bot: the run page's file links are built from it.

## Name the bucket in the deployment profile

```json
"artifacts": { "bucket": "switchboard-artifacts" }
```

With this in `deploy/profile.json`, the bot Worker's rendered `wrangler.jsonc` binds the bucket, and the bot's `npm run deploy` creates it before the upload — idempotently, so an existing bucket reports "already exists".

## Put the secrets, then turn the store on

```bash
npx @coreplane/switchboard deploy secrets bot --only ARTIFACTS_R2_ACCESS_KEY_ID,ARTIFACTS_R2_SECRET_ACCESS_KEY,ARTIFACTS_COPY_TOKEN
```

Secrets first, always: a configured store with a missing secret fails the bot's startup by name. Then add the section to the bot's `config.yaml`, push it and restart:

```yaml
artifacts:
  r2:
    accountId: <your Cloudflare account id>
    bucket: switchboard-artifacts # the profile's name, exactly
  retentionDays: 30 # optional; the default
```

```bash
npx @coreplane/switchboard deploy config
npx @coreplane/switchboard deploy restart
```

`/healthz` now carries `"artifacts": { "bucket": "switchboard-artifacts" }`. A bucket name that differs between the profile and the config refuses the bot at startup naming both.

## Apply retention

```bash
npx @coreplane/switchboard artifacts lifecycle --dry-run
npx @coreplane/switchboard artifacts lifecycle
```

The first prints the two rules — every object deleted `retentionDays` after it was written, an incomplete multipart upload aborted after one day — and touches nothing. The second applies them through Cloudflare's API with your token and reads them back; it refuses to claim success when the read-back differs. Run it again after changing `retentionDays`. The run page shows a file whose object has expired as `expired after N days`.

## Check the bucket is private

```bash
npx @coreplane/switchboard artifacts check
```

`… is private: the managed domain pub-….r2.dev is disabled and no custom domain is attached` is the answer you want. Anything else names the setting to turn off in the dashboard (R2 → the bucket → Settings → Public access). The check reads the bucket's domain settings; nothing unsigned can reach an R2 object either way, which is why the bot does not probe at runtime.

## Turn it off

Remove the `artifacts:` section, `deploy config`, `deploy restart`. Every path falls back to the inline caps; the bucket and its objects stay until the lifecycle rules expire them.

## Next

- [Rotate a secret](rotate-a-secret.md): the three `ARTIFACTS_*` secrets rotate like any other bot secret.
- [execution.md item 20](../reference/specs/execution.md): what moves where, and every proof.
