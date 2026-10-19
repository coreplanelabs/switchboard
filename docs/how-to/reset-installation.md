# Reset application data

`npm run installation:reset` prepares a repeatable reset of one four-Worker installation. The preview makes no service mutation. Apply replaces its native applications, Workflows, Workers and Durable Object namespaces, then clears the two private buckets before first installation restores service.

Keep the exact account, profile, source commit and plan with the receipt. Apply creates `<memory-script>-reset-journal` if it is absent. This separate private R2 bucket stores encrypted settings and original action logs; every reset retains it. A bucket with another owner, public access, an automatic deletion policy or a runtime Worker binding refuses execution. A reset discards unknown old operation records; it does not establish that their original external effects completed.

## What stays

The command retains deployment settings, Worker secret values from the original secret source, runtime configuration, sealed MCP credentials, personal tokens, identity bindings, source-access policy and repository registrations. It authenticates retained ciphertext with the original credential key before deletion. It rejects a shared bucket, unsupported persistent binding, unknown settings schema, unclassified namespace or an extra settings object that it cannot preserve.

Routine organization refresh counters and empty idle state do not affect settings comparisons. Identity binding revisions, access-policy revisions and stream cutoffs remain preserved and checked. Domain checks use each Worker's zone override when present, or the installation's global zone.

Run history, conversation logs, transcripts, learned memory, old workspaces, native journals, saved work permissions, cached cost/delivery data, schedule history and the two buckets' objects are cleared. Tickets and pending action confirmations are not restored. Provider metrics, logs, billing and recovery retention are separate and are listed as exclusions. The bucket check proves emptiness before initialization; newly provisioned residents can create fresh backups afterward.

## Preview

First deploy the reset-capable Memory and Resident build through the ordinary release path. An older build refuses the settings preview. Use a clean checkout and the original installation secret directory. Set the explicit profile and its account credential. Plans and receipts must be outside the checkout.

Keep the original `INITIALIZE_MEMORY_RECEIPT.json`. Reset preflight checks `<plan-path>.memory.json` for preview or `<reset-receipt>.memory.json` for apply. It does not reuse the first-installation receipt. An existing reset-specific initialization receipt still refuses execution.

```sh
export SWITCHBOARD_DEPLOY_PROFILE=<exact-profile-reference>
npm run installation:reset -- --account <account-id> --plan <private-path>/reset-plan.json
```

The result is a mode-600 plan and its SHA-256. Inspect the selected native IDs, complete namespace object census, bucket keys and sizes, preservation hashes and exclusions. Missing restoration credentials or incomplete reads refuse before deletion. The creation config retains deployed variables, observability, limits, capacity and schedules. Unrepresentable advanced container settings, external bindings, extra domains, placement changes or legacy URL routes refuse before deletion. Provider health counts and newly issued domain certificates are deployment state, not hosting settings. The preview names this journal bucket but does not create it, acquire a settings lock or install maintenance.

## Apply under the deployment lock

Use `.github/workflows/installation-reset.yml`. The production Environment uses the same `deploy-production` concurrency group as ordinary deployments. It accepts one original workflow execution on main and requires a published release tag whose exact commit is an ancestor of main. Before merge, test a candidate only through the existing staging workflow with `reset_e2e=true`, `targets=all` and `review_e2e=true`; its `deploy-staging` lock covers both reset cycles and product acceptance. The operator supplies the exact account, immutable profile and released source, maintenance episode, and reviewed plan hash. Select `preview` first. Download its encrypted plan artifact and decrypt it with the original credential key before selecting `apply` with that plan hash. Apply regenerates the preview and refuses any difference in settings or deletion scope. It also requires the original successful staging workflow run whose two reset cycles and final three product scenarios passed at that exact released commit. The script does not start a maintenance notice or choose its channel.

Before apply, use the selected installation's canonical maintenance command to close all access and let active reviews finish. Capture the exact episode ID. A notice still sending refuses. Refresh the preview after activating maintenance, since its document is part of the preserved settings.

The Environment needs `RESET_RUNTIME_SECRETS_JSON`, populated from that installation's existing secret source. It is a private map of the declared Worker secret names and their original values. Do not copy another installation's values. The workflow materializes a private directory and masks every value before commands run. Missing names, a mismatch with deployed secret names or a wrong credential encryption key refuse before deletion. No production-token fallback is used for staging.

The execution step uses:

```sh
npm run installation:reset -- --account <account-id> --plan <private-path>/reset-plan.json \
  --apply <plan-sha256> --maintenance <episode-id> --receipt <private-path>/reset-execution.jsonl
```

The script prepares and verifies the private journal bucket, then locks settings, captures them again and refuses drift. It seals each original action, stores it in that bucket and verifies the same bytes before dispatch. It does not retry an uncertain mutation. It proves native absence before bucket deletion and initialization. It restores maintenance and access settings before the new Bot starts. It then compares preserved settings and hosting configuration, checks that old namespace IDs are gone and verifies empty run history. A verified result retains the exact maintenance episode; end that episode only after the required acceptance checks.

## Failure and repeat use

An existing execution receipt refuses another apply. A timeout, failed acknowledgment, changed setting, nonempty bucket or failed restoration leaves the original reset held. Inspect its journal and provider state before any further action. The encrypted `*.settings.sealed.json` file retains settings for that original operation; its associated identity binds the account, operation and plan. It requires the original `MCP_CREDENTIAL_KEY` and must be retained with the original secret source. Before native deletion, the controller stores this encrypted file in the private journal bucket and reads back the same bytes. Each later original action has its own encrypted record there. The final success or held record also contains the complete action log. Failure to verify a stored intent stops deletion. Both staging logs remain there after either reset. No plaintext settings transfer is uploaded as a CI artifact.

The workflow prints its run ID, original operation and journal prefix. Use the original profile, account credential and secret directory to list retained records even when the application is gone. Download the exact settings or action-log key, then decrypt it. The output contains private settings and must stay outside the repository:

```sh
npm run installation:reset -- --account <account-id> --list-receipts <workflow-run-id>
npm run installation:reset -- --account <account-id> --download <exact-key> --output <private-path>/receipt.sealed.json
```

```sh
npm run installation:reset -- --account <account-id> --inspect <encrypted-file> --output <private-path>/inspection.json
```

The settings receiver's read-only `status` action reports the retained operation and phase. The reset does not remove an old hold, replay a deletion, change identities or reopen maintenance to make progress. Existing first-install checkpoint rules still apply to a partial creation.

A later complete reset uses a fresh preview, operation ID and receipt. A previously verified settings transfer can be frozen for that new operation. The staging rehearsal must exercise two complete reset cycles and verify the original settings each time, then run the existing bounded product smoke against the final build. A local or source-only check does not establish that staging or production was reset.

The staging rehearsal runs a read-only native preflight before it writes fixtures or opens maintenance. If a fixture or preview fails before apply starts, it ends only its own unchanged maintenance episode and propagates the failure. Once apply is attempted, a failure keeps maintenance active for reconciliation. Another operator's hold is never released by this cleanup.
