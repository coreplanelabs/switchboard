import { describe, expect, it } from "vitest";
import {
  leasedPushCommand,
  pairedPublicationPush,
  restoredPublicationHead,
  publicationReceiptsFromState,
} from "./publicationPush.js";
import type { RunEvent } from "./runEvents.js";
import { pushedHeadsOf } from "./runRecord.js";

const ref = "fix/owned";
const old = "a".repeat(40);
const head = "b".repeat(40);
const binding = {
  repo: "acme/api",
  pr: 7,
  headRef: ref,
  baseRef: "main",
  publicationRef: ref,
  expectedHeadSha: old,
  owner: { instanceId: "plan-test", unit: "U12" },
};
const command = `git push --force-with-lease=refs/heads/${ref}:${old} origin ${ref}:refs/heads/${ref}`;
const pair = (): RunEvent[] => [
  { type: "tool_call", tool: "bash", callId: "push", command, summary: "push" },
  {
    type: "tool_result",
    tool: "bash",
    callId: "push",
    ok: true,
    exitCode: 0,
    output: `To https://github.com/acme/api\n + aaaaaaaa...bbbbbbbb ${ref} -> ${ref} (forced update)`,
    summary: "pushed",
  },
];

describe("leased publication push evidence", () => {
  it("pairs a complete exact leased push result with a full new head, never prose", () => {
    expect(leasedPushCommand(command)).toEqual({ ref, expectedHeadSha: old });
    expect(pairedPublicationPush(pair(), binding, head)).toMatchObject({
      type: "pushed_head",
      ref,
      sha: head,
      by: "push",
      receipt: { callId: "push", previousHeadSha: old, repo: binding.repo, pr: binding.pr, owner: binding.owner },
    });
    expect(pairedPublicationPush([{ type: "assistant", text: `I pushed ${head}` }], binding, head)).toBeUndefined();
  });

  it("accepts Git's exact upstream tracking line and stderr redirect without admitting arbitrary output", () => {
    const events = pair();
    const call = events[0] as Extract<RunEvent, { type: "tool_call" }>;
    const result = events[1] as Extract<RunEvent, { type: "tool_result" }>;
    call.command = `${command.replace("git push", "git push -u")} 2>&1`;
    result.output += `\nbranch '${ref}' set up to track 'origin/${ref}'.`;
    expect(pairedPublicationPush(events, binding, head)?.sha).toBe(head);
    result.output += "\ndone";
    expect(pairedPublicationPush(events, binding, head)).toBeUndefined();
  });

  it.each([
    "missing call",
    "missing result",
    "duplicate call",
    "duplicate result",
    "reversed pair",
    "failed",
    "cut",
    "unknown exit",
    "truncated command",
    "truncated output",
    "wrong remote",
    "wrong old",
    "wrong new",
    "wrong destination",
    "foreign result call",
    "second push",
    "output substitution",
    "chained command",
  ])("refuses %s", (scenario) => {
    const events = pair();
    const call = events[0] as Extract<RunEvent, { type: "tool_call" }>;
    const result = events[1] as Extract<RunEvent, { type: "tool_result" }>;
    if (scenario === "missing call") events.shift();
    if (scenario === "missing result") events.pop();
    if (scenario === "duplicate call") events.unshift(call);
    if (scenario === "duplicate result") events.push(result);
    if (scenario === "reversed pair") events.reverse();
    if (scenario === "failed") result.ok = false;
    if (scenario === "cut") result.cut = true;
    if (scenario === "unknown exit") delete result.exitCode;
    if (scenario === "truncated command") call.command += "…";
    if (scenario === "truncated output") result.output += "…[20 more chars]";
    if (scenario === "wrong remote") result.output = result.output!.replace("acme/api", "other/api");
    if (scenario === "wrong old") result.output = result.output!.replace("aaaaaaaa", "cccccccc");
    if (scenario === "wrong new") result.output = result.output!.replace("bbbbbbbb", "cccccccc");
    if (scenario === "wrong destination") call.command += " other:other";
    if (scenario === "foreign result call") result.callId = "other";
    if (scenario === "second push") events.push(...pair().map((e) => ({ ...e, callId: "other" })));
    if (scenario === "output substitution") call.command = `echo '${result.output}'`;
    if (scenario === "chained command") call.command += "; echo done";
    expect(pairedPublicationPush(events, binding, head)).toBeUndefined();
  });

  it("keeps typed receipts as validated restart state and restores only a contiguous owned chain", () => {
    const receipt = pairedPublicationPush(pair(), binding, head)!;
    const restarted = publicationReceiptsFromState(JSON.parse(JSON.stringify([receipt])));
    expect(publicationReceiptsFromState([receipt, { type: "pushed_head" }])).toEqual([]);
    expect(pushedHeadsOf(restarted)).toEqual([{ ref, sha: head, by: "push" }]);
    expect(restoredPublicationHead(restarted, binding)).toBe(head);
    expect(restoredPublicationHead(restarted, { ...binding, expectedHeadSha: "c".repeat(40) })).toBeUndefined();
    expect(
      restoredPublicationHead(restarted, { ...binding, owner: { ...binding.owner, unit: "U13" } }),
    ).toBeUndefined();
  });
});
