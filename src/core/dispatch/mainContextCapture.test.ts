import { describe, expect, it, vi } from "vitest";
import type { SessionCheckpointFailure } from "../runLedger/writeThrough.js";
import type { HandoffSource } from "./handoff.js";
import type { ContextDependencies } from "../references/contextDependencies.js";
import { capturePrivateWorkContext, MainContextCaptureError } from "./mainContextCapture.js";
import type { ParentContext } from "./handoff.js";

const source = {
  runId: "owned",
  requester: "private requester",
  channelId: "private channel",
  threadKey: "private thread",
};
const session = { key: "private session", from: 0, to: -1 };
const parent: ParentContext = { messages: [], handoff: { version: 1, source, session, assets: [] } };

function fixture() {
  const run = {
    tracked: vi.fn(() => true),
    lastCheckpointFailure: undefined as SessionCheckpointFailure | undefined,
    checkpointSession: vi.fn(async () => ({ key: session.key, through: -1 })),
  };
  const captureDependencies = vi.fn(async (_source: HandoffSource): Promise<ContextDependencies> => ({
    version: 1,
    status: "known",
    revision: 0,
    origins: [],
    slack: [],
    mcp: [],
  }));
  const captureHandoff = vi.fn(
    async (_source: typeof source, dependencies?: (source: HandoffSource) => Promise<ContextDependencies>) => {
      await dependencies?.(parent.handoff!);
      return parent;
    },
  );
  const validate = vi.fn(async () => "valid" as const);
  return { run, capability: { session, captureHandoff }, captureDependencies, validate };
}

describe("private work context capture — durable refusal categories", () => {
  it("classifies every capture branch without copying a private source or store error", async () => {
    const cases = [
      {
        label: "untracked",
        change: (f: ReturnType<typeof fixture>) => f.run.tracked.mockReturnValue(false),
        code: "precondition_untracked",
      },
      {
        label: "missing session",
        change: (f: ReturnType<typeof fixture>) => {
          f.capability.captureHandoff = undefined as never;
        },
        code: "precondition_capture_unavailable",
      },
      {
        label: "checkpoint key",
        change: (f: ReturnType<typeof fixture>) =>
          f.run.checkpointSession.mockResolvedValue({ key: "another session", through: -1 }),
        code: "checkpoint_mismatch",
      },
      {
        label: "snapshot",
        change: (f: ReturnType<typeof fixture>) =>
          f.capability.captureHandoff.mockRejectedValue(new Error("private snapshot detail")),
        code: "snapshot_failed",
      },
      {
        label: "dependencies",
        change: (f: ReturnType<typeof fixture>) =>
          f.captureDependencies.mockRejectedValue(new Error("private dependency detail")),
        code: "dependencies_failed",
      },
      {
        label: "validation",
        change: (f: ReturnType<typeof fixture>) => f.validate.mockResolvedValue("invalid" as never),
        code: "validation_failed",
      },
      {
        label: "validation throws",
        change: (f: ReturnType<typeof fixture>) => f.validate.mockRejectedValue(new Error("private validation detail")),
        code: "validation_failed",
      },
      {
        label: "invalid capsule",
        change: (f: ReturnType<typeof fixture>) => f.capability.captureHandoff.mockResolvedValue({ messages: [] }),
        code: "capsule_invalid",
      },
    ];
    for (const { label, change, code } of cases) {
      const f = fixture();
      change(f);
      const failure = await capturePrivateWorkContext({ ...f, source }).catch((error: unknown) => error);
      expect(failure, label).toBeInstanceOf(MainContextCaptureError);
      expect((failure as MainContextCaptureError).code, label).toBe(code);
      expect(JSON.stringify(failure), label).not.toMatch(/private|detail|session|requester|channel|thread/i);
    }
  });

  it("retries only typed transient checkpoint unavailability once on the same owned run", async () => {
    const f = fixture();
    f.run.lastCheckpointFailure = "state-unavailable";
    f.run.checkpointSession.mockResolvedValueOnce(undefined as never);
    expect(await capturePrivateWorkContext({ ...f, source })).toMatchObject({ version: 1 });
    expect(f.run.checkpointSession).toHaveBeenCalledTimes(2);
    expect(f.capability.captureHandoff).toHaveBeenCalledOnce();
    for (const reason of [
      "state-unavailable",
      "state-permanent",
      "state-fenced",
      "state-route-missing",
      "state-unknown",
      "detached",
      "finished",
      "unseeded",
      "session-missing",
      "session-broken",
      "cursor-missing",
      undefined,
    ] as const) {
      const failed = fixture();
      failed.run.lastCheckpointFailure = reason;
      failed.run.checkpointSession.mockResolvedValue(undefined as never);
      const error = await capturePrivateWorkContext({ ...failed, source }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(MainContextCaptureError);
      expect((error as MainContextCaptureError).code).toBe(reason ? `checkpoint_${reason}` : "checkpoint_unknown");
      expect(failed.run.checkpointSession).toHaveBeenCalledTimes(reason === "state-unavailable" ? 2 : 1);
      expect(failed.capability.captureHandoff).not.toHaveBeenCalled();
    }
  });
});
