#!/usr/bin/env bash
# agent-env-bootstrap — materialize a DOWNSTREAM service's UAT env vars into the
# agent's execution environment from a secrets manager, via a READ-ONLY,
# UAT-vault-scoped service account. Thin entry point: the real logic lives in
# ../src/agentEnv/bootstrap.ts (unit-tested); this just runs the CLI via tsx.
#
# Usage (dry-run is the default — prints the plan, touches nothing):
#   deploy/agent-env-bootstrap.sh --env uat --service <name>
#   deploy/agent-env-bootstrap.sh --env uat --service <name> --apply
#
# Apply reads OP_SERVICE_ACCOUNT_TOKEN (a READ-ONLY, UAT-scoped secrets-manager
# service-account token) from the environment and writes a chmod-600 env file
# (default .agent-env/<service>.<env>.env) the toolchain sources:
#   set -a; . .agent-env/<service>.uat.env; set +a
# Equivalent: `npx tsx src/cli.ts env bootstrap --env uat --service <name>` (the registry command).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
exec npx tsx src/cli.ts env bootstrap "$@"
