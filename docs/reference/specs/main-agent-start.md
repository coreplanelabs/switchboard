# Main agent starts private work

A plain-language fix request starts one existing Ship coordinator unit with the question and sourced findings in a durable brief. The dispatcher supplies the requester, conversation, message ID, permissions, and private worker availability. The unit keeps person review and merge gates.

- **Code**: `src/core/coordinator/mainStart.ts`, `src/core/coordinator/handOff.ts`, `src/core/coordinator/briefs.ts`
- **Tests**: `src/core/coordinator/mainStart.test.ts`, `src/core/coordinator/handOff.test.ts`, `src/core/coordinator/briefs.test.ts`, `src/channels/adminCoordinator.test.ts`

| Criterion | Proof |
|---|---|
| A main-agent start binds a bounded question, findings, requested change and acceptance to one fresh person-merged unit. The source message ID gives the act a stable identity; retries preserve the original unit and evidence. A denied repository, foreign origin, missing message ID or unavailable private worker starts nothing. | `[unit]` `src/core/coordinator/mainStart.test.ts::main-agent private worker start::binds a plain-language fix and sourced findings to one fresh person-merged unit`; `::repeats one user message without starting a second worker or replacing evidence`; `::refuses foreign origins, unbound messages, denied repositories, and absent private IO before claiming` |
| A main-agent task remains a generated, person-merged unit even when its ordinary prose resembles a seeded plan request. | `[unit]` `src/core/coordinator/mainStart.test.ts::main-agent private worker start::treats task prose that resembles a plan command as a person-merged fix` |
| The main run answers while the worker continues, so it is not reused as the worker host record. The child's task comes from the durable brief. Task prose cannot override coordinator-selected child model, effort or budget. | `[unit]` `src/core/coordinator/handOff.test.ts::main-agent work hand-off::an act replay keeps one durable unit and no second attempt despite changed text`; `src/core/coordinator/briefs.test.ts::composeChild — the child a brief names::a generated unit carries its attributed query result and time window as data into round zero` |
| A started main task's generated unit moves to private IO before coding spawn, with no Slack child thread opened. | `[unit]` `src/channels/adminCoordinator.test.ts::the plan runner's steps — plan, unit-start, branch, round, unit-end, finish (item 9)::a plain fix hand-off binds its generated child to private IO before any spawn` |
| A deployed main agent can call start, the child runs through private IO, and the main thread receives its report. | `[gap]` Runtime tool wiring, private child path and main-thread report proof follow. |
