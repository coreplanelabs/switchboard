# Known limits

What is deliberately off, unproven, or mid-transition in the current code, so a reader does not mistake a configured absence for a bug. Each item names the spec or issue that owns it; the specs' `[gap]` rows are the complete list of criteria not yet proven.

- The Cloudflare execution path is live: the resident Worker (`deploy/cloudflare-resident/`) runs at the hostname the deployment profile gives it, with public and private repos onboarded; its attach/exec/read/write plane and the onboard/offboard/rebuild lifecycle are proven — receipts on the `features/resident-repos.md` receipts issue.
- `GITHUB_APP_*` secrets are set on the resident Worker (a second copy of the bot's App credential — rotate both). Onboard's installation-membership check runs for real: private repos clone via minted installation tokens, and a repo outside the installation is refused with `not-in-installation: …` and nothing created. Still `[gap]` rows in `features/resident-repos.md`: the cross-repo token-scope proof and a push from a resident thread.
- The E2B executor path is typechecked but not exercised against a live sandbox.
- The Slack app has DM support wired but the recommended rollout keeps `im:*` scopes off initially.
- No token/cost accounting per request yet — the self-improvement proposer uses `long_run` outliers (≥2× the median run time) as the cost-spike proxy until there is.
- The friction ledger (`features/self-improvement.md`) is run history: `friction report` and `friction propose` cluster over the runs `runHistory` retains (`features/run-history.md`), so `runHistory.retentionDays`/`maxRuns` bound what they see; without `runHistory` there are no recent runs to analyze and the commands say so.
- Run history (`features/run-history.md`) is OFF without a `runHistory` config block — runs are then live-only and evicted 60 s after finish. Known follow-ups are the `[gap]` rows there (summary-only friction read; `RunHistoryDO.list` full scan).
- Feature-spec `[gap]` items (see `features/*.md`) are the known-unproven criteria backlog; each links its `spec-gap` issue on the Golden Product project when one exists (the lone exception is a hold-by-code-review row with no work item).
