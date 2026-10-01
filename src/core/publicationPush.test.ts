import { describe, expect, it } from "vitest";
import {
  leasedPushCommand,
  mentionsGitPush,
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
  it("pairs a runner-owned effect only with its trusted admission, result and Git Door output", () => {
    const events: RunEvent[] = [
      { type: "tool_call", tool: "publish_branch", callId: "effect", summary: "publish branch" },
      { type: "publication_push_authorized", callId: "effect", ref, expectedHeadSha: old },
      {
        type: "tool_result",
        tool: "publish_branch",
        callId: "effect",
        ok: true,
        summary: "published",
        output: `To https://door.example/git/acme/api.git\n + aaaaaaaa...bbbbbbbb ${ref} -> ${ref} (forced update)`,
      },
    ];
    expect(pairedPublicationPush(events, binding, head, "effect", "https://door.example")).toMatchObject({
      sha: head,
      receipt: { callId: "effect", previousHeadSha: old },
    });
    expect(
      pairedPublicationPush([events[0]!, events[2]!], binding, head, "effect", "https://door.example"),
    ).toBeUndefined();
    const result = events[2] as Extract<RunEvent, { type: "tool_result" }>;
    expect(
      pairedPublicationPush(
        [events[0]!, events[1]!, { ...result, ok: false }],
        binding,
        head,
        "effect",
        "https://door.example",
      ),
    ).toBeUndefined();
  });
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

  it("records a leased Git door push with a bounded Git config option and Git's remote tracking line", () => {
    const events = pair();
    const call = events[0] as Extract<RunEvent, { type: "tool_call" }>;
    const result = events[1] as Extract<RunEvent, { type: "tool_result" }>;
    call.command = `git -c http.postBuffer=52428800 push --force-with-lease=refs/heads/${ref}:${old} -u origin ${ref}:refs/heads/${ref}`;
    result.output = `To https://door.example/git/acme/api.git\n + aaaaaaaa...bbbbbbbb ${ref} -> ${ref} (forced update)\nBranch '${ref}' set up to track remote branch '${ref}' from 'origin'.`;
    expect(leasedPushCommand(call.command)).toEqual({ ref, expectedHeadSha: old });
    expect(pairedPublicationPush(events, binding, head, "push", "https://door.example")).toMatchObject({
      type: "pushed_head",
      sha: head,
      receipt: { previousHeadSha: old, repo: binding.repo },
    });
    expect(pairedPublicationPush(events, binding, head, undefined, "https://door.example")?.sha).toBe(head);
    expect(pairedPublicationPush(events, binding, head, "push", "https://other.example")).toBeUndefined();
    expect(mentionsGitPush(call.command)).toBe(true);
    events.push({ ...call, callId: "competing" });
    expect(pairedPublicationPush(events, binding, head, undefined, "https://door.example")).toBeUndefined();
    events.pop();
    call.command = call.command.replace("52428800", "${SHELL_VALUE}");
    expect(leasedPushCommand(call.command)).toBeUndefined();
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
