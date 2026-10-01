---
title: Prepared environments and task-directed coding checks - Plan
type: feat
date: 2026-10-01
status: proposed
---

# Prepared environments and task-directed coding checks

## Decision

Separate three questions: whether the workspace is prepared, which check is useful for this task, and what actually happened when that check ran. The execution layer owns preparation, identity, budgets and recovery. The coding agent chooses a bounded baseline using the request and current repository guidance. A shared `run_check` tool records execution facts on the existing run ledger where a trusted checkout and typed executor are available. Publication and review continue to consume their own exact-head evidence.

This replaces the assumption that a useful task baseline must run before the first model turn. It does not remove reproducible environment setup or make the model authoritative about execution results. The default coding workflow needs no central per-repository test command. Existing explicit startup commands remain a deprecated compatibility policy while installations migrate.

## Why this boundary

The original preparation requirement is useful: a coding task should reach its bound checkout with usable dependencies and tools, and setup failures should preserve its work. A fixed command can smoke-test that environment. It cannot generally select the test relevant to a task in a monorepo, distinguish documentation from code changes, or prove assertions were collected merely because the process exited.

[Decision 0073](../decisions/0073-the-ship-pipeline-dissolves-into-the-orchestrator-the-unit-machine-is-the-deterministic-atom-and-judgement-composes-units.md) leaves contextual judgment to the model and factual guards to the system. [Decision 0074](../decisions/0074-a-side-effect-crosses-one-typed-seam.md) explicitly leaves ordinary checkout editing and testing with the child, while runner-owned effects govern publication and other external changes. Neither requires a fixed test before model reasoning. [Decision 0010](../decisions/0010-typed-llm-output.md) requires typed contracts when model decisions cross into control flow; the check's purpose is a typed selection, while its result comes only from execution.

The existing checks-by-cost policy also requires scope-specific validation and leaves expensive whole-suite work to CI. A task-selected baseline fits this constraint; a universal repository command may contradict it.

## Adversarial comparison

| Alternative | Strongest argument | Limitation and disposition |
|---|---|---|
| Fixed command per repository before any model turn | Predictable cost; known smoke test; model cannot omit that execution. | Retain only as compatibility smoke behavior. Its scope can be stale or irrelevant, and a successful exit is not test coverage. |
| Model selects a bounded task baseline | Uses current instructions, task scope, package structure and available tools; no central command inventory. | Chosen workflow. Selection can be wrong or omitted, so evaluate it and record the actual result without pretending selection is deterministic. |
| No baseline expectation | Avoids pointless work for documentation, absent tests and unusually costly environments. | Keep explicit unavailable/not-applicable reporting, but retain a normal expectation to establish useful before-change evidence. |
| Generic preparation probe | Deterministically checks checkout and dependency/tool readiness; directly addresses setup failures. | Keep it separate. Preparation does not establish task-specific code correctness. |
| Read-only discovery followed by a hard edit gate | Can enforce sequencing when execution capabilities and the filesystem truly isolate discovery. | Do not add in this change. Disabling an edit tool while allowing arbitrary shell commands does not enforce it, and executing a model-selected script does not prove that script avoided writes. |
| Infer checks from shell output or command names | Appears easy to add around existing tools. | Reject. Shell syntax and free text do not establish effective behavior; this repeats the parser-based boundary rejected by decision 0074. |

The strongest objection to the chosen design is that durable check execution could grow a second workflow engine. Keep it as a thin adapter over the existing executor, run budget and ledger. Do not add a second owner, a new admission phase, a separate command planner or a generic retry loop. A pending check is an unknown operation, not a fabricated result; it is never automatically replayed merely to unblock a checklist. This change supplies no backend operation lookup or resolution API. Preserve and report unresolved operations until an authoritative reconciliation capability exists.

## Comparison with documented frontier systems

The official sources below were checked on 2026-10-01. These are documented mechanisms, not measured product comparisons or proof of undocumented internal guarantees.

| System/source | Documented behavior | Consequence for this design |
|---|---|---|
| [Anthropic's long-running agent harness research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | An initializer agent creates a reusable startup script; later agents inspect progress and run basic end-to-end checks before implementing a feature. | Model judgment can precede baseline execution. Reusable setup is valuable; rediscovering everything on every task is not the goal. This is a research pattern, not a universal product contract. |
| [Cursor cloud-agent setup](https://cursor.com/docs/cloud-agent/setup) and [environment engineering](https://cursor.com/blog/cloud-agent-environment) | Agent-led setup produces reusable Builds; setup is separate from repository test instructions. Cursor also describes a discoverable environment CLI and process supervision rather than relying on instructions alone. | Keep preparation reliable and discoverable while the agent chooses task-relevant checks. Deterministic operations and adaptive decisions complement each other. |
| [Codex local environments](https://learn.chatgpt.com/docs/environments/local-environment) and [repository instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | Worktree setup scripts and common test actions are separate from repository instructions used by the agent. | Environment configuration can remain reproducible without making a central fixed baseline command mandatory. The [cloud-environment page](https://learn.chatgpt.com/docs/environments/cloud-environment) describes the legacy cloud offering, so it is not evidence for the current local runtime. |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) and [hooks](https://code.claude.com/docs/en/hooks) | Exploration, planning, coding and explicit verification are agent workflow; optional hooks provide deterministic lifecycle enforcement. | An adaptive workflow and an enforceable hard gate are distinct claims. This change provides the former with factual execution records. |
| [GitHub Copilot cloud-agent environment setup](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment) | Deterministic setup preinstalls dependencies instead of depending entirely on agent discovery. A failed setup skips remaining setup steps and the agent starts in the resulting environment. | This supports retaining environment configuration and is a counterexample to assuming every preparation failure must prevent all model reasoning. Switchboard retains its existing stronger ready-workspace policy where configured. |

No inspected source establishes a universal fixed test before the first model turn, or the same durable replay semantics as Switchboard. That absence does not prove vendors lack such mechanisms. The recommendation follows the documented separation of setup, contextual test selection and execution, together with this repository's accepted constraints.

## Implementation contract

- All coding variants receive one shared baseline instruction, independently of typed-receipt support. Read task-relevant instructions/scripts/CI, choose a useful bounded command, execute it before intended edits when applicable, and report unavailable checks honestly.
- `run_check({purpose: "baseline" | "verification", command, timeoutMs?})` uses the current run's bound executor and remaining budget. The caller cannot supply a result or select another run's authority.
- Persist call identity and intent before dispatch; persist the typed result before returning completion. Exact completed replay returns history, changed arguments under the same identity refuse, and unknown execution does not replay automatically.
- The command crosses the shared shell-command restrictions and current harness lifecycle gate; check timeout clipping follows the existing command-budget policy rather than claiming identical harness-specific timeout-refusal behavior. A missing trusted binding or typed executor may leave only ordinary permitted shell evidence after a known pre-execution capability refusal; never claim a typed receipt or use that fallback after policy refusal, unknown execution or persistence failure. Cold/local capability coverage is not implied by shared prompts.
- A baseline receipt remains historical after edits. It never satisfies a later publication gate, represents assertion coverage by itself, or authorizes a write.
- There is no new read-only model phase, shell parser, mandatory whole-suite default, model/effort selection, replacement workspace or publication permission.
- `ReadyEnvironmentRequirement.testCommand` becomes optional. `dependencyDir` and `requiredTools` still define preparation; an explicit legacy `firstAction` requires a valid command. Command absence does not bypass dependency, identity, ownership or same-workspace recovery checks.

## Migration and rollback

1. Land and review the source and specs together. Existing configured startup-smoke behavior and saved legacy resumes remain supported. A source merge alone changes no production configuration.
2. Deploy a release containing optional-command readiness and the shared check tool. Verify the deployed version independently of the merge.
3. Prepare a separate infrastructure change removing only `firstAction` and `testCommand` from the migrated readiness entry. Keep `dependencyDir`, `requiredTools` and the entry itself: the entry also selects owner and recovery guarantees. Merge and apply that change only through the installation's existing approval process, after the containing source release is confirmed.
4. Confirm stored configuration and new-run behavior independently. Run the authorized evaluation procedure in [coding-checks.md](../reference/specs/coding-checks.md). Preserve live acceptance gaps until actual receipts exist.

Previously admitted runs retain their saved policy. Completed legacy `firstTest` records remain history under their original binding rules. Unknown legacy operations retain their original hold, operation ID and workspace; migration neither marks them complete nor starts a replacement test. Their unresolved backend lookup limitation remains explicit.

The old binary requires `testCommand` when a readiness entry exists. After configuration migration, rolling back that binary requires restoring a compatible command/configuration first; otherwise config validation fails. Restoring an explicit startup policy affects new admissions only and must not rewrite saved runs. Rolling back the shared check tool while a run depends on it requires accounting for that run's durable operation state, not deleting its receipts. This change does not authorize a deployment, configuration write, live probe or autonomous merge.

## Acceptance

Automated tests cover shared prompt/tool availability, receipt ordering, typed results, budget and persistence refusals, exact replay, unknown-outcome non-replay and legacy policy compatibility. The [coding-checks spec](../reference/specs/coding-checks.md) binds these to actual test titles; source tests do not prove live behavior or universal executor support.

An authorized evaluation must demonstrate useful selection for a monorepo package, documentation-only handling, a real failing assertion versus unavailable setup, and separate baseline/verification receipts. Inspect the first intended edit against the observed baseline in the transcript, while keeping the explicit limit: this is observed workflow ordering, not a structural pre-edit guarantee. Evaluation receipts stay outside the repository.
