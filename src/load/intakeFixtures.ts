// The synthetic intake set (docs/reference/specs/load-harness.md item 20):
// the checked-in half of the intake replay. The labelled file people build
// lives OUTSIDE the repository under `load-results/` — real people's words are
// forbidden in the tree by public hygiene — so this set is synthetic under the
// fixture conventions (users U_ALICE/U_BOB/U_BOT, channel C_BACKEND, Slack
// numeric timestamps, repositories acme/…) and exists to run the scoring in
// CI over a scripted model (`src/load/intakeReplay.test.ts`), covering the
// pending-confirmation stratum and the fail-closed paths the labelled file
// may not.
import type { IntakeFacts, IntakeTurn } from "../core/intake.js";

/** One labelled reply of the replay's file — one JSON object per line in the
 *  labelled file, this array checked in: the reply, the thread's newest turns
 *  (oldest first), the facts computed by code, the ground-truth label, and the
 *  stratum the row samples (`plain`, `pending-confirmation`, `bot-thread`,
 *  `fail-closed`, …). */
export interface IntakeFixture {
  id: string;
  stratum: string;
  /** The ground truth: whether the reply addressed the bot. */
  label: "addressed" | "silent";
  /** The reply to judge. */
  message: string;
  turns: readonly IntakeTurn[];
  facts: IntakeFacts;
  threadKey: string;
}

const FACTS: IntakeFacts = {
  replierIsRequester: false,
  mentionsOther: false,
  threadStartedByBot: false,
};

const fixture = (
  id: string,
  stratum: string,
  label: IntakeFixture["label"],
  message: string,
  turns: readonly IntakeTurn[],
  facts: Partial<IntakeFacts> = {},
  threadKey = "slack:C_BACKEND:1000.000100",
): IntakeFixture => ({ id, stratum, label, message, turns, facts: { ...FACTS, ...facts }, threadKey });

/** The checked-in set: enough of each stratum to exercise the arithmetic —
 *  never a benchmark. The rates a change is judged by come from the labelled
 *  file and the live ratio, not from here. */
export const INTAKE_FIXTURES: readonly IntakeFixture[] = [
  fixture(
    "i01",
    "plain",
    "addressed",
    "actually, run it against acme/api too",
    [
      { role: "requester", text: "run the failing suite on acme/web" },
      { role: "bot", text: "done — 3 failures, all in the parser" },
    ],
    { replierIsRequester: true, botLastSpokeSeconds: 40 },
  ),
  fixture(
    "i02",
    "plain",
    "addressed",
    "can you paste the last stack trace here?",
    [
      { role: "person", text: "the deploy is red again" },
      { role: "bot", text: "the deploy failed at the migration step" },
    ],
    { botLastSpokeSeconds: 90 },
    "slack:C_BACKEND:1000.000200",
  ),
  fixture(
    "i03",
    "plain",
    "silent",
    "thanks, I'll take it from here and file the ticket myself",
    [
      { role: "requester", text: "what broke in last night's run?" },
      { role: "bot", text: "one test failed on acme/api" },
      { role: "person", text: "I can look after lunch" },
    ],
    { mentionsOther: true },
    "slack:C_BACKEND:1000.000300",
  ),
  fixture(
    "i04",
    "plain",
    "silent",
    "lunch first? the burrito place reopened",
    [
      { role: "person", text: "standup in five" },
      { role: "person", text: "brt" },
    ],
    {},
    "slack:C_BACKEND:1000.000400",
  ),
  fixture(
    "i05",
    "pending-confirmation",
    "addressed",
    "yes, go ahead",
    [
      { role: "requester", text: "onboard acme/api" },
      { role: "bot", text: "this would onboard acme/api — confirm?" },
    ],
    { replierIsRequester: true, botLastSpokeSeconds: 15, pendingConfirmation: "U_ALICE" },
    "slack:C_BACKEND:1000.000500",
  ),
  fixture(
    "i06",
    "pending-confirmation",
    "silent",
    "hold on, let me check with the platform folks first",
    [
      { role: "requester", text: "onboard acme/web" },
      { role: "bot", text: "this would onboard acme/web — confirm?" },
      { role: "person", text: "do we have a slot free?" },
    ],
    { pendingConfirmation: "U_ALICE", mentionsOther: true },
    "slack:C_BACKEND:1000.000600",
  ),
  fixture(
    "i07",
    "bot-thread",
    "addressed",
    "why did the second suite take twice as long?",
    [
      { role: "bot", text: "nightly report: both suites green" },
      { role: "person", text: "nice" },
    ],
    { threadStartedByBot: true, botLastSpokeSeconds: 600 },
    "slack:C_BACKEND:1000.000700",
  ),
  fixture(
    "i08",
    "bot-thread",
    "silent",
    "we should move this report to the ops channel",
    [{ role: "bot", text: "nightly report: one flaky test on acme/api" }],
    { threadStartedByBot: true, mentionsOther: true },
    "slack:C_BACKEND:1000.000800",
  ),
  fixture(
    "i09",
    "fail-closed",
    "addressed",
    "and rerun the one that timed out",
    [
      { role: "requester", text: "rerun the suite" },
      { role: "bot", text: "rerunning" },
    ],
    { replierIsRequester: true, botLastSpokeSeconds: 20, liveRun: { agent: "coding", secondsInFlight: 30 } },
    "slack:C_BACKEND:1000.000900",
  ),
  fixture(
    "i10",
    "fail-closed",
    "silent",
    "someone else already restarted it, ignore the noise",
    [
      { role: "person", text: "the worker restarted" },
      { role: "bot", text: "reconnected" },
    ],
    { mentionsOther: true },
    "slack:C_BACKEND:1000.001000",
  ),
];
