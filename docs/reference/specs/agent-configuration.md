# Agent configuration

Shipped defaults and installation settings use one declarative agent configuration language.

- **Code**: `scripts/docs-gen.ts`, `config/agents.schema.json`, `src/core/dispatch/reply.ts`, `src/core/memory/index.ts`, `src/core/installationSettings.ts`, `src/config/agents.ts`, `src/agents/defaults.json`, `src/agents/registry.ts`, `src/agents/resourceLifetime.ts`, `src/config.ts`, `src/intakeModel.ts`, `src/core/dispatch/operator.ts`
- **Tests**: `src/config/agents.test.ts`, `src/agents/registry.test.ts`, `src/agents/resourceLifetime.test.ts`, `src/intakeModel.test.ts`, `src/core/dispatch/operatorResponses.test.ts`, `src/core/memory/index.test.ts`, `src/core/installationSettings.test.ts`
- **Docs**: [Configure your defaults](../../how-to/configure-your-defaults.md)

## Behavior

1. An installation declaring `extends: builtin` extends the shipped document. Named profiles hold model, model settings and harness settings. Agent definitions hold instructions, tools and limits using the same fields in both documents.
2. Profile inheritance is explicit and acyclic. Agent settings override their profile. Installation fields override shipped fields. An omitted effort inherits with its model settings; explicit null clears it. Unknown fields, agents, profiles and provider references fail at load.
3. Agents and internal model callers use the same settings resolver. Operator and intake have independent profiles; neither is coupled to General. Memory reflection uses its own profile. Ship remains a deterministic workflow over configured coding/review agents.
4. Existing YAML retains its resolution and background fallbacks through a compatibility reader. Mixing legacy model/effort/harness keys with the new DSL fails rather than silently selecting a value. Existing request, thread, user and channel overrides retain their precedence.
5. Configured instructions, toolsets, output caps and wall-clock caps apply to fresh runs. Installation limits can narrow the shipped wall-clock lease; the runaway turn guard is derived from that lease. Shipped definitions remain immutable, and authorization still applies to the resolved agent.
6. Resource lifetime is versioned registered purpose/placement data, separate from the effective profile. Review declares retained resident placement and prospective exclusive original cold scratch after session/report/publication custody. Other registered agents declare retained work; missing or unknown declaration data remains retained. Installation configuration cannot change this capability, and fresh run definitions receive independent nested copies. Names, prompts, tools, read-only profiles and raw flags do not grant it. This declaration alone enables no allocation, cleanup or old-run retrofit; original admission and runtime consumers remain separate requirements.

## Validation criteria

| Criterion | Proof |
|---|---|
| Registered purpose data gives Review only a prospective cold lifetime while preserving resident placement and every unrelated agent's retained declaration | `[unit]` `src/agents/registry.test.ts::agent registry matches the feature specs::declares Review lifetime as purpose data while every unrelated agent remains retained` |
| The shared closed lifetime schema refuses partial, unknown and contradictory declarations; missing or unreadable data is retained without interpreting labels or caller flags | `[unit]` `src/agents/resourceLifetime.test.ts::registered resource lifetime schema::*` |
| Installation changes cannot elevate or replace registered lifetime; the unchanged declaration may round-trip, and per-run nested data is isolated from builtins and other runs | `[unit]` `src/config/agents.test.ts::agent configuration DSL::keeps lifetime registered while names prompts tools and model settings cannot elevate it`; `::accepts an unchanged registered declaration but rejects lifetime changes and malformed schema`; `::isolates nested lifetime data between runs builtin definitions and installation snapshots` |
| Shipped defaults resolve every agent and internal model caller | `[unit]` `src/config/agents.test.ts::agent configuration DSL::extends the shipped DSL and resolves every agent and internal caller explicitly` |
| Installation fields, inherited profiles and agent fields resolve in order | `[unit]` `src/config/agents.test.ts::agent configuration DSL::extends named profiles and applies installation, profile and agent settings in order` |
| Explicit null clears effort while the operator keeps its own settings | `[unit]` `src/config/agents.test.ts::agent configuration DSL::clears inherited effort explicitly and keeps operator settings independent of General` |
| Operator, intake and reflection completions consume the shared settings | `[unit]` `src/core/dispatch/operatorResponses.test.ts::the direct operator on the Responses wire::uses the independent operator profile on the actual Responses request`, `src/intakeModel.test.ts::intakeCompletion — the intake composition root::resolves the intake profile independently of the work profile`, `src/core/memory/index.test.ts::scheduleReflection — production completion wiring::carries the reflection model card's cap field into the completion request` |
| Scope and request overrides remain authoritative | `[unit]` `src/config/agents.test.ts::agent configuration DSL::preserves scoped overrides above the installation DSL` |
| Instructions, tools and limits apply without mutating builtins | `[unit]` `src/config/agents.test.ts::agent configuration DSL::uses configured instructions, tools and limits without mutating shipped definitions` |
| Invalid fields, references and profile cycles fail at load | `[unit]` `src/config/agents.test.ts::agent configuration DSL::rejects unknown fields, missing profiles, cycles and undeclared providers at load` |
| Mixed configuration formats fail explicitly | `[unit]` `src/config/agents.test.ts::agent configuration DSL::rejects mixed DSL and legacy settings rather than silently choosing a writer` |
| Existing YAML retains its model and effort fallbacks | `[unit]` `src/config/agents.test.ts::agent configuration DSL::reads existing installation YAML with its original defaults and background fallbacks` |

| The installation view exposes resolved profiles and caller settings without prompt or credential fields | `[unit]` `src/core/installationSettings.test.ts::installationSettings::shows resolved DSL profiles and independent caller settings without exposing instructions` |
