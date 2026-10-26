import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { NATIVE_SCOPE_CONTROL_MS, NativeScopeControlTimeoutError } from "./nativeScope.js";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));
const errorClasses = source.slice(
  source.indexOf("class StepError extends Error"),
  source.indexOf("/** A preserved workspace"),
);
const sha = "a".repeat(40);
const lockfileHash = "b".repeat(64);
const snap = { ref: "main", sha, lockfileHash };

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

function residentForStampRead(options: {
  diskSha?: string;
  diskLock?: string;
  readError?: Error;
  shaResult?: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
}) {
  const events: string[] = [];
  const compiled = ts.transpileModule(
    `${errorClasses}\nclass Resident { ${method("restoreCheckout")} ${method("unreadableSnapshotStamp")} ${method("classifyCycleError")} ${method("refreshFailed")} }\n({ Resident, SnapshotStampUnreadableError })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const { Resident } = runInNewContext(compiled, {
    planRestore: () => ({ action: "restore" }),
    MIRROR_DIR: "/mirror",
    CHECKOUT_DIR: "/checkout",
    STAGING_CHECKOUT_DIR: "/staging",
    RETIRED_CHECKOUT_DIR: "/retired",
    DISK_MARKERS: [],
    BUILD_USER: "builder",
    INFRA_STREAK_KEY: "resident:infraStreak",
    console: { log: () => {} },
    systemClock: () => 0,
    isBackgroundOperationHeld: (error: unknown) =>
      error instanceof Error && error.name === "BackgroundOperationHeldError",
    describeStepFailure: (result: { stderr: string }) => result.stderr,
    errMsg: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  });
  const resident = new Resident();
  resident.ctx = { storage: { delete: async (key: string) => events.push(`delete:${key}`) } };
  resident.pendingRestores = new Set();
  resident.readyStamp = async () => null;
  resident.runOk = async (_argv: unknown, step: string) => {
    events.push(step);
  };
  resident.restoreExtracted = async (_backup: unknown, _dir: string, step: string) => {
    events.push(step);
  };
  resident.ensureGitSetup = async () => {
    events.push("git setup");
  };
  resident.run = async () => {
    events.push("read sha");
    return options.shaResult ?? { stdout: options.diskSha ?? sha, stderr: "", exitCode: 0, timedOut: false };
  };
  resident.lockfileKey = async () => {
    events.push("read lockfile hash");
    if (options.readError) throw options.readError;
    return options.diskLock ?? lockfileHash;
  };
  resident.recordRefreshError = async (reason: string) => {
    events.push(`record:${reason}`);
  };
  resident.setResidentState = async (state: string, reason: string) => {
    events.push(`state:${state}:${reason}`);
  };
  resident.goDown = async (reason: string) => {
    events.push(`goDown:${reason}`);
    return new Error(reason);
  };
  resident.automaticContainerLoss = async () => {
    throw new Error("unknown stamp read reached container recovery");
  };
  resident.noteInfraStreak = async () => {
    throw new Error("unknown stamp read counted toward VM recovery");
  };
  resident.recoverFromDiskFull = async () => {
    throw new Error("unknown stamp read recycled the VM");
  };
  return { resident, events };
}

describe("restored snapshot stamp verification", () => {
  it("keeps a timed-out lockfile read degraded and preserves the restored disk", async () => {
    const { resident, events } = residentForStampRead({
      readError: new NativeScopeControlTimeoutError("inspect", NATIVE_SCOPE_CONTROL_MS),
    });
    let failure: unknown;
    try {
      await resident.restoreCheckout(snap, 1000);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      step: "restore",
      message: expect.stringContaining("snapshot-stamp-unreadable: restored disk lockfileHash could not be verified"),
    });
    expect(events).toEqual([
      "clean-before-restore",
      "mirror restore",
      "checkout restore",
      "git setup",
      "read sha",
      "read lockfile hash",
      "record:snapshot-stamp-unreadable: restored disk lockfileHash could not be verified (native-scope outcome is unknown (mode=inspect, timeoutMs=2000))",
      "state:degraded:snapshot-stamp-unreadable: restored disk lockfileHash could not be verified (native-scope outcome is unknown (mode=inspect, timeoutMs=2000))",
    ]);
    const classified = await resident.classifyCycleError(failure);
    expect(classified).toMatchObject({
      reason: expect.stringContaining("snapshot-stamp-unreadable"),
      verificationUnknown: true,
    });
    await resident.refreshFailed(classified, 0);
    expect(events.slice(-3)).toEqual([
      "record:snapshot-stamp-unreadable: restored disk lockfileHash could not be verified (native-scope outcome is unknown (mode=inspect, timeoutMs=2000))",
      "delete:resident:infraStreak",
      "state:degraded:snapshot-stamp-unreadable: restored disk lockfileHash could not be verified (native-scope outcome is unknown (mode=inspect, timeoutMs=2000))",
    ]);
  });

  it("keeps an invalid hash result unknown rather than claiming a mismatch", async () => {
    const { resident, events } = residentForStampRead({ diskLock: "" });
    await expect(resident.restoreCheckout(snap, 1000)).rejects.toThrow("snapshot-stamp-unreadable");
    expect(events.some((event) => event.startsWith("state:degraded:snapshot-stamp-unreadable"))).toBe(true);
    expect(events.some((event) => event.startsWith("goDown:"))).toBe(false);
    expect(events).not.toContain("chown");
  });

  it("keeps an owned native operation held without a second recovery action", async () => {
    const held = new Error("native operation outcome unknown");
    held.name = "BackgroundOperationHeldError";
    const { resident, events } = residentForStampRead({ readError: held });
    await expect(resident.restoreCheckout(snap, 1000)).rejects.toBe(held);
    expect(events.at(-1)).toBe("read lockfile hash");
  });

  it("reports a proven commit mismatch before an uncertain lockfile read", async () => {
    const diskSha = "c".repeat(40);
    const { resident, events } = residentForStampRead({
      diskSha,
      readError: new NativeScopeControlTimeoutError("inspect", NATIVE_SCOPE_CONTROL_MS),
    });
    await expect(resident.restoreCheckout(snap, 1000)).rejects.toThrow(
      `snapshot-stamp-mismatch: restored disk {sha:${diskSha}} != stamp {sha:${sha}}`,
    );
    expect(events.at(-1)).toBe(`goDown:snapshot-stamp-mismatch: restored disk {sha:${diskSha}} != stamp {sha:${sha}}`);
    expect(events).not.toContain("read lockfile hash");
  });

  it("sends a successfully read unequal hash through the existing mismatch path", async () => {
    const { resident, events } = residentForStampRead({ diskLock: "c".repeat(64) });
    await expect(resident.restoreCheckout(snap, 1000)).rejects.toThrow("snapshot-stamp-mismatch");
    expect(events.at(-1)).toContain(
      `goDown:snapshot-stamp-mismatch: restored disk {sha:${sha}, lockfileHash:${"c".repeat(64)}}`,
    );
    expect(events.some((event) => event.startsWith("state:degraded"))).toBe(false);
  });
});
