---
title: A deploy drains the resident fleet — admission closes to new runs, the runs in flight end, the swap lands, admission reopens
status: proposed
date: 2026-09-18
pattern: Drain-then-swap, the bot's own SIGTERM drain moved one level up to the fleet; one record with an end in the registry every attach already passes; the run in flight is told from the new one by the registration it already holds; the deployer waits on the count it already reads; every wait names its end
---

# A deploy drains the resident fleet — admission closes to new runs, the runs in flight end, the swap lands, admission reopens

**The ask.** Decide (the maintainer, before the next release lands under working-hours traffic): adopt the fleet drain as the resident step's mechanism, and give the deploy workflow a drain-only bearer as its `RESIDENT_DRAIN_TOKEN` secret. Success: a release whose deploy starts with runs in flight on the resident lands within the longest of those runs' remaining leases plus a margin, kills none of them, and a run asked during the drain starts after the deploy with the wait named on its card.

## TL;DR

Three consecutive releases of one evening deployed the bot and the memory Worker and then refused at the resident for their whole 30-minute wait — five waits, one hundred and fifty minutes — because the resident preflight waits for a minute with no run in flight, and steady traffic, with two to four runs in flight at every look and a new one landing every ten to twenty minutes, never has one. The bet is to make the wait end by construction: the deploy closes the fleet to **new** runs first (a **drain**, one record with an end in the registry Durable Object, read by the attach path), the runs already in flight finish and release, the preflight reads zero, the deploy lands, the fleet reopens. It costs a new write on the deploy path — a bearer in CI that can drain and undrain and nothing else — and, for a run asked during a drain, a wait of up to the longest in-flight lease at its attach instead of a start. Decided: the record, the routes and their scope, the gate and its exemption for runs in flight, the client's wait and the runner's drain; open: a card line while a run waits, and what the dispatcher does with a run whose lease cannot hold the wait. Doing nothing leaves every release split until a person waits for a lull or forces the swap over live runs.

## Today at `dc064a18`

The delta from what a reader of the deploy specs expects, each with its proof.

1. **The resident preflight refuses on any run in flight and the runner waits for silence.** `deploy/cloudflare-resident/preflight.mjs` `decide` refuses while any resident's `runsInFlight` is above zero; `src/deploy/run.ts` retries the whole `npm run deploy` every minute for `RESIDENT_WAIT_MAX_MS` (30 min, `src/deploy/plan.ts`) and then fails by name (release-and-deploy item 13). Nothing stops new runs from landing during the wait.
2. **The bot already drains itself; the resident cannot.** On SIGTERM the bot closes its Slack socket and holds until in-flight runs finish or hand off (`src/index.ts`, `src/core/drain.ts` `DRAIN_DEADLINE_MS` 15 min). A resident Worker deploy swaps every ResidentDO isolate and invalidates the Sandbox SDK process handles of every run inside (resident-repos item 44): there is nothing to hand a running command to.
3. **Every attach passes one registry, and every run in flight holds a registration.** `ResidentRegistryDO` (`deploy/cloudflare-resident/worker.ts`) is a singleton named `registry`; the attach handler resolves the thread's route through it, and `GET /residents` lists from it. Inside the resident, `registerRun` writes a `runReg:<threadKey>` row at a successful attach and `evictBinding` clears it at the release, so the row exists exactly while a run is in flight (item 44's revision); a re-attach refreshes it.
4. **The client already waits on a refusal it can read.** `ResidentExecutor.attach` (`src/execution/resident.ts`) waits through a refusal the Worker typed transient and through a rolling container (item 65), re-attaching on a budget and returning the wait as `wokeAfterMs`, which the factory prints on the card as `after waiting Ns for the resident`. The run's remaining lease is read from `opts.remainingMs()` at each attach it opens.
5. **CI holds the read bearer only, and the Worker knows three scopes.** `deploy-production.yml` passes `RESIDENT_READ_TOKEN`; `tokenScope` answers `admin`, `operator` or `read`, and `hasScope` passes admin everywhere and every other scope only on its own routes. Admin can onboard, offboard, reconfigure and rebuild a resident.

## The shape

The resident step becomes drain, wait, swap, reopen. Before its first attempt the runner posts `/drain` with the drain bearer: the registry stores `{ since, until, by, reason }`, `until` sixty-five minutes out. From then the attach path answers a real 503 carrying that record to every attach for a thread with no run registration — a **new run** — while an attach for a thread whose run is registered — a **run in flight** re-attaching after a rolled container, an evicted worktree or a bot restart — passes as before; `/exec`, `/read`, `/write`, `/op` and `/detach` are untouched. So the runs in flight finish and release, the runner's preflight reads zero within a minute, the deploy uploads, and in a `finally` the runner posts `/undrain`. The bot's client, meeting the 503, re-attaches every 30 s under the run's own lease less a ten-minute reserve and returns the wait on the binding, so the card's opening note names it. The closest known shape is a load balancer draining a node before a rolling restart: no new connections, the open ones finish, restart, route again. The difference is who asks and who refuses: the deployer asks a registry the callers already consult, the registry refuses at the door, and each caller waits by itself under its own clock, because the deployer is outside every caller and cannot hold their threads.

```
deploy all            registry DO            ResidentDO (per repo)                 bot
   │ POST /drain ───────►│ drain = {until}
   │                     │                  new run's attach (no runReg row) ◄──────┤ POST /attach
   │                     │◄─ getDrain ──────┤                                        │
   │                     ├─ record ────────►├─ 503 draining {until} ────────────────►│ wait 30 s, retry…
   │                     │                  in-flight run's re-attach (runReg row) ◄┤ POST /attach (container rolled)
   │                     │                  ├─ 200 binding (registered: passes) ────►│ run continues
   │ GET /residents (1 min) ──► runsInFlight: 2 … 1 … 0   (in-flight runs finish, /detach clears their rows)
   │ wrangler deploy ─────────────────────────► isolates swapped, nothing inside
   │ POST /undrain ──────►│ drain cleared
   │                     │                  ◄──────────────────────────────────────┤ POST /attach (the waiting run)
   │                     │                  ├─ 200 binding (wokeAfterMs = the wait) ►│ run starts; card notes the wait
```

## One trace: the third release of that evening, replayed with the drain

At 04:44 the resident step begins with two runs in flight on the switchboard resident: a coding child under a 45-minute lease that started at 04:20 (25 min left) and a review that started at 04:41 (about 8 min to go). The runner posts `/drain` for 65 minutes; the registry stores `until` 05:49. Two runs arrive during the drain. At 04:46 a person asks for a coding change in a fresh thread: the attach finds no `runReg` row, meets the 503, and the client re-attaches every 30 s under its lease — a 45-minute ask less the 10-minute reserve, 35 minutes of wait. At 04:50 the coding child's container rolls under it (the platform's own restart); its wake wait re-attaches, finds its `runReg` row, and is admitted through the drain: the run that holds the fleet open is never refused by the drain that waits for it. The review in flight finishes at 04:49 and releases; the preflight reads one. The coding child pushes, writes up and releases at 05:07; at 05:08 the preflight reads zero and the deploy uploads; the swap lands on empty isolates; the runner posts `/undrain` at 05:09 and logs `fleet reopened`. At 05:09:30 the waiting coding run's re-attach is admitted; its binding carries `wokeAfterMs` of about 23 minutes and its card opens with `after waiting 1410s for the resident`. Nothing was killed. Without the drain, the same step refused thirty-one times until 05:30 and deployed nothing, because a third run had started at 04:52.

The second arrival is the one that shows the open question. At 04:52 a person asks for a review under a 25-minute ask: 15 minutes of wait in its lease, and the fleet reopens 17 minutes later. At 05:07 that run ends `refused` with `ResidentDrainingError` naming the 900 s it could wait and the drain's stated end, and the person re-asks after 05:09. The wait is correct; what the dispatcher does next is not yet designed (Open questions).

## The difficulty map

1. **New run or run in flight** — the drain must refuse the first and admit the second through one door, or it refuses the run it waits for. → The gate.
2. **The record outliving the deploy** — Durable Object storage survives the swap; a dead runner would close the fleet for good. → The record's own end.
3. **A run asked during the drain** — it must wait legibly under its own clock, never fail at once and never start on the old generation. → The client's wait.
4. **The arithmetic** — the drained wait must outlast the longest lease a run in flight can hold, or the drain still loses. → The numbers.
5. **The wiring** — five files across three packages, a fourth bearer; the most work, the least risk. → Validation.

## The gate

The constraint: every attach comes through one route, and the ones the drain must let through are exactly the ones that matter most — a run whose container rolled mid-drain re-attaches to continue (item 65), a run whose worktree was evicted re-attaches to recover, a run resumed after a bot restart re-attaches with `reuse`. Refusing any of them ends a run the drain exists to protect, and holds the fleet closed on it. The attach body cannot say which kind it is: a resumed run says `reuse`, a rolled one says nothing.

The design: the resident already knows. `registerRun` writes `runReg:<threadKey>` at a successful attach and the release clears it, so a thread whose run is in flight has the row and a thread starting a run does not. The gate therefore lives in the Durable Object's `attachThreadTraced`, after hydration and before the image reconcile: read the drain from the registry; when it is in force and the thread has no `runReg` row, answer the streamed refusal `{ error: "draining: …", status: 503, draining: <record> }`; otherwise proceed exactly as before. The Worker-level handler gates nothing, because the decision needs the thread's row. The client reads the drain by the `draining` record on a 503, never by the words, so it is a third kind of answer beside the platform's transient (item 27) and a deterministic refusal, and it is never mistaken for either.

Invariants: no attach for a thread with a `runReg` row is refused by the drain; every attach for a thread without one is, while the record is in force; the row is written only by a successful attach and cleared only by a release. Failure modes: a registration whose release never came (the clean-idle sweep's case) lets one new run of that thread through the drain — thread-scoped, rare, and the sweep clears it; the drain lifts while a re-attach is in flight — the re-attach is admitted, nothing is lost; the registry cannot be read at the attach — that is no drain, said in the log, because a run must never fail on a flag it could not read, and the deploy's own preflight fails closed on its side (an unreadable fleet refuses the deploy), so the failure lands on the deploy and never on the run. The alternative rejected: a flag on the attach body naming a re-attach. The client would have to know at every attach site whether it is continuing a run, the sites are five, and a lie (a fresh run claiming to continue) would pass the drain; the row is a fact the resident holds and the caller cannot forge.

## The record's own end

The constraint: `wrangler deploy` swaps the isolates but not the storage, so whatever the registry holds at the swap it holds after; and the process that asked for the drain — a GitHub Actions job — can die at any line, the `finally` included (a cancelled job, a runner lost). A flag would then close the fleet until a person noticed that every run's card said `attaching the workspace…` forever.

The design: the drain is never a flag. `parseDrainRequest` refuses a request without a finite `minutes` in [1, 90] and writes `until`; `liveDrain(stored, now)` reads a record whose `until` has passed as no drain, and so does every route, so an expired record needs no sweeper and no clock in the registry. The runner still posts `/undrain` in a `finally` because a deploy that is over should not cost a waiting run the five-minute margin — and it posts it whenever a `/drain` was asked for, not only when the answer said the record landed: an answer lost after the registry's write would otherwise close the fleet for the record's whole life. `/undrain` is idempotent. The cap of 90 minutes is the longest a forgotten drain can cost anyone.

Invariants: no attach is ever refused by a record whose `until` is in the past; a record this build cannot read is no drain; a second `/drain` replaces the first (two deploys overlapping extend, never stack). Failure modes: the runner dies after `/drain` — the fleet reopens at `until`, at most 65 minutes after the drain began, and every waiting run either is admitted then or has already ended `refused` naming that time; the clocks of the Worker and the runner disagree — `until` is written by the Worker's clock and read by the Worker's clock, the runner only reads it back for its lines. The alternative rejected: a flag cleared by the new isolate on its first request. It would reopen the fleet the instant the swap landed, which is right only when the deploy succeeded; a refused or failed deploy would leave the flag standing, and the failing case is the one that needs the safety.

## A run asked during the drain

The constraint: the bot has no queue for a thread — a run is provisioned on its request, and the attach is the first thing the resident does for it. The deployer is outside the bot and cannot hold the thread for it. The wake wait (item 65) exists for a container that is coming back within seconds, on a three-minute budget; a drain lasts as long as the longest run in flight.

The design: the `draining` answer is waited for under its own budget: the run's remaining lease (`opts.remainingMs()`, never negative, clipped to zero) less a ten-minute reserve — the attach itself may clone and install, and a run that would start with less has nothing to start for — and sixty minutes with no lease (the CLI, staging). One re-attach every thirty seconds; the run's stop ends the pause and the request alike. An answer that is no longer the drain is judged exactly as a first answer would be. Admitted, the run starts. The platform's transient, the wake wait takes over with what the budget left. Anything else, the attach's own refusal, at once. The wait rides the binding as `wokeAfterMs` — the same field a wake wait uses, so a drain followed by a wake on the same attach is one total — and the factory's existing note names it without a new field. When a drain answer is met inside a wake wait's own re-attach, the wake wait keeps waiting rather than ending.

Invariants: a waiting run never starts on the old generation — its attach is refused until the registry says the drain is over, and the drain is over only after the runner lifted it or its end passed; the wait never exceeds the run's lease less the reserve; the stop wins within one poll. Failure modes: the lease cannot hold the wait — the typed `ResidentDrainingError` (`refused`) names the wait and the drain's end, and the run ends refused (the open question below). The alternative rejected: the bot reads `/residents` before provisioning and holds the request itself. It would let the card say why at once, but it puts the drain's semantics in every caller instead of at the one door, and the CLI, the load harness and a second bot generation mid-roll would each need the same code.

## The numbers

`DRAIN.deployWaitMaxMs` is 60 minutes: the longest lease any resident run can hold is a coding child's 45-minute ask — the write-up reserve is inside it, not added, and a ship child is a coding run whose lease the ship parent carves from its own remainder and never renews past it (record 0046), so no run in flight outlives the drain's start by more than 45 minutes — plus fifteen minutes of slack for the preflight's one-minute poll, the swap itself and a run that ended late. The drain itself is that wait plus a five-minute margin (`marginMinutes`), so the fleet stays closed through the deploy and reopens by itself soon after if the runner died; the resident's `wrangler deploy` has not been timed under a drain, and the first drained release measures it against the margin. The registry caps a drain at 90 minutes (`maxMinutes`) so a forgotten one is an hour and a half, not a day. The client polls every 30 seconds (`pollMs`) — six times the wake poll — because the thing it waits for is minutes long and each poll is a request the resident answers before any work. The arrival rate the wait is sized against is the evening's: two to four runs in flight at every look and a new attach every ten to twenty minutes on the busiest resident, so a 25-minute drain meets one to three new runs; a coding ask (45 min, 35 of wait) rides it out, and a review ask (25 min, 15 of wait) ends refused whenever the drain runs past a quarter of an hour — the count to watch in run history. Undrained, the step keeps its 30 minutes: waiting longer for a quiet minute buys nothing, which the third attempt of the first release showed at 90 minutes of retry budget. Every one of these numbers lives in `src/core/budgets.ts` `DRAIN`, the one clock table (record 0046).

## Why not

- **Wait longer than a lease** (the sibling issue's first shape). The third attempt of the first release waited while three to four runs were in flight the whole time and new children started as old ones ended; a wait for silence has no length that wins under steady traffic.
- **Roll one Durable Object at a time.** A Worker deploy is atomic across every isolate.
- **Deploy off-hours.** Releases are cut by merges all day, several a day; a person timing them to a lull is the manual step this record removes.
- **Make the swap safe and resume the runs.** The run ledger's handoff is a recovery a harness can refuse — the deploy-holds change exists because a release lost two children to exactly that — not a guarantee a deploy may lean on.
- **Drain from the bot.** The bot is one caller of the fleet, and the deploy runs outside every bot; the registry is the one place every attach already passes.
- **Queue the request in the bot.** There is no queue for a thread today; building one for this case alone is a larger design than the wait, and the wait already keeps the thread's order.
- **Give CI the admin bearer.** It would save minting one token, and hand a leaked CI secret the power to offboard and rebuild residents; the drain scope passes two routes and nothing else, so a leaked one can close a fleet — for 90 minutes per post, and for as long as its holder keeps posting until the token is rotated — and can never offboard, rebuild or read one.

## What would change our mind

If drained waits still reach 60 minutes often, the lease arithmetic is wrong for the runs that actually land (measure: the `waited Nm of 60m` heartbeats in deploy logs across ten releases). If runs ending `refused` with `ResidentDrainingError` are common, the dispatcher needs the re-issue below before the drain is worth its cost (measure: count that error class in run history over a week). Both are reversible: without the secret the step behaves exactly as before, and the record expires by itself.

## Rollout

Two human steps, both secrets: mint a drain bearer and put it on the resident Worker as `RESIDENT_DRAIN_TOKEN` (the secrets manifest lists it; optional, so a Worker without it simply has no drain scope), and give the deploy workflow the same value as its optional `RESIDENT_DRAIN_TOKEN` secret. Until then every release logs `RESIDENT_DRAIN_TOKEN is not set — waiting without a drain` and behaves as today. `--force` still deploys over live runs with its warning and neither drains nor waits; the CLI's `deploy all` on a laptop drains too when the bearer is in its environment. The first release after the secrets is the receipt: the resident lines of its deploy job and the resident's `/healthz` at the end.

## Open questions

- **A card line while the run waits** — today the card shows `attaching the workspace…` for the whole wait and names it only once the run starts. Owner: the next unit on the resident client; resolves when the factory can note a wait in progress.
- **A run whose lease cannot hold the wait** — it ends `refused` naming the drain's end. Whether the dispatcher re-issues the request when the fleet reopens (as it does after an interruption) is a decision for the dispatch specs. Owner: the maintainer; resolves with the first live occurrence.

## Validation criteria

Bound to their proofs in the living specs: resident-repos item 69's rows (the record, the refusal, the wiring with the gate's exemption and the drain scope, the client's wait) and release-and-deploy item 31's rows (the runner's drain, the plan and the workflow, the live receipt).
