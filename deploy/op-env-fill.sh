#!/usr/bin/env bash
# op-env-fill — populate a deploy env's Worker secrets from 1Password via a
# READ-ONLY service account (GitHub #72). Thin entry point: the real logic lives
# in ../src/deploy/opEnvFill.ts (unit-tested); this just runs the CLI via tsx.
#
# Usage (dry-run is the default — prints the plan, touches nothing):
#   deploy/op-env-fill.sh --env uat --target both
#   deploy/op-env-fill.sh --env uat --target bot --apply
#
# Apply reads OP_SERVICE_ACCOUNT_TOKEN (a READ-ONLY, UAT-scoped 1Password
# service-account token) from the environment. Equivalent: `npm run op-env-fill`.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
exec npx tsx src/deploy/opEnvFillCli.ts "$@"
