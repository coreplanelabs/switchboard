# Deploy and validate staging

Staging is a separate Cloudflare installation. It uses the same four Worker templates, SDK versions, container sizes, configuration schema and deployment gates as production. It has its own Slack bot, GitHub App, runtime credentials and state.

## Provision once

1. Create the staging Cloudflare account. Enable the paid Workers/Containers and R2 capabilities the production topology needs. Add an unused DNS zone in this account; a zone in another account cannot serve its Worker custom domains. A [separate subdomain zone requires Enterprise](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/).
2. Copy the deployment profile and runtime configuration into separate paths in the private configuration repository. Set `images: build` to deploy candidate commits. Name all four Worker scripts with `staging`. Set distinct artifact bucket and metrics dataset names containing `staging`. Keep production settings for models, harnesses, container sizes and feature flags; change installation endpoints and limit grants to test actors/repositories.
3. Point `runHistory.worker`, `runtimeOverrides.worker`, `memory.worker`, and every other state-Worker client at staging Memory. Point `execution.url` at staging Sandbox and `execution.resident.baseUrl` at staging Resident. Match the runtime artifact bucket and metrics dataset to the profile.
4. Create separate API Credential items named `Switchboard: <SECRET_NAME> (Staging)` in the existing vault, with values in the concealed `credential` field. Materialize the required fields into a private staging-only directory and name it as `secretsSource`; never use the production default directory. Mint distinct runtime bearers, staging-only provider keys and a staging-account-only Cloudflare deploy token. Deploy secrets with the existing `deploy secrets <worker>` command against the explicit staging profile.
5. Install a separate Socket Mode Slack app in the testing workspace. Install a separate GitHub App on disposable fixture repositories only. Route its webhook to staging. Configure a separate Cloudflare Access application and restrict its users. Do not copy production MCP credentials, schedules or data.
6. Bootstrap Memory first. The Bot config-publication gate requires readable canonical state and native application evidence. If cold bootstrap refuses, preserve the refusal and complete the reviewed bootstrap procedure; `--force` is not a staging bootstrap method.

## CLI

Run from a clean checkout at the exact candidate commit. Load staging credentials from 1Password without printing them. Set:

```bash
export SWITCHBOARD_DEPLOY_PROFILE=<staging-profile-path-or-github-reference>
export SWITCHBOARD_STAGING_ACCOUNT=<staging-account-id>
export SWITCHBOARD_PRODUCTION_ACCOUNT=<production-account-id>
npm run staging:deploy -- --check
npm run staging:deploy
# Select a component after the full stack is bootstrapped:
npm run staging:deploy -- --only bot
```

`--check` reads and validates inputs without upload. The runner requires the explicit staging account, full topology, build-mode images, matching state/execution endpoints and separate storage names. It freezes the profile and config outside the checkout before invoking the existing `deploy plan` and `deploy all`. The existing runner checks credentials, clean tree, preservation and live readiness. `--force` is refused, and inherited shell or checkout-file force overrides are disabled. The bot preflight uses the selected profile’s native application name. Account and endpoint checks cannot prove Slack/GitHub credential scope: prove those separately during provisioning.

## GitHub

Trusted same-repository pull requests start staging automatically after their current head passes CI, CodeQL, the title check and package smoke. The controller waits without staging credentials. Forks cannot deploy. Origin branches are writable only by repository writers and installed write Apps, so automatic runs also support App-created PRs. Label and manual requests require the initiating actor to have repository write access. The head is checked again after waiting for the shared staging stack.

The automatic job deploys all four runtime Workers, then runs bounded answer, workspace-read and exact-head Review scenarios on the disposable test repository. The shared staging lock stays held through those scenarios. GitHub queues pending deployments instead of replacing a different PR’s request. Each job retains deployment and acceptance receipts; a healthy response alone is not Review acceptance. A changed head or closed request stops before candidate credentials. Unrelated label events do not deploy or replace the real acceptance check.

Configure `STAGING_SMOKE_ORIGIN`, `STAGING_SMOKE_CONFIG` and the existing staging-only bearer as `STAGING_SMOKE_TOKEN` in the staging Environment. The config must declare the disposable repository, known workspace contents and open fixture PR/head. Set `review.expectedVerdict` to `request_changes` for a known-defect fixture or `approve` for a clean fixture; the posted result must match. Model, harness and budgets come from the deployed configuration; the runner's bounded smoke allowance remains. Never use a production bearer or a real repository as the fixture.


Create the `staging` GitHub Environment. Store the following staging secrets under their distinct names; there is no production-token fallback:

- `STAGING_CLOUDFLARE_DEPLOY_TOKEN`
- `STAGING_MEMORY_TOKEN`
- `STAGING_RESIDENT_READ_TOKEN`
- `STAGING_RESIDENT_DRAIN_TOKEN`
- `STAGING_SANDBOX_TOKEN`
- `STAGING_CONFIG_REPO_APP_CLIENT_ID`
- `STAGING_CONFIG_REPO_APP_PRIVATE_KEY`

Set `SWITCHBOARD_STAGING_PROFILE`, `SWITCHBOARD_STAGING_ACCOUNT`, and `SWITCHBOARD_PRODUCTION_ACCOUNT` as environment variables. The profile/config must use `github://` or local paths for this workflow. Use a dedicated staging config-reader App with only `contents:read` on the private configuration repository; never supply the production App private key to a candidate runner. `CONFIG_REPO_OWNER` and `CONFIG_REPO_NAME` name that repository. Runtime/provider/Slack secrets already live on the staging Workers; this workflow does not copy production secrets to them.

A maintainer can also apply `deploy:staging` to a same-repository PR. The workflow captures that head and checks it again after waiting for the shared staging stack. Every new push starts a fresh validation request. Removing a manually applied label withdraws that label request. Forks and actors without repository write access are refused. The candidate runs with staging deployment credentials, so label only trusted candidate code. Keep the staging Cloudflare token restricted to its account and the runtime GitHub App restricted to fixture repositories.

Manual dispatch from `main` also accepts an exact source commit:

```bash
gh workflow run deploy-staging.yml --ref main -f commit=<40-character-commit> -f targets=all -f review_e2e=true
```

To test a workflow change before merge, dispatch its branch with `pr=<number>` and `commit=<current-PR-head>`. The workflow refuses a different branch or commit. Deployment logs and E2E receipts are retained as artifacts. Upload and readiness are separate from end-to-end acceptance.

## Prove the product paths

Use the [release and deploy contract](../reference/specs/release-and-deploy.md) to separate readiness from acceptance. Retain receipts outside this repository with the run ID, actor, exact PR/head, selected Worker commits, output/artifact and outcome. Start with Slack question, review and Ship; then private Fix it, both executors, restart and busy deploy. A successful health response does not establish these outcomes.

Keep capability smoke until these staged paths are repeatable. Ship can be tested here while production Review remains pinned to its current release. They still share one bot artifact; independent agent releases need a separate architecture change.

## First installation

`npm run staging:deploy -- --initialize` creates an empty staging installation from a clean checkout. Use the same profile and account pins as `--check`, with a local staging secret directory. It needs the manifest's required secrets, separate GitHub credentials, ingress and executor bearers, MCP credential encryption and both bucket-scoped R2 pairs. The operator's `MEMORY_TOKEN` and `SANDBOX_TOKEN` must match that directory. Docker must be available. The profile must name a restart deployer with one matching ingress bearer.

Creation checks complete native Worker, Container, namespace and Workflow inventories. Existing selected resources refuse. Provisional Memory omits Bot service/Workflow bindings until the Bot exists; it is not parity-ready. The command creates the executors, publishes the owned config slot only against canonical version zero with an empty legacy slot, then creates the Bot, provisions its secrets and uses the existing authenticated restart route without force before proving its singleton and exact config. It restores full Memory bindings last. Normal update preflights are unchanged.

Use one operator for first installation. A lost answer or failed phase leaves a partial installation and stops. Inspect the captured receipts and current native resources before further action; `--initialize` does not adopt, delete or reset a partial installation. Do not use force to finish it. Full product acceptance still requires the scenarios above.

### Continue a recorded Memory checkpoint

Creation writes a mode-600 `INITIALIZE_MEMORY_RECEIPT.json` under the staging secret directory before checking the new Memory domain. `--receipt <path>` chooses a different private path. DNS negative caching can outlive the first readiness check; the receipt preserves the accepted upload and provisioned version without deleting the Worker or its data.

`npm run staging:deploy -- --resume-memory <receipt>` continues only a provisional Memory checkpoint. It verifies the account/script/hostname, original upload, exact current 100% deployment ID, code/binding/namespace hash and the same active account-token writer. The native custom-domain ID must still belong to that script in the selected zone and its production environment. The source build must match the receipt; both config slots must still be empty and Bot/Resident/Sandbox must be absent. It reuses Memory without replaying creation or provisioning, then follows normal first-install acceptance. Before config publication and final Memory binding completion it verifies the checkpoint again. Other partial phases and unreadable evidence refuse.

A prior operator may transfer an older captured upload/secret-provisioning receipt only after matching its positive upload version and native same-writer successor; observing a remote target alone does not authorize adoption. Wait for the recorded domain to resolve and verify its exact build over valid HTTPS. Never use an insecure TLS override or force to finish it.
