import { expect, it } from "vitest";
import { growthProblems, ratchetProblems } from "../scripts/public-hygiene.mjs";
import { extractFile, scanMessages, surfaceFor, WORDING } from "../scripts/user-message-check.mjs";

// The user-message ratchet (routing-and-config item 33): a user-facing
// statement says what Switchboard did, is doing or will do. Imperative recovery
// language is reserved for typed confirmation offers and clarifying questions.

it("a fixture surface refuses an imperative but accepts a typed confirmation offer and question", () => {
  const source = [
    'const failure = "Re-send your request to run it again.";',
    "const confirmation: ConfirmationOffer = {",
    '  id: "c1", line: "Run `pulls merge acme/api#1` now", risk: "merges", expiresAt: 1,',
    "};",
    "const question: OperatorDecision = {",
    '  kind: "question", text: "Try again with acme/api?", reason: "repository missing",',
    "};",
  ].join("\n");

  expect(scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits).toEqual([
    { line: 1, phrase: "re-send", text: "Re-send your request to run it again." },
  ]);
});

it("requires the question discriminator instead of a question-named property", () => {
  const source = [
    'const untyped = { question: "Re-send the request." };',
    'const typed = { kind: "question", question: "Re-send the request?" };',
  ].join("\n");

  expect(scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits).toEqual([
    { line: 1, phrase: "re-send", text: "Re-send the request." },
  ]);
});

it("recognizes every prohibited recovery phrase", () => {
  const messages = [
    "Re-issue agent:ship.",
    "Re-send the request.",
    "Re-ask in the thread.",
    "Try again later.",
    "Type the line yourself.",
    "Rebase it by hand.",
    "Retry once CI registers.",
    "Run `pulls rebase acme/api#1`.",
    "Run the command again.",
    "run the command again.",
    "Run the formatter when CI is green.",
  ].map((text, line) => ({ line: line + 1, text, shape: "statement" as const }));

  expect(scanMessages(messages).hits.map((hit) => hit.phrase)).toEqual([
    "re-issue",
    "re-send",
    "re-ask",
    "try again",
    "type the line",
    "by hand",
    "retry once",
    "run",
    "run",
    "run",
    "run",
  ]);
});

it("recognizes every verb that delegates recovery by hand, including the spawn identity refusal", () => {
  const spawnIdentityRefusal =
    "`coding` runs as a `write` identity — it pushes branches and opens pull requests — and a spawned child never writes: it reads this conversation and reports; the person who asked starts that work by hand with `agent:coding`";
  const source = [
    'const start = "Start that work by hand.";',
    'const starts = "The person who asked starts that work by hand.";',
    'const run = "Run the recovery by hand.";',
    'const rebase = "Rebase the branch by hand.";',
    'const type = "Type the command by hand.";',
    'const reissue = "Re-issue the request by hand.";',
    'const general = "Restore the workspace by hand.";',
    `const refusal = ${JSON.stringify(spawnIdentityRefusal)};`,
  ].join("\n");

  const byHandHits = scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits.filter(
    (hit) => hit.phrase === "by hand",
  );
  expect(byHandHits).toEqual([
    { line: 1, phrase: "by hand", text: "Start that work by hand." },
    { line: 2, phrase: "by hand", text: "The person who asked starts that work by hand." },
    { line: 3, phrase: "by hand", text: "Run the recovery by hand." },
    { line: 4, phrase: "by hand", text: "Rebase the branch by hand." },
    { line: 5, phrase: "by hand", text: "Type the command by hand." },
    { line: 6, phrase: "by hand", text: "Re-issue the request by hand." },
    { line: 7, phrase: "by hand", text: "Restore the workspace by hand." },
    { line: 8, phrase: "by hand", text: spawnIdentityRefusal },
  ]);
});

it("recognizes boundary and retry recovery imperatives in TypeScript surfaces", () => {
  const source = [
    "const userBoundary = `Raise your own boundary with ${command}`;",
    'const overrides = "Drop your overrides with config clear me.";',
    "const installation = `Ask ${adminsHint} to raise defaults.boundary`;",
    'const directive = "Send the message again without the budget directive.";',
    'const parent = "Spawn it from a run with more time left.";',
    'const resident = "Re-run the command.";',
  ].join("\n");

  expect(scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits).toEqual([
    { line: 1, phrase: "raise boundary", text: "Raise your own boundary with ${}" },
    { line: 2, phrase: "drop overrides", text: "Drop your overrides with config clear me." },
    { line: 3, phrase: "ask to raise", text: "Ask ${} to raise defaults.boundary" },
    { line: 4, phrase: "send again", text: "Send the message again without the budget directive." },
    { line: 5, phrase: "spawn it", text: "Spawn it from a run with more time left." },
    { line: 6, phrase: "re-run", text: "Re-run the command." },
  ]);
});

it("recognizes an imperative run whose object is interpolated", () => {
  const source = "const answer = `Run ${command}`;";
  expect(scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits).toEqual([
    { line: 1, phrase: "run", text: "Run ${}" },
  ]);
});

it("composes rendered string fragments before matching recovery imperatives", () => {
  const source = [
    'const concatenated = "Re-" + "send the request.";',
    "const interpolated = `Re-${separator}send the request.`;",
    'const joined = ["Re-", "send the request."].join("");',
  ].join("\n");

  expect(scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits).toEqual([
    { line: 1, phrase: "re-send", text: "Re-send the request." },
    { line: 2, phrase: "re-send", text: "Re-send the request." },
    { line: 3, phrase: "re-send", text: "Re-send the request." },
  ]);
});

it("does not flag fragments whose rendered string is not a recovery imperative", () => {
  const source = [
    'const status = ["Recovery was ", "not started."].join("");',
    "const activity = `${count} run${count === 1 ? '' : 's'} in flight`;",
  ].join("\n");

  expect(scanMessages(extractFile("src/core/dispatch/fixture.ts", source)).hits).toEqual([]);
});

it("scans static and bound web element attributes", () => {
  const source = [
    "<template>",
    '  <button aria-label="Re-send the request" />',
    '  <div title="Try again later" />',
    '  <input placeholder="Run the command again" />',
    '  <button :aria-label="`Type the line ${command}`" />',
    "</template>",
  ].join("\n");

  expect(scanMessages(extractFile("web/src/pages/FixturePage.vue", source)).hits).toEqual([
    { line: 2, phrase: "re-send", text: "Re-send the request" },
    { line: 3, phrase: "try again", text: "Try again later" },
    { line: 4, phrase: "run", text: "Run the command again" },
    { line: 5, phrase: "type the line", text: "Type the line ${}" },
  ]);
});

it("scans user-facing strings in web TypeScript models", () => {
  const source = ['const emptyState = "Re-ask in the thread.";', "const retry = `Run ${command}`;"].join("\n");

  expect(scanMessages(extractFile("web/src/lib/runPageModel.ts", source)).hits).toEqual([
    { line: 1, phrase: "re-ask", text: "Re-ask in the thread." },
    { line: 2, phrase: "run", text: "Run ${}" },
  ]);
});

it("scans an imperative in the CLI chat adapter", () => {
  const source = 'export const chatErrorLine = () => "Re-send the command.";';

  expect(scanMessages(extractFile("src/core/commandChat.ts", source)).hits).toEqual([
    { line: 1, phrase: "re-send", text: "Re-send the command." },
  ]);
});

it("covers direct chat, card, ending and run-page sources but not tests or internal modules", () => {
  expect(surfaceFor("src/cli.ts")).toBe("typescript");
  expect(surfaceFor("src/core/commandChat.ts")).toBe("typescript");
  expect(surfaceFor("src/core/commandRegistry.ts")).toBe("typescript");
  expect(surfaceFor("src/core/commandSurface.ts")).toBe("typescript");
  expect(surfaceFor("src/core/dispatch/reply.ts")).toBe("typescript");
  expect(surfaceFor("src/core/ship/coordinator.ts")).toBe("typescript");
  expect(surfaceFor("src/core/commands/runs.ts")).toBe("typescript");
  expect(surfaceFor("src/core/coordinator/driver.ts")).toBe("typescript");
  expect(surfaceFor("src/core/boot.ts")).toBe("typescript");
  expect(surfaceFor("src/core/runsService.ts")).toBe("typescript");
  expect(surfaceFor("src/channels/slackCatchUp.ts")).toBe("typescript");
  expect(surfaceFor("src/core/dispatch/reply.test.ts")).toBeNull();
  expect(surfaceFor("src/core/budgets.ts")).toBeNull();
  expect(surfaceFor("web/src/pages/RunPage.vue")).toBe("web");
  expect(surfaceFor("web/src/lib/runPageModel.ts")).toBe("web");
  expect(surfaceFor("web/src/lib/runPageModel.test.ts")).toBeNull();
});

it("growth is refused and shrinkage requires the baseline to be regenerated", () => {
  const listed = { "src/core/boot.ts": { "re-send": 1 } };
  expect(ratchetProblems(listed, listed, WORDING)).toEqual([]);
  expect(growthProblems({ "src/core/boot.ts": { "re-send": 2 } }, listed, WORDING)).toEqual([
    "src/core/boot.ts: re-send 1 → 2 — a recovery imperative reached a user surface; say what the system did, is doing or will do",
  ]);
  expect(ratchetProblems({}, listed, WORDING)).toEqual([
    "src/core/boot.ts: re-send 1 → 0 — the baseline only shrinks: run `npm run user-message:check -- --write` to record the retirement",
  ]);
});
