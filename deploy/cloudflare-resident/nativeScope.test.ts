import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { methodOf, readSource } from "./testing/sourceScan.js";
import { describe, expect, it, vi } from "vitest";
import {
  NativeRunScopes,
  CloudflareNativeScopeTransport,
  type NativeScopeRef,
  type NativeScopeTransport,
} from "./nativeScope.js";
import type { NativeOperationStorage } from "./nativeOperation.js";

const BOOT = "4b15c6de-2eb6-4ef1-9b6c-e36ebf389807";
const owner = { runId: "run-a", ownerGen: "gen-a", ownerFence: 1 };
function fixture(request?: NativeScopeTransport["request"]) {
  const rows = new Map<string, unknown>();
  const storage: NativeOperationStorage = {
    get: async <T>(key: string) => structuredClone(rows.get(key)) as T | undefined,
    put: async (key, value) => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key) => rows.delete(key),
    list: async <T>({ prefix, limit, startAfter = "" }) =>
      new Map(
        [...rows]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      ) as Map<string, T>,
    transaction: async (action) => action(storage),
  };
  const calls: Record<string, unknown>[] = [];
  const native: NativeScopeTransport = {
    request: async (value, timeout) => {
      calls.push(structuredClone(value));
      if (request) return request(value, timeout);
      const data =
        value.mode === "inspect"
          ? { version: 1, boot: BOOT }
          : {
              ref: value.ref,
              closed: value.mode === "close" || value.mode === "view",
              ...(value.mode === "bootstrap" ? {} : { populated: false }),
            };
      return { stdout: JSON.stringify(data), stderr: "", exitCode: 0, timedOut: false };
    },
  };
  return { rows, calls, scopes: new NativeRunScopes(storage, native) };
}
const scopeRows = (h: ReturnType<typeof fixture>) =>
  [...h.rows].filter(([key]) => key.startsWith("native-scope:")).map(([, value]) => value);
const ensure = async (
  h: ReturnType<typeof fixture>,
  thread: string,
  selected: typeof owner,
  allowed: () => Promise<void>,
) => {
  await h.scopes.birth(thread, selected, true, async () => {});
  return h.scopes.ensure(thread, selected, allowed);
};
const allowed = async () => {};
const output = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0, timedOut: false });

describe("native run scope reservations", () => {
  it("reserves one original identity before bootstrap and reuses the ready scope", async () => {
    const h = fixture();
    const first = await ensure(h, "thread-a", owner, allowed);
    expect(first).toMatchObject({ version: 1, boot: BOOT, threadKey: "thread-a", owner });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ensure(h, "thread-a", owner, allowed)).toEqual(first);
    expect(scopeRows(h)).toEqual([
      { id: first.id, boot: BOOT, threadKey: "thread-a", owner, closing: false, closed: false, bootstrap: "ready" },
    ]);
    expect(h.calls.map((call) => call.mode)).toEqual(["inspect", "bootstrap"]);
  });

  it("observes a lost bootstrap reply without sending creation again", async () => {
    let ref: unknown;
    const h = fixture(async (value) => {
      if (value.mode === "inspect") return output({ version: 1, boot: BOOT });
      if (value.mode === "bootstrap") {
        ref = value.ref;
        throw new Error("reply lost");
      }
      return output({ ref: value.ref, closed: false, populated: false, present: true, ready: true });
    });
    await expect(ensure(h, "thread-a", owner, allowed)).rejects.toThrow("reply lost");
    expect(await ensure(h, "thread-a", owner, allowed)).toEqual(ref);
    expect(h.calls.map((call) => call.mode)).toEqual(["inspect", "bootstrap", "view"]);
  });

  it("closes a pre-bootstrap reservation while its kernel observation is pending", async () => {
    let release!: (value: ReturnType<typeof output>) => void;
    const wait = new Promise<ReturnType<typeof output>>((resolve) => {
      release = resolve;
    });
    const h = fixture(async () => wait);
    const creating = ensure(h, "thread-a", owner, allowed);
    for (let n = 0; n < 80 && h.calls.length === 0; n++) await Promise.resolve();
    expect(await h.scopes.close("thread-a", owner)).toEqual("unstarted");
    release(output({ version: 1, boot: BOOT }));
    await expect(creating).rejects.toThrow("run cancelled");
    expect(scopeRows(h)).toMatchObject([{ closing: true, closed: true, boot: null }]);
    expect(h.calls.map((call) => call.mode)).toEqual(["inspect"]);
  });

  it("keeps a neighbour open when closing the selected run", async () => {
    const h = fixture();
    const a = await ensure(h, "thread-a", owner, allowed);
    const other = { runId: "run-b", ownerGen: "gen-b", ownerFence: 2 };
    const b = await ensure(h, "thread-b", other, allowed);
    expect(await h.scopes.close("thread-a", owner)).toEqual(a);
    expect(await ensure(h, "thread-b", other, allowed)).toEqual(b);
    expect(scopeRows(h)).toMatchObject([
      { closing: true, closed: true },
      { closing: false, closed: false },
    ]);
    await expect(ensure(h, "thread-a", owner, allowed)).rejects.toThrow("run cancelled");
  });

  it("reads closure after a lost reply without sending a second close", async () => {
    const h = fixture(async (value) => {
      if (value.mode === "inspect") return output({ version: 1, boot: BOOT });
      if (value.mode === "bootstrap") return output({ ref: value.ref, closed: false });
      if (value.mode === "close") throw new Error("close reply lost");
      return output({ ref: value.ref, closed: true, populated: false });
    });
    const ref = await ensure(h, "thread-a", owner, allowed);
    await expect(h.scopes.close("thread-a", owner)).rejects.toThrow("close reply lost");
    expect(await h.scopes.close("thread-a", owner)).toEqual(ref);
    expect(h.calls.map((call) => call.mode)).toEqual(["inspect", "bootstrap", "inspect", "close", "inspect", "view"]);
  });

  it("refuses a foreign closure instead of recording the selected run as closed", async () => {
    const h = fixture(async (value) => {
      if (value.mode === "inspect") return output({ version: 1, boot: BOOT });
      const ref = value.ref as NativeScopeRef;
      if (value.mode === "bootstrap") return output({ ref, closed: false });
      return output({ ref: { ...ref, owner: { ...ref.owner, runId: "foreign" } }, closed: true, populated: false });
    });
    await ensure(h, "thread-a", owner, allowed);
    await expect(h.scopes.close("thread-a", owner)).rejects.toThrow("native-scope owner changed");
    expect(scopeRows(h)).toMatchObject([{ closed: false, closing: true }]);
  });
  it("refuses a foreign row under the original storage key before any native control", async () => {
    const h = fixture();
    await ensure(h, "thread-a", owner, allowed);
    const [key, row] = [...h.rows.entries()].find(([key]) => key.startsWith("native-scope:"))!;
    h.rows.set(key, { ...(row as any), owner: { ...owner, runId: "foreign" } });
    const before = h.calls.length;
    await expect(h.scopes.close("thread-a", owner)).rejects.toThrow("owner changed");
    await expect(ensure(h, "thread-a", owner, allowed)).rejects.toThrow("owner changed");
    expect(h.calls.length).toBe(before);
    expect(h.rows.get(key)).toMatchObject({ owner: { runId: "foreign" }, closed: false });
  });

  it("keeps delimiter-bearing owner tuples in separate reservations", async () => {
    const h = fixture();
    const a = await ensure(h, "mcp:a", { runId: "r", ownerGen: "g:h", ownerFence: 1 }, allowed);
    const b = await ensure(h, "mcp:a:r", { runId: "g", ownerGen: "h", ownerFence: 1 }, allowed);
    expect(a.id).not.toBe(b.id);
    expect(scopeRows(h).length).toBe(2);
    expect(await h.scopes.close(a.threadKey, a.owner)).toEqual(a);
    expect(await ensure(h, b.threadKey, b.owner, allowed)).toEqual(b);
  });

  it("resumes an exact close after reset before its submission", async () => {
    const h = fixture(async (value) => {
      if (value.mode === "inspect") return output({ version: 1, boot: BOOT });
      if (value.mode === "bootstrap") return output({ ref: value.ref, closed: false });
      if (value.mode === "view")
        return output({ ref: value.ref, closed: false, populated: true, present: true, ready: true });
      return output({ ref: value.ref, closed: true, populated: false });
    });
    const ref = await ensure(h, "thread-a", owner, allowed);
    const [key, row] = [...h.rows.entries()].find(([key]) => key.startsWith("native-scope:"))!;
    h.rows.set(key, { ...(row as object), closing: true });
    expect(await h.scopes.close("thread-a", owner)).toEqual(ref);
    expect(h.calls.map((value) => value.mode)).toEqual(["inspect", "bootstrap", "inspect", "view", "close"]);
  });
  it("retires only the original scope after a fresh different kernel observation", async () => {
    let boot = BOOT;
    const h = fixture(async (value) =>
      value.mode === "inspect" ? output({ version: 1, boot }) : output({ ref: value.ref, closed: false }),
    );
    const ref = await ensure(h, "thread-a", owner, allowed);
    boot = "11111111-1111-4111-8111-111111111111";
    expect(await h.scopes.close("thread-a", owner)).toEqual(ref);
    expect(scopeRows(h)).toMatchObject([{ closed: true, closing: true, boot: BOOT, closedBoot: boot }]);
    expect(h.calls.map((value) => value.mode)).toEqual(["inspect", "bootstrap", "inspect"]);
    await expect(ensure(h, "thread-a", owner, allowed)).rejects.toThrow("run cancelled");
  });
  it("keeps incomplete bootstrap unknown without creating a replacement identity", async () => {
    const h = fixture(async (value) => {
      if (value.mode === "inspect") return output({ version: 1, boot: BOOT });
      if (value.mode === "bootstrap") throw new Error("reply lost");
      return output({ ref: value.ref, closed: false, populated: false, present: true, ready: false });
    });
    await expect(ensure(h, "thread-a", owner, allowed)).rejects.toThrow();
    await expect(ensure(h, "thread-a", owner, allowed)).rejects.toThrow();
    expect(h.calls.map((value) => value.mode)).toEqual(["inspect", "bootstrap", "view"]);
    expect(scopeRows(h).length).toBe(1);
  });
});

describe("native run birth", () => {
  it("does not adopt a legacy run when its old workspace and settled journal disappear", async () => {
    const h = fixture();
    await h.scopes.birth("thread-a", owner, false, async () => {});
    expect(await h.scopes.protocol("thread-a", owner.runId)).toBe("legacy");
    await expect(h.scopes.birth("thread-a", owner, true, async () => {})).rejects.toThrow("cannot be adopted");
    await expect(h.scopes.ensure("thread-a", owner, allowed)).rejects.toThrow("birth is unconfirmed");
    expect(scopeRows(h)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it("reserves native birth before any runtime call and closes it without waking a VM", async () => {
    const h = fixture();
    await h.scopes.birth("thread-a", owner, true, async () => {});
    expect(scopeRows(h)).toMatchObject([{ boot: null, bootstrap: "reserved" }]);
    expect(await h.scopes.close("thread-a", owner)).toBe("unstarted");
    expect(h.calls).toEqual([]);
    await expect(h.scopes.ensure("thread-a", owner, allowed)).rejects.toThrow("run cancelled");
  });
});

describe("native scope transport deadlines", () => {
  it("bounds a lost initial control acknowledgement without submitting again", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<never>(() => {}));
      const transport = new CloudflareNativeScopeTransport({ running: true, exec });
      const pending = transport.request({ mode: "inspect" }, 50);
      const assertion = expect(pending).rejects.toThrow("outcome is unknown");
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(exec).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fences the same caller-known attempt when its initial launch acknowledgement is lost", async () => {
    vi.useFakeTimers();
    try {
      const calls: any[] = [];
      const exec = vi.fn(async (_argv, options) => {
        const raw = await new Response(options.stdin).text();
        calls.push(JSON.parse(raw));
        return new Promise<never>(() => {});
      });
      const transport = new CloudflareNativeScopeTransport({ running: true, exec } as any);
      const ref = { version: 1, id: "22222222-2222-4222-8222-222222222222", boot: BOOT, owner, threadKey: "thread-a" };
      const pending = transport.request({ mode: "launch", ref, attempt: "33333333-3333-4333-8333-333333333333" }, 50);
      const assertion = expect(pending).rejects.toThrow("outcome is unknown");
      await vi.advanceTimersByTimeAsync(2050);
      await assertion;
      expect(calls.map((value) => ({ mode: value.mode, attempt: value.attempt, ref: value.ref }))).toEqual([
        { mode: "launch", ref, attempt: "33333333-3333-4333-8333-333333333333" },
        { mode: "kill-attempt", ref, attempt: "33333333-3333-4333-8333-333333333333" },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native timeout closure validation", () => {
  it.each(["refused", "foreign", "populated"])(
    "keeps a %s attempt kill unknown even if collection then returns",
    async (fault) => {
      vi.useFakeTimers();
      try {
        const ref = {
          version: 1,
          id: "22222222-2222-4222-8222-222222222222",
          boot: BOOT,
          owner,
          threadKey: "thread-a",
        };
        const attempt = "33333333-3333-4333-8333-333333333333";
        let finish!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
          finish = resolve;
        });
        const exec = async (_argv: unknown, options: any) => {
          const request = JSON.parse(await new Response(options.stdin).text());
          if (request.mode === "launch")
            return { stdout: new Response("original output").body, stderr: new Response("").body, exitCode: exited };
          finish(0);
          return {
            stdout: new Response(
              JSON.stringify({
                ref: fault === "foreign" ? { ...ref, owner: { ...owner, runId: "foreign" } } : ref,
                attempt,
                closed: false,
                populated: fault === "populated",
              }),
            ).body,
            stderr: new Response("").body,
            exitCode: Promise.resolve(fault === "refused" ? 125 : 0),
          };
        };
        const transport = new CloudflareNativeScopeTransport({ running: true, exec } as any);
        const pending = transport.request({ mode: "launch", ref, attempt }, 50);
        const rejected = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(50);
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("shared hydration consumers", () => {
  it("lets a peer finish hydration when the initiating run is cancelled", async () => {
    const source = readSource("worker.ts");
    const compiled = ts.transpileModule(
      `class Resident { ${["ensureHydrated", "withSharedNativeOperation"].map((name) => methodOf(source, name)).join("\n")} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const Constructor = runInNewContext(`${compiled}\nResident`, {
      crypto,
      systemClock: () => 1,
      STALE_MIDFLIGHT_MS: 1000,
      CLEANUP_PENDING_KEY: "cleanup",
    });
    const instance = new Constructor();
    const threads = new AsyncLocalStorage<string>();
    let release!: () => void;
    const shared = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelled = new Set<string>();
    let starts = 0;
    Object.assign(instance, {
      ctx: { storage: { get: async () => undefined } },
      threadOperationScope: threads,
      opOperationScope: new AsyncLocalStorage(),
      hydratedVerdictAt: 0,
      hydrationMemoTtlMs: 10,
      nextHolder: () => "fixture",
      recordInFlight: async () => {},
      clearInFlight: async () => {},
      assertThreadOperationAllowed: async () => {
        if (cancelled.has(threads.getStore() ?? "")) throw new Error("run cancelled");
      },
      withOpNativeOperation: async (_owner: string, fn: () => Promise<void>) => {
        expect(threads.getStore()).toBeUndefined();
        return fn();
      },
      doHydrate: async () => {
        starts++;
        await shared;
      },
    });
    const a = threads.run("a", () => instance.ensureHydrated());
    const rejected = expect(a).rejects.toThrow("run cancelled");
    for (let n = 0; n < 20 && starts === 0; n++) await Promise.resolve();
    const b = threads.run("b", () => instance.ensureHydrated());
    cancelled.add("a");
    release();
    await rejected;
    await expect(b).resolves.toBeUndefined();
    expect(starts).toBe(1);
    expect(instance.hydratedVerdictAt).toBe(1);
  });
});

describe("native binary output", () => {
  it("preserves a valid one-MiB base64 chunk beyond the ordinary command cap", async () => {
    const content = "YWJj".repeat(349526);
    const exec = vi.fn(async () => ({
      stdout: new Blob([content]).stream(),
      stderr: new Blob([]).stream(),
      exitCode: Promise.resolve(0),
    }));
    const transport = new CloudflareNativeScopeTransport({ running: true, exec } as any);
    expect(await transport.request({ mode: "launch" }, 1000)).toEqual({
      stdout: content,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
  });
});
