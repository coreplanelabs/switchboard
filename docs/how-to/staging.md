# Deploy and validate staging

Staging is a separate Cloudflare installation. It uses the same four Worker templates, SDK versions, container sizes, configuration schema and deployment gates as production. It has its own Slack bot, GitHub App, runtime credentials and state.

## Provision once

1. Create the staging Cloudflare account. Enable the paid Workers/Containers and R2 capabilities the production topology needs. Add an unused DNS zone in this account; a zone in another account cannot serve its Worker custom domains. A [separate subdomain zone requires Enterprise](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/).
2. Copy the deployment profile and runtime configuration into separate paths in the private configuration repository. Set `images: build` to deploy candidate commits. Name all four Worker scripts with `staging`. Set distinct artifact bucket and metrics dataset names containing `staging`. Keep production settings for models, harnesses, container sizes and feature flags; change installation endpoints and limit grants to test actors/repositories.
3. Point `runHistory.worker`, `runtimeOverrides.worker`, `memory.worker`, and every other state-Worker client at staging Memory. Point `execution.url` at staging Sandbox and `execution.resident.baseUrl` at staging Resident. Match the runtime artifact bucket and metrics dataset to the profile.
4. Create separate API Credential items named `Switchboard: <SECRET_NAME> (Staging)` in the existing vault, with values in the concealed `credential` field. Materialize the required fields into a private staging-only directory and name it as `secretsSource`; never use the production default directory. Mint distinct runtime bearers, staging-only provider keys and a staging-account-only Cloudflare deploy token. Deploy secrets with the existing `deploy secrets <worker>` command against the explicit staging profile.
5. Install a separate Socket Mode Slack app in the testing workspace. Install a separate GitHub App on disposable fixture repositories only. Route its webhook to staging. Configure a separate Cloudflare Access application and restrict its users. Do not copy production MCP credentials, schedules or data.
6. Bootstrap Memory first. The Bot config-publication gate requires readable canonical state and native application evidence. If cold bootstrap refuses, preserve the refusal and complete the reviewed creation procedure. Use [first installation](#first-installation) for an empty installation; the selected recovery sequence below covers maintenance support on an existing Resident.

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

## Selected recovery under maintenance

Resident stores unfinished requests to block unsafe deployment. A separately qualified staging operator can accept a finite fixture risk while preserving the original request record and its unknown result. This uses the [selected maintenance contract](../reference/specs/release-and-deploy.md#selected-staging-maintenance) and [staging risk decision](../decisions/0086-deploy-fence-separates-execution-from-workspace-retention.md). A normal deployment does not infer that the request ended.

Use `--retain-maintenance` only with a matching `residentMaintenance` policy in the private staging profile and a selection that includes Resident. The operator must first install the qualified contract producer, verify the exact durable hold and accept one quoted risk window. This is separate from first-install creation. The selected source, controller, profile, configuration and deadline must match that window.

```bash
npm run staging:deploy -- --check --retain-maintenance
npm run staging:deploy -- --retain-maintenance
```

For the same path in GitHub, manually dispatch the exact candidate branch and current PR head:

```bash
gh workflow run deploy-staging.yml --ref <candidate-branch> -f pr=<pr-number> -f commit=<40-character-current-head> -f retain_maintenance=true -f review_e2e=true
```

The branch must contain the retained-mode workflow. Existing writer, same-repository, current-head and validation checks still apply. `retain_maintenance` defaults to false and automatic requests do not select it. The workflow passes the explicit option to both acceptance plans and the deployment wrapper. It keeps the shared staging lock while the wrapper deploys with force zero, proves image readiness, seals the selected upload window and waits for an explicit Admin release. The operator uses `POST /staging-release-maintenance` with the unchanged full request quote, selected deployment data and a fresh release decision. Release refuses unknown or busy member views and other unfinished requests. The wrapper only reads that release receipt; it cannot release or renew maintenance itself.

E2E runs after the exact release is verified. Failed state reads, HTTP refusals, changed inputs or deadline expiry stop the selected deployment. Do not retry it through force or remove its policy. The separately qualified first producer upload remains outside this workflow. Do not consume the selected window in a manual deployment before asking CI to use it. After release the original request remains stored; this decision does not authorize a later deployment.

### Share the same inputs with the operator and CI

The operator host and GitHub runner have separate filesystems. A local frozen profile or configuration path cannot supply the runner's inputs. Use one immutable profile reference in the private configuration repository. Its nested `configSource` must also name an immutable source that the existing configuration reader can read.

The workflow reads the existing staging Environment variable `SWITCHBOARD_STAGING_PROFILE` and passes it as `SWITCHBOARD_DEPLOY_PROFILE`. Its existing configuration App uses `CONFIG_REPO_OWNER`, `CONFIG_REPO_NAME` and Contents read permission. It supplies `CONFIG_REPO_TOKEN` to the loaders. `retain_maintenance=true` selects the mode; it does not supply a profile or change credentials.

The operator can load the same immutable profile URI or freeze an exact local copy. CI reads the private references and creates its own protected temporary copies. Preserve the same parsed profile, selected `residentMaintenance` policy and configuration text. The profile digest uses `maintenanceProfileMaterial` in `src/deploy/profile.ts`: it excludes `residentMaintenance` and `configSource`, because the policy and configuration text have separate checks. A changed temporary configuration path is permitted. Other parsed profile fields, including the `secretsSource` reference, must match. `deploy all` uses environment credentials and does not run `deploy secrets` or require that secret directory on the CI runner.

Select these policy inputs before the qualified bootstrap:

| Input | Required value |
| --- | --- |
| `schema` | `1` |
| `stagingAccount`, `productionAccount`, `residentScript`, `residentOrigin` | Actual separate accounts and the original staging Worker/origin, matching the profile and independently configured account pair. |
| `fixtureSha256`, `resources`, `decisionSha256` | Digests of retained fixture/risk evidence and its exact allowed repository resources. A digest identifies evidence; it does not certify that evidence. |
| `holdId`, `generation` | One UUID and positive generation for the original Registry. |
| Deployment `id`, `controllerId` | One deployment UUID and operator-selected controller label. The code does not derive this label from a GitHub run ID; retain the actual writer and run receipts separately. |
| Deployment `sourceCommit` | One exact qualified candidate for both the bootstrap and selected CI upload. |
| Deployment `profileSha256`, `configSha256` | Canonical parsed profile-material digest and digest of the exact validated configuration text. Do not hash raw profile JSON as the material digest. |
| Deployment `deadline` | Absolute epoch milliseconds. Installation permits at most 90 minutes; each fence requires at least 20 minutes left. The deadline continues during publication, bootstrap and CI. |

If the old configuration reference refuses, retain its refusal. A local protected copy can prove bytes, but cannot prove the CI reader has current access. An authorized configuration writer can publish those same validated bytes as commit `R` on one new private branch. Keep the normal configuration path. Publish the selected normal profile as commit `P`, with parent `R` and `configSource` naming `@R`. Retain the branch at `P` through completion so both commits remain reachable. Preserve `main`, existing owner branches, credential scope and cloud settings.

For API publication, GitHub documents [blob creation](https://docs.github.com/en/rest/git/blobs#create-a-blob), [tree creation](https://docs.github.com/en/rest/git/trees#create-a-tree), [commit creation](https://docs.github.com/en/rest/git/commits#create-a-commit) and [reference creation/update](https://docs.github.com/en/rest/git/refs). Start each tree from its known `base_tree` and change only the selected configuration or profile path. Create the new branch at `R`, then advance only that owned branch to `P` with `force:false`. This is a fast-forward guard, not an atomic expected-old-SHA check. Record one writer, accepted object/ref receipts and exact readbacks. A changed or unknown ref, refused write or uncertain reply stops; do not repeat the mutation blindly.

Pin the existing `SWITCHBOARD_STAGING_PROFILE` variable to the accepted immutable profile URI before the selected job reads it. Keep it stable through deployment, release wait and E2E. The publication writer's successful readback does not prove access for the separate CI App. Inside the admitted job, the original CI reader must load the exact profile and nested configuration through the normal raw Contents route and validate them before upload. A refusal stops while maintenance stays held. The existing workflow provides this check before upload; it does not require a separate check-only CI dispatch.

### Install the maintenance support, then use one CI window

This sequence requires separately qualified authority for the finite staging fixture risk and loss, the original controller and all remaining native/private guards. It is an upgrade of an existing installation. It does not claim that an unfinished request or its remote effects ended.

1. Settle competing controllers and complete the approved original fixture reset before installing maintenance. Retain its actual completion evidence; an HTTP 202 acknowledgement is not completion. The held Worker blocks ordinary reset, rebuild, registration and configuration work.
2. From a clean checkout at the selected full source commit and the shared frozen inputs, run the separately qualified first upload:

   ```bash
   npm run cli -- deploy all --only resident --force --retain-maintenance --allow-branch
   ```

   This direct runner retains the selected policy and requires an acknowledged drain. A successful JSON answer from the known old `/deploy-fence` can permit this qualified force upload. HTTP 409/404, invalid JSON, timeout or transport failure still refuses. Do not remove the policy or deployment data to bypass that refusal. The ordinary staging wrapper continues to reject force.

3. Verify the new exact Worker build, complete current member image reports and `GET /staging-maintenance` with the existing read bearer. Match its hold ID, generation, selected deployment data and fixture/decision digests to the frozen policy; no risk window exists yet. Qualify the account, script and resource scope against the actual installation. Success is image readiness under maintenance, not live acceptance. The new Registry installs this durable hold before new RPC delivery; drain expiry or a successful image report cannot release it.
4. Use the existing Admin bearer to read the original request quote through the [staging risk API contract](../reference/specs/resident-repos.md#explicit-staging-risk). Retain its `startedAt` and full stored-record `recordSha256`. A compact inventory or diagnostic projection is not that quote. A changed, absent or unreadable original stops the sequence.
5. Create a fresh `POST /drain` with the existing drain bearer, `minutes=90`, a `reason`, the operator label in `by` and exact selected deployment data. The server clamps its end to the fixed policy deadline. Then submit the contract's Admin risk decision once, with the exact request quote, fixture/risk digests and selected deployment data. The reference contract gives the exact HTTP field names. This Admin action sets its decision fence itself; do not separately call `/deploy-fence` first. Verify the immutable decision and `authorized` window. With only the original row, counts are `stored=1`, `excluded=1`, `blocking=0`; other rows remain blocking. Request ending remains unobserved.
6. Dispatch the selected current candidate branch through the existing workflow with `retain_maintenance=true` and E2E enabled. This must be the first normal deployment that claims the window. Do not consume it with a manual normal deployment first. CI uses the same full source commit, force zero and its own frozen input files. Its normal drain claims the window atomically; ordinary native, owner, process, private and image guards still apply. Exact readiness precedes the runner's `/staging-seal-window` call and `completed` window. Maintenance remains held while that same job waits for release.
7. Under fresh qualified reopening authority, submit `POST /staging-release-maintenance` once with the Admin bearer. Its body requires the unchanged `expectedStartedAt`/`expectedRecordSha256`, selected deployment data and a fresh `releaseDecisionSha256` different from the original risk decision. The server independently requires idle member owner/lifecycle/process views, the original audit/row and no other global requests. Verify the exact `released` state, selected identity, new release digest and timestamp. The waiting CI can then continue to its own E2E.

Retained mode never automatically calls `/undrain`, including failure, cancellation or an unknown upload. A lost risk or release commit reply permits the handler's one exact receipt read, not another operator mutation. An expired upload window leaves the durable hold in place. A separately qualified release after expiry cannot renew upload eligibility or turn an expired CI wait into success. The original request and audit remain stored after release; a later ordinary deployment still has that request debt.

## GitHub

For the role of each source, routing, staging and production check, see [the testing model](ship-a-release.md#what-the-checks-prove).

Only same-repository release pull requests start staging automatically after their current head passes CI, CodeQL, the title check and package smoke. The controller waits without staging credentials. Forks cannot deploy. Origin branches are writable only by repository writers and installed write Apps, so automatic runs also support App-created PRs. Label and manual requests require the initiating actor to have repository write access. The head is checked again after waiting for the shared staging stack.

Ordinary pull requests run normal validation and report staging E2E as not required when staging has not been requested. A retained `deploy:staging` label or manual branch request at the same commit keeps the test required when the PR is marked ready or reopened. Apply `deploy:staging`, use manual dispatch, or use the CLI when you want to test one on staging.

The automatic release job deploys all four runtime Workers, then runs bounded answer, workspace-read and exact-head Review scenarios on the disposable test repository. The shared staging lock stays held through those scenarios. GitHub queues pending deployments instead of replacing a different PR’s request. Each job retains deployment and acceptance receipts; a healthy response alone is not Review acceptance. A changed head or closed request stops before candidate credentials. Unrelated label events do not deploy or replace the real acceptance check.

Configure `STAGING_SMOKE_ORIGIN`, `STAGING_SMOKE_CONFIG` and the existing staging-only bearer as `STAGING_SMOKE_TOKEN` in the staging Environment. The config must declare the disposable repository, known workspace contents and open fixture PR/head. Set `review.expectedVerdict` to `request_changes` for a known-defect fixture or `approve` for a clean fixture; the posted result must match. Model, harness and budgets come from the deployed configuration; the runner's bounded smoke allowance remains. Never use a production bearer or a real repository as the fixture.

When Cloudflare Access protects the canonical MCP endpoint, configure a dedicated staging [Service Auth policy](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/#use-service-tokens). Store its pair in the staging Environment as `STAGING_SMOKE_ACCESS_CLIENT_ID` and `STAGING_SMOKE_ACCESS_CLIENT_SECRET`. The workflow passes them only to the smoke reader as `SMOKE_ACCESS_CLIENT_ID` and `SMOKE_ACCESS_CLIENT_SECRET`; the existing staging bearer still supplies Switchboard command authority. An app-scoped policy can cover other app destinations, so qualify the machine/browser boundary before activating that policy. Production credentials remain separate.

Normal staging CI runs `smoke:ingress --check --check-reader` before upload. This makes the existing bounded MCP read and verifies the exact configured requester/channel/repository without starting an agent. A refusal stops before the deployment step and records a closed diagnostic, including HTTP status and challenge presence when available. Redirects are refused without forwarding credentials. Plain `--check` remains configuration-only. Use the first-installation flow to establish an initial reader before the normal release checks.


The capability Review has a fifteen-minute time budget, including its final answer and publication steps. General retains a four-minute budget. Workspace Explore uses the existing fifteen-minute floor, leaving twelve minutes for tool work after the three-minute write-up allowance. The CI artifact's `staging-e2e.json` keeps each original run under `scenarios[].evidence.record`, with the complete retained event history, budget timestamps, completion and delivery facts, and posted verdict. `failedChecks` identifies an output refusal; `observationError` identifies a failed read without replacing the last observation. Original event counts and truncation show any history gap. Credentials and content from a mismatched actor or thread are excluded. The existing artifact upload runs even when acceptance fails.


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

For a model-control repair, add `-f model=openrouter/openai/gpt-5.3-codex -f require_vouched_controls=true`. The existing scenarios use that exact model and require its recorded effort, cap, window and cache controls without fallback warnings. The receipt retains these controls. The CLI equivalent adds `--model <provider/model> --require-vouched-controls` to `smoke:ingress`.

To test a workflow change before merge, dispatch its branch with `pr=<number>` and `commit=<current-PR-head>`. The workflow refuses a different branch or commit. Deployment logs and E2E receipts are retained as artifacts. Upload and readiness are separate from end-to-end acceptance.

## Prove the product paths

Use the [release and deploy contract](../reference/specs/release-and-deploy.md) to separate readiness from acceptance. Retain receipts outside this repository with the run ID, actor, exact PR/head, selected Worker commits, output/artifact and outcome. Start with Slack question, review and Ship; then private Fix it, both executors, restart and busy deploy. A successful health response does not establish these outcomes.

An accepted native HTTP request can return before its run is readable. Acceptance first waits for that exact owner in an authorized metadata list for the original thread. It keeps the original deadline and checks current read scope on each page. An incomplete page without the owner, unavailable storage or any read error stops acceptance. It never resends the request or retries a point read that can mask a missing run or an access denial. Native MCP requests keep their existing read path; the HTTP scope preview does not prove MCP-source visibility.

Native asynchronous HTTP and MCP requests return a run handle. Their acceptance artifact must include authenticated readback of that original run's sealed, persisted and complete output, with the expected scenario result. Its `outputReadback` records the original receipt and run, seal time, event count and output byte count. This does not claim a channel reply was delivered: the saved `replyOk` remains unchanged. Workspace execution, posted Review, model, budget, cost and Slack connection checks still apply.

Keep capability smoke until these staged paths are repeatable. Ship can be tested here while production Review remains pinned to its current release. They still share one bot artifact; independent agent releases need a separate architecture change.

## Slack acceptance

Staging checks Slack connection health before and after each agent scenario. When `STAGING_SLACK_SMOKE_CONFIG` is configured, it also sends one `@bot status show` mention as the normal testing member in the selected public channel and checks the threaded reply. This proves Slack delivery without another model call. Messages stay visible; receipts retain native channel and message/reply timestamps. An unknown post is never resent.

Set the staging environment variable `STAGING_SLACK_SMOKE_CONFIG` to:

```json
{"disposable":true,"workspaceId":"TTEST001","userId":"UTEST001","botUserId":"UBOT0001","channelId":"CCI00001"}
```

The operator chooses `channelId`, such as the testing workspace’s `#ci`. Add the bot and join with the testing member. The runner refuses a wrong workspace/user, bot credentials, private or shared channel (including pending external sharing), or missing membership before posting. The sender app uses user scopes `chat:write`, `channels:read` and `channels:history`; these allow public-channel information/history in the testing workspace, while the runner uses only its configured channel. Keep normal member grants and remove temporary app collaborator access after setup.

Save the member’s token in the staging secret `STAGING_SLACK_TEST_USER_TOKEN`, then enable the configuration variable. The token stays in CI/operator secrets, outside the bot and executors. CLI operators use `SMOKE_SLACK_CONFIG` and `SMOKE_SLACK_USER_TOKEN` with the existing ingress smoke inputs and `SMOKE_EXPECTED_COMMIT`. `smoke:ingress --check` validates setup without messages; CI runs it before uploads. Unset configuration disables only the user-message check; configured but incomplete setup fails.

A pass requires the configured bot’s reply to match the deployed commit, process start and loaded base configuration, with Slack connected before and after. Production operators can require connection health with `SMOKE_REQUIRE_SLACK_CONNECTION=true`; staging user credentials are not used in production.

## First installation

`npm run staging:deploy -- --initialize` creates an empty staging installation from a clean checkout. Use the same profile and account pins as `--check`, with a local staging secret directory. It needs the manifest's required secrets, separate GitHub credentials, ingress and executor bearers, MCP credential encryption and both bucket-scoped R2 pairs. The operator's `MEMORY_TOKEN` and `SANDBOX_TOKEN` must match that directory. Docker must be available. The profile must name a restart deployer with one matching ingress bearer.

Creation checks complete native Worker, Container, namespace and Workflow inventories. Existing selected resources refuse. Provisional Memory omits Bot service/Workflow bindings until the Bot exists; it is not parity-ready. The command creates the executors, publishes the owned config slot only against canonical version zero with an empty legacy slot, then creates the Bot, provisions its secrets and uses the existing authenticated restart route without force before proving its singleton and exact config. It restores full Memory bindings last. Normal update preflights are unchanged.

Use one operator for first installation. A lost answer or failed phase leaves a partial installation and stops. Inspect the captured receipts and current native resources before further action; `--initialize` does not adopt, delete or reset a partial installation. Do not use force to finish it. Full product acceptance still requires the scenarios above.

### Discard and recreate staging

Use `.github/workflows/recreate-staging.yml` only for an explicitly authorized destructive staging reset. It uses the existing account, names and shared staging lock. Production and other Workers are excluded. A repository or container reset alone does not remove the global Registry maintenance state.

First publish and select an ordinary staging profile with no `residentMaintenance`. Keep its account, hosts, config reference and existing identities. The staging Environment must also have `STAGING_RUNTIME_SECRETS_JSON`: a private JSON map containing only the original names in `STAGING_RESTORATION_KEYS` and their values from the existing staging secret source. Do not copy the whole directory or unrelated provider administration keys. This is provisioning input, not an artifact. The job checks the complete first-install requirements and matching Memory, Sandbox, Resident read and Resident drain bearers before deleting anything. A configured provider whose `apiKeyEnv` is outside this restoration list refuses the reset. Do not delete deployed Workers while that restoration path is unavailable.

1. Dispatch the recreation workflow from `main` with the exact current same-repository PR head, PR number and immutable profile reference. Leave `approved_plan` empty. The trusted main controller checks the candidate's source checks before candidate code runs. This performs input and dependency reads and saves a plan; it makes no deletion or deployment.
2. Verify the artifact's account, profile/config/source hashes, exact native IDs, all selected namespaces and deletion paths. Each Container application must map to a namespace owned by its expected Bot, Resident or Sandbox Worker. A missing or foreign owner, foreign dependencies or an incomplete read refuse the plan. Approve that exact plan hash only within the accepted staging loss scope.
3. Dispatch one original apply run with that hash. The job rechecks the PR head, source checks, complete provisioning and unchanged plan under the shared lock. It deletes selected native applications and Workflows, then deletes Memory before Bot and the remaining Workers without a dependency override. It proves absence before the existing first-install protocol recreates them.
4. Inspect the exact phase and native receipts after any failure. Unknown dependency fields refuse before deletion. Their receipt names the selected Worker and includes at most eight field names, types and immediate object keys; it excludes provider values. Use this evidence to check the provider contract. An uncertain mutation is not permission to repeat it. Existing first-install recovery rules still apply.
5. Run the required automatic PR deployment and Review validation on the ordinary installation. Recreation reports no acceptance, does not add retained mode and cannot replace those required checks.

Recreation discards staging state, including its old request records, without claiming their original effects ended. It does not delete shared R2 buckets or change SDK versions, accounts, Slack or GitHub identities. Any separately required data deletion needs its own scoped action.

The script removes its private temporary files and bundle environment value on exit. After the final provisioning result is known, the original repository maintainer removes the transient `STAGING_RUNTIME_SECRETS_JSON` from the staging Environment. The recreation job has no repository-secret write credential and cannot remove that encrypted Environment secret itself. Do not grant a broader token for cleanup.


### Continue a recorded Memory checkpoint

Creation writes a mode-600 `INITIALIZE_MEMORY_RECEIPT.json` under the staging secret directory before checking the new Memory domain. `--receipt <path>` chooses a different private path. DNS negative caching can outlive the first readiness check; the receipt preserves the accepted upload and provisioned version without deleting the Worker or its data.

`npm run staging:deploy -- --resume-memory <receipt>` continues only a provisional Memory checkpoint. It verifies the account/script/hostname, original upload, exact current 100% deployment ID, code/binding/namespace hash and the same active account-token writer. The native custom-domain ID must still belong to that script in the selected zone and its production environment. The source build must match the receipt; both config slots must still be empty and Bot/Resident/Sandbox must be absent. It reuses Memory without replaying creation or provisioning, then follows normal first-install acceptance. Before config publication and final Memory binding completion it verifies the checkpoint again. Other partial phases and unreadable evidence refuse.

A prior operator may transfer an older captured upload/secret-provisioning receipt only after matching its positive upload version and native same-writer successor; observing a remote target alone does not authorize adoption. Wait for the recorded domain to resolve and verify its exact build over valid HTTPS. Never use an insecure TLS override or force to finish it.


### Use the manual held bootstrap in CI

Use `deploy-staging-bootstrap.yml` only after the operator qualifies the old producer, fixture and remaining old capabilities. This is one Resident update under retained maintenance. It cannot supply full-stack or Review E2E acceptance. The normal workflow continues to use force zero.

Select an open same-repository PR at its exact current head. The workflow source and dispatched branch must point to that same commit. Select an immutable profile and nested configuration through the existing staging configuration reader. Match the Environment profile pin and the policy's source, hashes, hold, generation, operation ID, controller label and fixed deadline. The deadline includes queue and installation time, lasts no more than 90 minutes from the original run, and needs the existing 20-minute reserve before upload. Keep the original actor and sole controller.

After those external qualification steps, the operator can dispatch the selected operation:

```sh
gh workflow run deploy-staging-bootstrap.yml --ref "$BOOTSTRAP_BRANCH" \
  -f commit="$BOOTSTRAP_COMMIT" -f pr="$BOOTSTRAP_PR" \
  -f profile_ref="$BOOTSTRAP_PROFILE_REF" -f attempt_id="$BOOTSTRAP_ATTEMPT_ID" \
  -f previous_commit="$BOOTSTRAP_PREVIOUS_COMMIT" \
  -f previous_worker_version="$BOOTSTRAP_PREVIOUS_WORKER_VERSION"
```

The job uses the existing staging Environment and `deploy-staging` lock. It checks positive original GitHub run metadata and complete preserved workflow history. A rerun or another run for the same selected operation refuses. Missing or changed old source/version and unreadable preflight data refuse before upload. An existing maintenance record refuses a first bootstrap. A successor requires the exact released predecessor described below. The job does not reset the fixture.

The expected result is the distinct `staging / bootstrap held` job and its `staging-held-bootstrap-<run>-1` artifact. A successful artifact reports image readiness, the exact maintenance hold and a null risk window. The job reconciles the original members against the exact native application, version and image, including when that image is unchanged. Missing members or pending activation refuse. It grants no normal staging, release, production or FE acceptance. It records no original request or native ending.

If upload, readiness or receipt delivery is uncertain, retain the original run and result. Do not rerun it or reuse its operation ID. The operator must reconcile the original outcome before selecting any new operation. Read-only adoption of a proved original result is separate from another upload. After a verified held bootstrap, the operator makes the one finite risk decision. Only the later first normal retained CI run can claim its window, seal completion, wait for explicit release and run its own E2E.

### Select a successor after release

A successor is a new selected operation after a released operation has consumed its window. It does not restart the old CI run or extend its deadline. Keep the old maintenance, window, release, immutable audit, original request quote and private failure evidence. The original request and native outcome can remain unknown.

First finish the source review and CI gates for the exact containing candidate. Before any physical selection, positively reconcile prior uploaders and their deployment-credential boundary. An empty controller list, age or a stopped process does not prove that old control authority is gone. Any unknown remaining upload or fixture-control authority stops this operation. Independently verify the complete native, member, owner and private workspace state. A retained acknowledged workspace may keep positive display counters. Use the final fenced activity classification: executing and unknown work must be zero, while retained custody remains protected. That acknowledgement does not prove native ending. Do not remove files or clear registration merely to zero a counter. Accept that a failed post-upload policy comparison can leave staging unavailable; no automatic rollback or restoration time is promised.

The new immutable policy uses the same account, script, origin, resources and fixture. It selects a distinct hold ID, generation plus one, distinct operation ID, new source and fresh decision digest. Its fixed deadline belongs only to that original new CI run. Add `predecessor` with these exact old fields:

| Field | Retained value |
| --- | --- |
| `holdId`, `generation`, selected operation object | Full prior hold identity and all selected operation fields shown below. |
| `fixtureSha256`, `decisionSha256` | Prior fixture and accepted risk decision digests. |
| `releasedAt`, `releaseDecisionSha256` | Prior explicit release time and decision. |
| `policySha256` | Prior full parsed policy digest. Current readback supplies it. For the legacy producer, calculate it from the retained immutable parsed policy using SHA-256 of compact JSON with recursively sorted object keys; the unavailable field is not a service certificate. |
| `request` | Original `id`, `startedAt`, `recordSha256`. Keep the complete stored-record quote unchanged. |

Copy the complete original operation object with the exact property names in the [successor reference contract](../reference/specs/resident-repos.md#staging-successor-operations).

Use the same six-input manual bootstrap workflow. Its old source and Worker version must still match the selected predecessor. The legacy released producer reports one blocking request and a withdrawn swap fence. Only this selected installer can accept that exact projection under the qualification above. A generic force request cannot replace the policy. Startup compares the full stored predecessor policy, completed window, original audit/request and release receipt in one transaction before selecting the new hold.

Verify the new exact source, native target, all original members, held maintenance, `installation.state=installed`, matching policy digest and a null risk window. A reconciliation GET can finish the original uploaded policy's initialization on first Durable Object construction; it cannot choose another policy or repeat the physical upload. Same-policy restarts preserve installation time, deadline and released state. Unknown upload or receipt outcomes stop without resubmission.

After this installation is verified, the operator can accept a fresh risk decision for the same original request. It creates a window for this successor only. The first later normal retained CI run still uses force zero, seals its own window and waits for an explicit release before acceptance checks. `GET /staging-maintenance?holdId=<old-hold-id>` reads retained history without moving the current pointer. Its window `recordedState` reports the retained phase; the projected `state` remains the current eligibility result. A successor requires the prior recorded phase to be `completed`. These reads and a successful source merge grant no deployment or E2E acceptance.
