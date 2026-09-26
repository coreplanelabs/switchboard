import { describe, expect, it } from "vitest";
import { inspectReceivePackPrefix, authorizePushRefs } from "./gitPushPolicy.js";

const zero = "0".repeat(40);
const old = "1".repeat(40);
const next = "2".repeat(40);

function packet(line: string): Buffer {
  const bytes = Buffer.from(line);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

function push(...commands: string[]): Buffer {
  return Buffer.concat([
    ...commands.map((command, index) => packet(`${command}${index === 0 ? "\0report-status side-band-64k" : ""}`)),
    Buffer.from("0000PACK"),
  ]);
}

describe("receive-pack command boundary", () => {
  it("reads only the pkt-line command prefix and leaves pack bytes untouched", () => {
    const body = push(`${old} ${next} refs/heads/fix`);
    const result = inspectReceivePackPrefix(body);
    expect(result).toEqual({
      kind: "commands",
      commands: [{ old, next, ref: "refs/heads/fix" }],
      capabilities: ["report-status", "side-band-64k"],
      prefixBytes: body.length - 4,
    });
  });

  it("refuses malformed or oversized command sections before forwarding a pack", () => {
    expect(inspectReceivePackPrefix(Buffer.from("xxxx"))).toMatchObject({ kind: "refused" });
    expect(inspectReceivePackPrefix(Buffer.concat([packet("bad command"), Buffer.from("0000")]))).toMatchObject({
      kind: "refused",
    });
    expect(inspectReceivePackPrefix(Buffer.alloc(65_537, 0x41))).toMatchObject({ kind: "refused" });
    const first = packet(`${old} ${next} refs/heads/fix\0report-status push-options`);
    expect(inspectReceivePackPrefix(Buffer.concat([first, Buffer.from("0000PACK")]))).toMatchObject({
      kind: "refused",
    });
  });

  it("refuses default, foreign, deleted, and non-branch refs while allowing the bound PR head", () => {
    const policy = {
      identity: "write" as const,
      repo: "acme/api",
      boundRepo: "acme/api",
      defaultBranch: "main",
      boundRef: "fix-2250",
    };
    expect(authorizePushRefs(inspectReceivePackPrefix(push(`${old} ${next} refs/heads/fix-2250`)), policy)).toEqual({
      ok: true,
    });
    for (const command of [
      `${old} ${next} refs/heads/main`,
      `${old} ${next} refs/heads/other`,
      `${old} ${zero} refs/heads/fix-2250`,
      `${old} ${next} refs/tags/fix-2250`,
    ]) {
      expect(authorizePushRefs(inspectReceivePackPrefix(push(command)), policy)).toMatchObject({ ok: false });
    }
    expect(
      authorizePushRefs(inspectReceivePackPrefix(push(`${old} ${next} refs/heads/fix-2250`)), {
        ...policy,
        repo: "other/repo",
      }),
    ).toMatchObject({ ok: false });
    expect(
      authorizePushRefs(inspectReceivePackPrefix(push(`${old} ${next} refs/heads/fix-2250`)), {
        ...policy,
        identity: "read",
      }),
    ).toMatchObject({ ok: false });
  });

  it("allows a new non-default branch when a write run has no pinned ref", () => {
    const parsed = inspectReceivePackPrefix(push(`${zero} ${next} refs/heads/new-work`));
    expect(
      authorizePushRefs(parsed, {
        identity: "write",
        repo: "o/r",
        boundRepo: "o/r",
        defaultBranch: "main",
        firstBranch: true,
      }),
    ).toEqual({ ok: true });
    expect(
      authorizePushRefs(inspectReceivePackPrefix(push(`${old} ${next} refs/heads/new-work`)), {
        identity: "write",
        repo: "o/r",
        boundRepo: "o/r",
        defaultBranch: "main",
        firstBranch: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      authorizePushRefs(parsed, { identity: "write", repo: "o/r", boundRepo: "o/r", defaultBranch: "main" }),
    ).toMatchObject({ ok: false });
    const two = inspectReceivePackPrefix(
      push(`${zero} ${next} refs/heads/new-work`, `${zero} ${next} refs/heads/second`),
    );
    expect(
      authorizePushRefs(two, {
        identity: "write",
        repo: "o/r",
        boundRepo: "o/r",
        defaultBranch: "main",
        firstBranch: true,
      }),
    ).toMatchObject({ ok: false });
  });
});
