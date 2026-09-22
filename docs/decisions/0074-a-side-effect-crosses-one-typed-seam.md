---
title: A side effect crosses one typed seam
status: proposed
date: 2026-09-21
pattern: Command–query separation at the runner boundary — a child asks for an effect with a typed command; the runner validates current facts, performs the effect, and returns a typed receipt or refusal
---

# A side effect crosses one typed seam

**The ask.** Decide whether every effect a run performs beyond ordinary edits in its checkout crosses one typed seam owned by the runner, never the child's shell. The first effects are a push, a rebase and its conflict resolution, a pull-request open or update, and a comment; the same boundary must later hold connector writes such as the Linear issue update proposed by pull request #1625. Written for an engineer who knows the harness, the ship runner and the pull-request sweep. Success criteria:

1. A child can ask only through typed tools — `push`, `rebase`, `open_pr`, `comment`, and later `connector.<name>.<operation>` — whose arguments name the intended resource, expected version and payload. The child's shell cannot publish, rewrite remote history or write through a connector.
2. The runner owns the operation from fresh facts to outcome: it resolves the repository and target, checks authorization and ownership, runs the operation's gates, performs one deterministic write, and returns a typed receipt or typed refusal. A prompt sentence and a parser over shell text are not enforcement.
3. A push is over one exact tree: the runner rebases first when required, runs the changed-set gates on the resulting tree, binds those gate receipts to that tree and clean state, then publishes that tree to the one permitted ref. A source, destination or remote it cannot resolve is refused.
4. A rebase uses one shared resolver: git and the repository's declared merge machinery first, then one bounded lightweight-model round with the thread context and `AGENTS.md` for a conflict git leaves. The pull-request sweep and the child's `rebase` tool do not grow separate conflict semantics.
5. Every successful effect records what changed, where, and at which sha or external version. Every refusal names a closed reason a caller can branch on; user-facing words are rendered after the fact, never parsed back into control flow.
6. The boundary admits future connectors without giving the child a general-purpose credential or inventing another text guard. Linear is the first connector shape, not a special path.

A rebase does mutate the checkout, unlike the other examples. It belongs here because it rewrites the ancestry of the exact tree the runner may publish, reads a remote base, can require conflict resolution, and invalidates the push gates. “Beyond ordinary edits in the checkout” is the useful boundary: a child may edit and test; the runner owns every mutation that determines or changes externally visible state.

## TL;DR

The child can currently publish by composing a shell string, while the runner tries to infer whether the string is safe. Pull request #2164 demonstrated the asymmetry: ten review rounds and thirteen force-pushes on 2026-09-21 still left another textual bypass because aliases, `git -c`, `GIT_CONFIG`, scripts, command substitutions and compound commands make “all ways to spell a push” unbounded. Rebase is split the same way: the child's mandatory pre-push rebase is a paragraph in `REBASE_BEFORE_PUSH`, while the pull-request sweep has a deterministic two-rung resolver. Adding connector writes on that foundation would repeat the error with broader credentials.

The bet is one runner-owned typed side-effect seam. A child asks for `push`, `rebase`, `open_pr`, `comment` or `connector.<name>.<operation>` with typed arguments. The runner reads the world, applies authorization and ownership, runs the operation's deterministic gates, performs the write, and records a typed receipt — what changed, where and at which sha or version — or returns a typed refusal. The child keeps a shell for work inside its checkout, but the shell has no route or credential for these effects. Doing nothing keeps correctness proportional to how many shell spellings and future write APIs a text judge remembers.

## Today at `b43af4a5`

| Effect | Owner and mechanism at `b43af4a5` | Consequence |
| --- | --- | --- |
| Push from a coding child | The child runs `git push` in `bash`. `src/core/harness/pi/toolRules.ts` finds text matching `GIT_PUSH`, tokenizes the tail in `judgePush`, and compares the apparent remote and destination with the run context. Its own comment records the accepted gap: an omitted refspec can follow a checkout the text rule cannot know. | The decision is over syntax rather than the effective remote, refspecs, source trees, destination refs, checkout and git configuration. Every newly recognized shell or git form adds another parser case, and an unrecognized form inherits authority instead of being impossible. |
| Changed-set gates before push | `REBASE_BEFORE_PUSH` in `src/agents/registry.ts` tells the child to fetch, rebase, resolve, rerun the fast gates, then push. Issue #2152 records two heads that reached CI with formatting red because the child ran the gates before the rebase changed the tree. | The instruction states the right order but cannot bind a receipt to the tree that is actually published. The review loop pays for a malformed head after publication. |
| Rebase and conflict resolution | The same prompt paragraph tells the child to resolve a conflict in one bounded model round. Separately, `src/core/pullSweep.ts`, `src/execution/gitRebase.ts` and `src/execution/sweepCheckout.ts` implement the sweep's real two-rung resolver: git with repository merge drivers and `rerere`, then one bounded model round for a conflict git leaves. | One semantic operation has two owners. The prompt can drift from the executable resolver, and fixes to retry, range-diff, lease or conflict handling must be rediscovered in both paths. |
| Salvage push | `preserveCodingChildWork` in `src/core/dispatch/runLoop.ts` calls `salvageBudgetPush` through the runner, records a `pushed_head` event and returns the retained branch/head. Pull request #2136 and issue #2153 are the concrete path. | The runner already performs a typed push when preservation matters. This is evidence that the boundary is viable, not a special exception to preserve. |
| Pull-request open/update and comment | Coding runs submit a typed PR description, but other GitHub writes are still spread among post-steps and effect-specific interfaces. | The useful shape exists in one place but is not the rule for every write. Receipt and refusal vocabularies remain operation-local and hard to compose. |
| Connector write | Pull request #1625 proposes connector work, including Linear. No common runner-owned write contract exists for it. | A connector built now must either expose a credential-bearing general tool to the child or repeat a bespoke parser/post-step boundary. |

The defect is not that `judgePush` has too few cases. Its input is the wrong type. By the time it sees a bash string, the child has already selected an interpreter, git configuration, executable lookup, current checkout and command-composition language. Reconstructing the effective write means reimplementing the shell and git's configuration/refspec semantics inside a guard; accepting anything less makes an omitted case an authorization path.

## The shape

### One effect port, closed commands

The runner exposes one `RunEffects` port whose request is a shared envelope around a discriminated command union:

```text
{ effectId, command: { kind, ...arguments } }
```

The caller mints the stable `effectId`, persists it before the first dispatch, and reuses it for every retry or resumed call. Every success receipt echoes that id. The concrete command names are the child's tools and remain narrow:

- `push({ repository, branch, expectedHead, base, gateSet })`
- `rebase({ repository, branch, expectedHead, base })`
- `open_pr({ repository, branch, base, expectedHead, description })`
- `comment({ repository, subject, expectedVersion?, body })`
- `connector.linear.update_issue({ connection, issue, expectedVersion, patch })`, generalized at the registry boundary as `connector.<name>.<operation>`

These are commands, not shell fragments. Arguments carry canonical identifiers, expected versions and structured payloads; they do not carry an executable, arbitrary flags, a remote URL, a command prefix or an “extra arguments” escape hatch. The runner resolves the actual endpoint and credential from the run's admitted repository, actor and connection. A new side effect is a new command variant, policy row, implementation and conformance row — not another allowed string.

The port has at least two implementations under the repository's boundary rule: production effects and a recording implementation used by tests and dry runs. The production implementation may call git as an argument vector or call a remote API, but the child cannot select that lower-level transport. The child shell runs without the credential and route needed to make these writes. Defense in depth may still reject the words `git push`, but the rule shrinks to one fact: **the child does not push**. It no longer tries to prove that one textual push is the safe push.

### One lifecycle for every effect

Every command passes the same five phases:

1. **Resolve.** Read fresh repository, branch, pull-request, connector and run-owner facts. Resolve the canonical endpoint and resource; never trust a child-supplied URL or infer current state from an earlier turn.
2. **Authorize and fence.** Ask the existing policy table against the resolved actor and operation. Check the run owns the repository, branch, pull request or connector resource, and compare the expected sha/version. A stale fact is a typed refusal, not permission to overwrite it.
3. **Prepare and gate.** Run the deterministic preconditions that belong to the operation. A push owns rebase-first and changed-set gates on the exact resulting tree. A rebase owns the shared resolver. A pull-request update owns head equality and description-anchor generation. A connector owns its schema and external precondition.
4. **Perform once.** Issue one transport operation through an argument-vector git adapter or typed remote client. No shell interpolation; a retry or resumed call reuses the persisted envelope `effectId` and is safe for that operation, or is refused when idempotence cannot be established.
5. **Record.** Append a typed receipt or refusal to the run before returning it. A success receipt echoes the command's `effectId`; the receipt is the durable input to the next unit transition and to the orchestrator of record 0073.

The runner therefore reads before it acts, the same missing discipline exposed by issues #2182 and #2185: a red check may name an operator action rather than code, and a pull request may have merged while a child was working. The effect boundary cannot turn an old snapshot into a new write. It re-reads the resource immediately before its fenced operation and refuses or returns the already-completed fact when the world moved.

### Receipts and refusals are data

All successful receipts share an envelope:

```text
{ effectId, kind, actor, repository?, resource, before, after, occurredAt, evidence }
```

`before` and `after` are operation-specific typed values. A push records the source tree and commit, destination repository and ref, previous remote sha, published sha, and gate receipts bound to the source tree. A rebase records old head, fetched base sha, new head, whether git or the bounded model resolved it, conflict paths and range-diff result. A pull-request write records number, URL, action (`opened` or `updated`) and head. A comment records its subject and immutable comment id. A connector write records connector, operation, external resource id, previous version and resulting version.

Refusals share an envelope but use a closed reason union such as `wrong_repository`, `wrong_ref`, `stale_head`, `dirty_tree`, `gates_missing`, `gate_failed`, `base_moved`, `conflict_unresolved`, `not_owner`, `not_authorized`, `resource_closed`, `version_changed`, `credential_unavailable` and `transport_refused`. Each carries the current fact and the expected fact where that is safe. The caller branches on `reason`; one wording function turns it into a message. A transport's free text is evidence, never the control value.

The caller-minted, pre-dispatch `effectId` makes retries and resumes observable. The caller reuses that persisted id; if it already has a success receipt, the runner returns the receipt with the same id. If it has an in-flight fenced operation, the caller waits or receives `in_progress`; it does not start a second write. If a remote API cannot provide an idempotency key, the runner resolves the resource after an ambiguous response before deciding whether a retry under that id is safe.

### Push owns the exact-tree proof

`push` is deliberately higher level than “invoke git push”. Given the admitted repository, run-owned branch, expected head, base and gate set, the runner:

1. requires a clean checkout at `expectedHead` and resolves its tree;
2. fetches the base and runs the shared `rebase` operation;
3. resolves the rebased commit and tree again;
4. runs the changed-set gates required by the repository on that exact tree and records each exit plus the tree id and clean state;
5. rechecks that the checkout, tree, source ref, effective remote endpoint and remote destination have not changed;
6. publishes exactly that source commit to exactly the run-owned destination, with a lease against the observed remote head; and
7. records the old remote sha, published sha, destination and gate receipts.

There is no accepted omitted-refspec or configured-refspec form because no refspec crosses the port. There is no alternate remote or `pushurl` choice because the repository binding resolves one endpoint. There is no alias, `git -c`, `GIT_CONFIG`, hook, command substitution, wrapper script, mirror, tag fan-out or compound-command case because none is an argument. If the branch requires a force update after rebase, that is an explicit lease-bound mode selected by the runner from the rebase receipt, not a flag the child can smuggle through.

A failed canonical gate invalidates the exact-tree proof. A mutation after the gates changes the tree or dirty-state comparison and forces a fresh gate run. The proof is therefore about the published object, not the command names the child happened to run.

### Rebase is one shared service

`rebase` extracts and reuses record 0071's sweep resolver rather than calling the child's shell. Rung one fetches the named base, invokes git as an argument vector with the repository's declared merge drivers and `rerere`, and records either the clean new head or the exact conflict set. For a clean result it computes the range-diff so callers know whether the patch changed.

Rung two runs only for a conflict git leaves. It is one bounded lightweight-model round with the unit thread's relevant context, the conflict, the intended patch and the repository's `AGENTS.md`. The round has no publish credential and cannot widen the operation; it returns a resolved tree or a typed `conflict_unresolved` refusal. The runner validates the resulting index, continues the rebase, runs the caller's required gates and records which rung produced the new head.

The sweep and a live coding unit call this same service with different ownership and follow-up policy. The sweep may carry an approval when range-diff says the patch is unchanged; the live unit may continue its coding round. Neither reimplements conflict mechanics. Pull request #2158, which fixed issue #2153, becomes a caller of the shared resolver rather than a prompt-only approximation of it.

### Pull requests, comments and connectors compose the same way

`open_pr` is create-or-update by the run-owned repository, branch, base and expected head. It reads an existing pull request first; if one already owns that head it updates through the same command and returns `action: updated`, so a retry or resumed caller using the persisted envelope `effectId` cannot create a rival. It validates the typed description, regenerates head-bound anchors after any rebase, writes through the GitHub client and records the pull-request number, URL and head.

`comment` names a typed subject — pull request, issue or unit thread — while its shared command envelope carries the caller-minted `effectId`. The runner resolves that subject under the admitted repository and actor, posts once, and records the immutable comment id in a receipt that echoes the id. A child cannot post to an arbitrary URL or let comment text select a second operation.

A connector module contributes operations to the same registry: argument schema, resolver, authorization action, ownership/freshness check, deterministic adapter, receipt/refusal types and recording fake. Linear's first operation is an issue update with connection id, issue id, expected version and typed patch. Its access token remains in the runner's connector adapter. Adding another connector changes the registry; it does not expand shell authority.

## One hard-case trace: pull request #2164 makes the parser lose by construction

1. A coding child needs to publish its run-owned branch. Today it writes a bash string that includes `git push`; the harness's `GIT_PUSH` expression extracts a suffix and `judgePush` tries to recover the remote and destination from words.
2. The first guard recognizes the obvious spelling. Another valid git spelling changes the effective operation without changing the words the judge understands: an alias, a `git -c` override, `GIT_CONFIG` environment, a wrapper script, configured `remote.<name>.push` or `pushurl`, an omitted refspec, a command substitution, or a compound command that mutates state around the recognized fragment.
3. Pull request #2164 spent ten review rounds and thirteen force-pushes on 2026-09-21 closing successive forms. Issue #2173 records how each review widened the same invariant by one source, destination, remote or composition case until the round cap ended otherwise converging work. Each fix made the accepted language larger or the parser more shell-aware; none changed the fact that the interpreter and git, not the judge, define the operation. One more composition form could always move the effective source, destination or credential outside the parser's model.
4. The gate proof suffered the same abstraction leak. A formatter receipt could be earned on one tree, then a rebase or another mutating command could change the tree before the textual push. Issue #2152 paid a review round for each unformatted published head because nothing at the effect boundary compared the receipt's tree with the source tree.
5. Under this record the child emits `push({ repository, branch, expectedHead, base, gateSet })`. There is no text to outsmart. The runner resolves one admitted endpoint and one run-owned destination, runs the shared rebase, binds changed-set gate receipts to the resulting tree and clean state, lease-publishes that commit, and returns one receipt. An unsupported source, destination, dirty state, moved base or failed gate is a named refusal before any write.
6. The hard case stops being “did the parser recognize every way to invoke git?” and becomes the finite question the runner can test exhaustively: “does this typed command resolve to exactly one permitted effect, and does its receipt prove the object written?”

The trace is why a more complete `judgePush` is not an incremental route to this design. Its tenth review round was not evidence that the remaining parser work was small; it was evidence that the input language has no useful bound.

## The difficulty map

1. **Removing the child's write route, not merely adding a preferred tool** (most consequential). If the shell keeps a repository-write credential or can reach a credentialed git proxy, `push` is convention rather than a seam. Resident, cold and salvage execution must all separate ordinary checkout commands from runner-owned effect credentials without breaking read-only fetches.
2. **Binding changed-set gates to the exact tree.** A command-name receipt is insufficient. The runner must bind gate kind, exit, tool/version where relevant, commit tree and clean state; any failed canonical gate or later mutation invalidates the proof. Rebase and generated-file repair make this ordering easy to get subtly wrong.
3. **Sharing the rebase resolver without sharing ownership policy.** The sweep, a live unit and salvage have different next states, but must use one git/rerere/model mechanism. The extraction must separate “produce a rebased result” from “carry approval, continue review, park or salvage”. Otherwise the new seam only relocates today's duplication.
4. **Ambiguous remote outcomes.** Git and connector transports can time out after the remote accepted a write. Caller-minted effect ids persisted before dispatch, leases, expected versions and a read-after-ambiguity rule are required so retry or resume means “return the existing receipt for that id or safely try once”, not “possibly post or push twice”.
5. **Fresh reads immediately before writes.** Issues #2182 and #2185 show the runner acting on stale classifications or pull-request state. The seam must make resolve-and-fence part of every operation, including a pull request merged, closed or moved while a child was working.
6. **Typed refusal coverage without a universal string bucket.** A closed union must be broad enough for git, GitHub and connectors but cannot collapse unknown transport text into `other` and ask callers to parse it. Each adapter maps its known failures and treats an unmapped one as an internal effect failure with sanitized evidence.
7. **Connector modularity.** `connector.<name>.<operation>` must not become a dynamic escape hatch whose schema and permission are arbitrary at runtime. Each installed connector publishes a compile-time operation registry and an authorization mapping; a missing operation is refused before credentials are touched.
8. **Migration while work is live.** A branch or pull request may have been created through today's path and resumed after the typed tools ship. Adoption must derive expected heads and ownership from durable facts, mint and persist an `effectId` before its first typed dispatch, then reuse that id on later resumes, while preventing both the old shell path and the new effect command from owning one write.

## The hard parts

**The credential boundary is the architecture.** The strongest type does nothing if `bash` can still perform the same write. The child's executor needs ordinary filesystem and read-only repository access; the effect implementation needs short-lived, resource-scoped write authority. The runner is where those domains meet. This extends record 0009's credential separation: the credential can live with the execution plane, but only the runner-owned effect adapter may spend it on the admitted operation.

**A receipt proves an object, not a ceremony.** “Prettier ran” is not useful evidence unless it names the tree later published. “Rebased” is not useful unless it names old head, base sha and new head. “PR updated” is not useful unless it names the pull request and head. The receipt's hashes and versions make the next transition deterministic; logs and prose remain explanation, not authority.

**Conflict resolution is deterministic around one bounded judgement.** Git's merge drivers, rerere, index and continuation rules are deterministic. Understanding one unresolved hunk may need judgement. The design isolates that judgement in one lightweight-model rung whose output is validated and resumed by deterministic code. It does not put an LLM in charge of choosing the remote, widening scope or deciding whether the push gates count.

**The seam catches scope widening at the last safe point.** Issue #2174 describes a child entering a sibling unit's live scope because a prompt sentence was the only fence. The runner sees the exact post-rebase diff and every live unit's declared ownership before publication. A conflicting path can therefore return `not_owner` with the owning unit named, or hand the finding to that owner, before the remote branch changes. Admission remains the first fence; the typed effect seam is the final one.

**Reads and writes compose through record 0073.** Record 0073's orchestrator composes bounded unit acts. This record supplies the acts it can safely compose: each command starts from fresh facts and ends in a receipt or refusal. The orchestrator can choose *which* typed effect to request; it cannot forge the effect's facts, gates or result. Record 0071's unit still owns its pull request, now through receipts keyed by the persisted `effectId` that the unit machine can adopt after a restart.

**A composite effect is one typed effect, not a sequence of independently safe writes.** Issue #2187 deployed the runner Worker from one commit while leaving its child container on another, so two individually valid deployment steps produced one invalid service. The same seam must eventually make a deploy resolve the Worker, container image and configuration as one versioned set, then move the required set or refuse before its first write. This record's four-unit rollout starts with child effects; the deploy is the same architectural class, not a fifth unit hidden in this sketch.

## Why not X

**Why not complete the text guard?** The language is unbounded. Correctly judging a shell string requires shell parsing and expansion, executable and alias resolution, environment and git-config evaluation, current checkout and configured refspec expansion, hook and wrapper behavior, and compound-command state. Refusing every form the judge cannot prove eventually reduces to the typed command proposed here, except with worse errors and no receipt. Pull request #2164's ten rounds and thirteen force-pushes are the empirical result.

**Why not remote-side hooks alone?** A remote hook can protect destination refs and repository policy after bytes arrive. It cannot run the repository's changed-set gates on the child's exact local tree, prove a clean state, resolve a pre-push rebase, regenerate artifacts under `AGENTS.md`, or attach those results to the run before publication. Remote protections remain defense in depth; they do not own the operation.

**Why not leave it to CI?** CI observes a head only after it has been published. Issue #2152 shows the cost: an unformatted head enters review, the red result arrives later, and the pipeline pays another review/fix round for evidence the runner could have required before the write. CI remains the full verification gate; the typed push owns the fast gates precisely because they are cheap, changed-set scoped and about the tree being published.

**Why not expose a generic authenticated HTTP or git tool?** That moves the credential but not the decision. A generic transport lets the child choose the endpoint, method, ref and retry semantics, so authorization returns to prose. Narrow commands keep resource resolution, freshness, idempotence and receipts inside the runner.

**Why not keep separate purpose-built post-steps?** Post-steps are safer than a credentialed shell but still distribute the lifecycle across callers. Push, rebase, pull-request and connector writes need the same resolve, authorize, fence, perform and record shape. One port makes the invariant testable and gives record 0073 one vocabulary to compose.

## Relations and boundaries

[Record 0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) decides that the orchestrator composes deterministic unit acts; this record defines the typed side-effect acts and receipts it composes. [Record 0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md) keeps the unit's pull-request ownership, unconditional pre-push rebase and two-rung resolver; this record moves their enforcement from a child prompt and duplicate paths into one runner service.

Issues #2152 and pull request #2164 are the exact-tree and text-guard failures; issue #2173 records the round-cap cost of discovering their one invariant case by case. Issue #2153 and pull request #2158 supply the conflict and salvage correction; pull request #2136 shows the runner already performing the typed preservation push. Pull request #1625 is the connector pressure this boundary must absorb. Issue #2174 is the sibling-scope widening the seam can refuse before publication. Issues #2182 and #2185 require the runner to read current external facts before it acts. Issue #2187 is the same boundary failure at deploy scale: moving one half of a versioned service is an untyped side effect even when each individual write is valid.

Unchanged: the policy table remains the one authorization decision; the unit machine and merge door retain their guards; CI remains the full verification gate; `AGENTS.md` remains the repository-owned instruction for generated files; a person still accepts this architectural decision and merges wherever the effective grant requires a person. This record does not define autonomous merge, connector discovery, a generic workflow language or a new credential store.

Not claimed: that the seam exists at `b43af4a5`. Salvage and the pull-request sweep are evidence and source material, not implementation of the whole decision. Until all side-effect paths migrate and the child shell cannot spend write authority, the architecture remains proposed.

## Rollout sketch

This is a sketch inside the record, not an executable plan. Acceptance is a person's later step; no implementation unit begins merely because this proposal merges.

- **Unit one — `push`.** Add the typed tool and runner effect command. Resolve exactly one source tree, endpoint and run-owned destination; run rebase first, then changed-set gates on the exact tree and clean state; lease-publish it and record the receipt. Remove publish authority from the child shell. Shrink `judgePush` to one rule: the child does not push.
- **Unit two — `rebase`.** Extract the sweep's git/rerere/range-diff machinery and bounded lightweight-model rung into one shared runner service. Both the live unit and sweep call it; conflict, stale base and unresolved judgement are typed outcomes.
- **Unit three — `open_pr` and `comment`.** Move create-or-update pull-request and comment writes behind the effect port with expected-head/version fences, caller-minted effect ids persisted before dispatch and durable receipts that echo those ids. Adopt existing pull requests rather than creating rivals.
- **Unit four — connectors.** Define the connector operation registry and adapter contract; land Linear as the first implementation from pull request #1625. Its issue update carries an expected version and typed patch, and its credential never enters the child's tools or shell.

Each unit includes a recording implementation and conformance rows for resolve, authorize, fence, perform, receipt, retry or resume with the same persisted `effectId`, and refusal. Migration removes the old write path in the same unit that supplies its typed replacement; there is never a steady state where both are authoritative.

## Cold-reader and acceptance gates

Before acceptance, give a fresh reader only this record and ask for three things: restate the bet, name the hardest part, and state the first objection they had plus the passage that answers it. The gate passes only when the restatement includes both halves — the child has narrow typed commands and no write route through its shell; the runner reads fresh facts, owns operation-specific gates and records receipts — and the hardest part and objection can be located without session context. An author-side reread is not a fresh-reader receipt.

This pull request deliberately leaves `status: proposed`. Its cold-reader gate ran before acceptance, and the receipt is recorded as a pull-request comment. A person decides whether to accept the bet and records that acceptance in the repository's normal follow-up change. Merge of this proposal is permission to preserve and review the decision, not acceptance and not permission to implement it.

## Sources

- Pull request #2164 — ten review rounds and thirteen force-pushes on 2026-09-21 while successive text-level push bypasses were closed.
- Issue #2173 — each round widened the same push invariant by one source, destination, remote or composition case until the cap ended the work.
- Issue #2152 — changed-set gates ran before a rebase changed the tree; two formatting-red heads entered CI and cost review/fix rounds.
- Issue #2153 and pull request #2158 — the prompt conflict and the correction that keeps pre-push conflicts and salvage inside the unit.
- Pull request #2136 — coding-child salvage as a runner-performed push with a retained head.
- Pull request #1625 — connector work, with Linear as the first write shape this boundary must support.
- Issue #2174 — a child's diff widened into a sibling unit's live scope before publication.
- Issues #2182 and #2185 — the runner must classify and re-read the world before dispatching or writing.
- Issue #2187 — a bot-only deploy moved the runner Worker while leaving its child container on an older commit, demonstrating the same boundary failure across a composite service write.
- `src/core/harness/pi/toolRules.ts`, `src/agents/registry.ts`, `src/core/dispatch/runLoop.ts`, `src/core/pullSweep.ts`, `src/execution/gitRebase.ts`, and `src/execution/sweepCheckout.ts` at `b43af4a5` — the text judge, prompt rebase, typed salvage and executable two-rung resolver described by the today table.
- Records [0071](0071-a-ship-unit-owns-its-pull-request-until-it-is-merged-merge-ready-waits-on-facts-and-a-dirty-head-buys-a-rebase-round.md) and [0073](0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md).

## Public hygiene

This record keeps only public issue and pull-request numbers, repository-relative paths, one public-tree sha and the date required to audit the hard-case trace. It carries no Slack channel, user or message ids, no private URL, no customer or company name, no credential and no unpublished account detail.
