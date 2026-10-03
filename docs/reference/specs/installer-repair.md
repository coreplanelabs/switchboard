# Install repair authority and receipt prerequisite

A trusted Bot operator may declare a repository's fixed dependency-install policy, but the declaration does not permit the Bot to install anything. A post-install receipt can be considered only when every field matches the original parsed preservation owner and the exact target head; this pure check does not prove that an install ran.

- **Code**: `src/execution/installRepairPolicy.ts`, `src/execution/factory.ts`, `src/config/validate.ts`
- **Tests**: `src/execution/installRepairPolicy.test.ts`, `src/config.test.ts`

| Criterion | Proof |
|---|---|
| The operator's optional `execution.installRepairRepos` map defaults off. Its keys are lower-case `owner/name`, and its only policy is exactly `{ policyVersion: "npm-ci-v1" }`; malformed names, maps, versions and any additional command, environment or path fields fail config load. | `[unit]` `src/config.test.ts::install repair policy config::accepts only an explicit fixed policy for a lower-case repository` |
| A v1 receipt is valid only for the original parsed preservation owner (including its admission head), an exact target head, the fixed npm-ci-v1 policy and the trusted SHA-256 key of root lockfile entries committed at that target head. The original admission head need not equal the target head; a filename alone is not a dependency key. | `[unit]` `src/execution/installRepairPolicy.test.ts::install repair receipt::accepts an exact target head distinct from the owner's admission head` |
| Missing or extra receipt or owner fields, mismatches in each binding or committed lockfile key, unsupported versions, malformed heads, and command, env or path injection all fail closed. | `[unit]` `src/execution/installRepairPolicy.test.ts::install repair receipt::rejects malformed or mismatched receipt bindings and injectable fields` |

Effectful recovery remains held until later source work pins the operator policy to the original tracked run and adds a Worker no-wake exclusive route. Neither this declaration nor the pure receipt check bypasses readiness, authorizes an install, or provides a Worker execution witness.
