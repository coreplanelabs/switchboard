import { describe, expect, it, vi } from "vitest";
import { runResidentRetire } from "./residentRetireCli.js";

const key = "native-operation:thread-a:run-a:attempt-a";
const recordHash = "a".repeat(64);
const scope = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  boot: "22222222-2222-4222-8222-222222222222",
  threadKey: "thread-a",
  owner: { runId: "run-a", ownerGen: "generation-a", ownerFence: 1 },
};
const operation = {
  key,
  recordHash,
  journal: { closed: true, scope },
  recoveryReason: "original-native-evidence-unavailable",
};
const permit = {
  version: 1,
  purpose: "terminal-native-scope",
  id: "33333333-3333-4333-8333-333333333333",
  target: { resource: "repo:acme/app", key, recordHash, scope },
  source: {
    id: "run-a",
    threadKey: "thread-a",
    repo: "acme/app",
    status: "stopped_hard",
    startedAt: 1,
    finishedAt: 2,
    sealedAt: 3,
  },
};
const argv = ["--url", "https://resident.example", "--resource", "repo:acme/app", "--key", key];
const page = (row: unknown = operation) => Response.json({ operations: [row], cursor: null });

describe("resident:retire operator command", () => {
  it("previews the exact saved run without an admin request", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => page());
    const lines: string[] = [];
    await runResidentRetire(argv, { fetcher, readToken: "reader", write: (line) => lines.push(line) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://resident.example/debug");
    expect(lines.join("\n")).toContain(`run-a ${key} ${recordHash}`);
  });

  it("retire one exact terminal scope and confirm its saved unknown outcome", async () => {
    const retired = {
      ...operation,
      recoveryReason: "original-runtime-retired",
      retirement: {
        purpose: "terminal-native-scope",
        state: "closed",
        originalOperationOutcome: "unknown",
        records: { [key]: recordHash },
        permit,
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(Response.json(retired.retirement))
      .mockResolvedValueOnce(page(retired));
    const lines: string[] = [];
    await runResidentRetire([...argv, "--record-hash", recordHash, "--apply"], {
      fetcher,
      readToken: "reader",
      controlToken: "admin",
      write: (line) => lines.push(line),
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      resource: "repo:acme/app",
      key,
      recordHash,
      scope,
    });
    expect(lines.join("\n")).toContain("closed; original result unknown");
  });

  it("refuses a changed hash before any control", async () => {
    const fetcher = vi.fn(async () => page());
    await expect(
      runResidentRetire([...argv, "--record-hash", "b".repeat(64), "--apply"], {
        fetcher,
        readToken: "reader",
        controlToken: "admin",
        write: () => {},
      }),
    ).rejects.toThrow("record hash changed");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads an exact run even when another saved record has no run scope", async () => {
    const other = {
      key: "native-operation:z-other",
      recordHash: "b".repeat(64),
      recoveryReason: "legacy-or-invalid-record",
      journal: null,
    };
    const fetcher = vi.fn(async () => Response.json({ operations: [operation, other], cursor: null }));
    const lines: string[] = [];
    await runResidentRetire(argv, { fetcher, readToken: "reader", write: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain(`run-a ${key} ${recordHash}`);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not claim closure when a second saved operation in the same scope remains open", async () => {
    const sibling = { ...operation, key: "native-operation:thread-a:run-a:attempt-b", recordHash: "b".repeat(64) };
    const first = Response.json({ operations: [operation, sibling], cursor: null });
    const selected = {
      ...operation,
      recoveryReason: "original-runtime-retired",
      retirement: {
        purpose: "terminal-native-scope",
        state: "closed",
        originalOperationOutcome: "unknown",
        records: { [key]: recordHash },
        permit,
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(Response.json(selected.retirement))
      .mockResolvedValueOnce(Response.json({ operations: [selected, sibling], cursor: null }));
    await expect(
      runResidentRetire([...argv, "--record-hash", recordHash, "--apply"], {
        fetcher,
        readToken: "reader",
        controlToken: "admin",
        write: () => {},
      }),
    ).rejects.toThrow("retirement result unverified");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a lost control request or claim closure without a receipt", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(page());
    const lines: string[] = [];
    await expect(
      runResidentRetire([...argv, "--record-hash", recordHash, "--apply"], {
        fetcher,
        readToken: "reader",
        controlToken: "admin",
        write: (line) => lines.push(line),
      }),
    ).rejects.toThrow("retirement result unverified");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(lines.join("\n")).toContain("control reply unavailable");
    expect(lines.join("\n")).not.toContain("lost reply");
  });
});
