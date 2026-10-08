---
title: Isolated staging before production delivery
type: feat
date: 2026-10-08
status: proposed
---

# Isolated staging before production delivery

## Outcome

An operator deploys an exact commit to a separate Cloudflare account from the CLI or a `deploy:staging` PR label. Review remains available on production while staging runs real Slack, GitHub, MCP, Ship, resident and sandbox scenarios.

## Sequence

1. Add a staging-only deployment workflow and CLI wrapper. Use the existing Worker templates, deployment runner, configuration publication and live gates. Serialize the shared staging stack. Refuse forks, unauthorized label actors, missing staging credentials, and a profile outside the configured staging account. Pin each request to its captured commit. A new push requires a new label request.
2. Reuse an existing paid account separate from production and bootstrap all four runtime Workers. Keep the production topology, SDKs, instance sizes, provider/model configuration and auth checks. Give staging a separate registrable domain, Durable Object namespaces, Workflows, cache and artifact buckets, metrics dataset, Access application, runtime bearers, Slack app and GitHub App. Store secrets using the installation's existing 1Password naming convention in separate staging items. Keep the runtime GitHub App restricted to disposable fixture repositories. Scope the deployment credential to the chosen account and staging DNS zone; retain the account's unrelated apps and shared quotas.
3. Copy the production runtime configuration into the private configuration repository, then replace every installation endpoint and resource name. Retain policy behavior but restrict actors and repositories to the testing workspace. Do not copy production state, schedules, MCP credentials or active work. Check the resolved configuration before any upload. Bootstrap Memory first. The current cold Bot config-publication gate can refuse an empty installation: prove native absence and use a reviewed bootstrap procedure; do not bypass it with `--force`.
4. Connect a separate Socket Mode bot in the testing Slack workspace. Use a separate GitHub webhook/App installation for fixture repositories. Run the procedures below and keep receipts outside the public repository, bound to the commit each selected Worker serves.
5. Add automated staged scenarios after the manual paths pass. Keep current capability smoke until the staged suite proves its coverage. Add staging acceptance as a release gate only after receipts are repeatable; a successful Worker upload is insufficient.

## Acceptance scenarios

| Scenario | Required observation |
|---|---|
| Slack question and reply | Original actor, correct reply/thread, persisted run and cost |
| GitHub review | Fixture PR at an exact head receives findings/verdict from the staging App |
| Ship | Fixture task reaches draft PR; findings are fixed and review binds the new head |
| Private question → Fix it | Private audience stays private; draft PR and owner remain bound |
| MCP and CLI | Same actor/grants and persisted facts as Slack |
| Resident and cold sandbox | Clone/install/test work through both execution paths; cache/artifacts remain in staging |
| Restart during a run | Run restores or hands off with one owner and no duplicate publication |
| Deploy while busy | Admission, preservation, readiness and recovery follow existing gates |
| Isolation | Production build/config/state is unchanged; staging cannot access production repositories or Slack |

## Small blast-radius changes

Use `affected` for routine production Worker selection once any current scoped rollout hold is cleared. The installation currently overrides this with `all`; retain an operator escape hatch for deliberate whole-fleet deployments. Keep production deployments manual/release-bound. Ship and Review share the bot, provider, dispatcher, state and executor paths. Splitting their release artifacts is not a low-risk refactor. First test Ship on staging while production Review stays on its current release; consider separate installations or agent routing only with a dedicated design and continuity proof.

## Completion gates

Local checks prove refusal, selection and workflow wiring. CI and review prove the proposed source. Account creation, secret provisioning, bootstrap, deployment and scenario receipts are separate gates. Do not call the environment parity-ready until all installation resources and required manual paths are proven.
