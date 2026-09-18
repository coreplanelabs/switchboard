import { describe, expect, it } from "vitest";
import {
  RUNTIME_MOVED_WORDING,
  RUNTIME_REPLACEMENT_WORDING,
  runtimeUnreachableReason,
  selfAndCauses,
} from "../../src/execution/residentRefresh";
import { installedSdkSource } from "../../src/execution/testing/installedSdkSource";
import {
  ControlResetError,
  PLATFORM_INTERNAL_ERROR_WORDING,
  RuntimeReplacedError,
  TRANSIENT_PLATFORM_WORDING,
  controlResetErr,
  execFailureDocument,
  runtimeReplacedErr,
  threadErrBuilders,
  type ThreadDataRoute,
  type ThrowPredicates,
} from "./threadErr";

// Feature: docs/reference/specs/execution.md item 9 — a throw no route named is
// one typed 500 wherever the resident catches it, and a thread data-plane call
// that REJECTED is answered as the Durable Object answers the same fact inside.
// The rules are pure over `(err, route)` (threadErr.ts) and run here with the
// SDK's real sentences; the predicates only the Worker can supply are rebuilt
// over the SDK's own regexes, read from its pinned dist (the package imports
// `cloudflare:workers`, so plain Node cannot load it), as far as text reaches —
// the SDK's typed classes do not survive the stub boundary either. The Worker's
// scan (notServiceable.test.ts) pins only that the entry wires these builders.

const sdk = installedSdkSource();
/** A regex literal's body from a `const NAME = /…/i;` line of the SDK's dist. */
function sdkRegex(name: string): RegExp {
  const literal = new RegExp(`const ${name} =\\s*/(.+)/i;`).exec(sdk);
  expect(literal, name).not.toBeNull();
  return new RegExp(literal![1], "i");
}
const superseded = sdkRegex("SUPERSEDED_ISOLATE_PATTERN");
const connectionLost = sdkRegex("CONNECTION_LOST_PATTERN");
const storageStartup = sdkRegex("DO_STORAGE_STARTUP_RESET_PATTERN");

const messageOf = (link: unknown): string => (link instanceof Error ? link.message : String(link));
const anyLink = (err: unknown, test: (link: unknown, message: string) => boolean): boolean =>
  [...selfAndCauses(err)].some((link) => test(link, messageOf(link)));

/** The Worker's predicates, by the text halves that reach a rejected stub call. */
const predicates: ThrowPredicates = {
  isControlReset: (err) => anyLink(err, (_link, message) => superseded.test(message)),
  isRuntimeReplacement: (err) => anyLink(err, (_link, message) => RUNTIME_REPLACEMENT_WORDING.test(message)),
  sdkVouchesRuntimeMoved: (err) => anyLink(err, (_link, message) => RUNTIME_MOVED_WORDING.test(message)),
  // The SDK's `isPlatformTransientError`, as its source reads: the three patterns and the typed flag, minus the overloaded exclusion.
  isPlatformTransientError: (err) =>
    anyLink(
      err,
      (link, message) =>
        superseded.test(message) ||
        connectionLost.test(message) ||
        storageStartup.test(message) ||
        ((link as { retryable?: unknown }).retryable === true && !message.includes("Durable Object is overloaded")),
    ),
};
const { isTransientPlatformThrow, catchAllErr, threadRejectionErr } = threadErrBuilders(predicates);
const ROUTES: readonly ThreadDataRoute[] = ["/exec", "/read", "/write"];

// The sentences, each from its emitting source: the SDK's dist (its patterns
// and `Network connection lost.`), the resident's wording lists
// (src/execution/residentRefresh.ts), the resident's own renamed word
// (`runtimeUnreachableReason`), Node's measured `AbortSignal.timeout` text;
// the platform's bare `internal error`, its memory-limit reset and its
// storage-timeout reset are assumptions about workerd's text, named in the
// source beside the wording.
const RESET = "reset because its code was updated";
const MOVED = "Process handle refers to a previous runtime incarnation";
const STOPPED = "The container is not running, consider calling start()";
const CONNECTION_LOST = "Network connection lost.";
const STORAGE_STARTUP = "internal error while starting up durable object storage caused object to be reset";
const MEMORY_LIMIT = "Durable Object's isolate exceeded its memory limit and was reset.";
const STORAGE_TIMEOUT = "Durable Object storage operation exceeded timeout which caused object to be reset.";
const OVERLOADED = "Durable Object is overloaded";

describe("threadRejectionErr answers a rejected stub call as the Durable Object answers the same fact inside, by route", () => {
  it("the DO's code-update reset is the DO's own `control-reset` word on its 409 on every route — never a transient 500 the client would wait on while a write's outcome is unknown — in the `call` phase's wording, which speaks of the request", () => {
    for (const route of ROUTES) {
      const answer = threadRejectionErr(new Error(RESET), route);
      expect(answer, route).toEqual({
        error: `control-reset: the resident's Durable Object was reset (a deploy) while this request was pending at the Worker; the container and its processes are as they were; the request's outcome is unknown (${RESET})`,
        status: 409,
        reason: "control-reset",
        cause: "system",
      });
      expect(answer).not.toHaveProperty("transient");
    }
    // The reset outranks a replacement wording that rides the same cause chain.
    const both = new Error(RESET, { cause: new Error(STOPPED) });
    expect(threadRejectionErr(both, "/exec").reason).toBe("control-reset");
  });

  it("the SDK's own moved-runtime sentence is the replaced word on every route — the SDK vouched, by the DO's rule applied to the text that survives the stub boundary — with `known` true riding into the error and the request wording in the words", () => {
    for (const route of ROUTES) {
      expect(threadRejectionErr(new Error(MOVED), route), route).toEqual({
        error: `runtime-replaced: the resident runtime was replaced (a deploy) while this request was pending at the Worker; its outcome is unknown (${MOVED})`,
        status: 409,
        reason: "runtime-replaced",
        cause: "system",
      });
    }
    // Wrapped one link down, the same verdict.
    expect(threadRejectionErr(new Error("stub call failed", { cause: new Error(MOVED) }), "/exec").reason).toBe(
      "runtime-replaced",
    );
  });

  it("the stopped-container sentence, which only the DO's restore knowledge could vouch for, is WITHHELD on /exec — the SDK's words on a bare 409, no reason, no transient, for the harness seam's one more command to judge — and SAID on /read and /write, where the word drives the client's one re-attach-and-retry and never a verdict", () => {
    expect(threadRejectionErr(new Error(STOPPED), "/exec")).toEqual({ error: STOPPED, status: 409, cause: "system" });
    for (const route of ["/read", "/write"] as const) {
      expect(threadRejectionErr(new Error(STOPPED), route), route).toEqual({
        error: `runtime-replaced: the resident runtime was replaced (a deploy) while this request was pending at the Worker; its outcome is unknown (${STOPPED})`,
        status: 409,
        reason: "runtime-replaced",
        cause: "system",
      });
    }
    expect(threadRejectionErr(new Error("Process supervisor is closed"), "/exec")).toEqual({
      error: "Process supervisor is closed",
      status: 409,
      cause: "system",
    });
  });

  it("anything else is the typed 500: the platform's own transient — the SDK's signal (a lost connection, the storage-startup reset, the typed `retryable` flag), the runtime unreachable by the SDK's abort or by the resident's renamed word, and the remainder sentences (the bare `internal error`, the memory-limit reset, the storage-timeout reset, the overloaded Durable Object) — is `transient: true` on every route; a throw in the route itself is `transient: false`", () => {
    const transient: Array<[string, unknown]> = [
      ["a lost connection", new Error(CONNECTION_LOST)],
      ["a lost connection one link down", new Error("stub call failed", { cause: new Error(CONNECTION_LOST) })],
      ["the storage-startup reset", new Error(STORAGE_STARTUP)],
      ["the typed retryable flag", Object.assign(new Error("Durable Object request failed"), { retryable: true })],
      ["the SDK's connect abort", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
      [
        "the resident's renamed runtime-unreachable word",
        Object.assign(new Error(runtimeUnreachableReason(1)), { name: "RuntimeUnreachableError" }),
      ],
      ["the platform's bare internal error", new Error("internal error")],
      ["the platform's bare internal error, with its period", new Error("internal error.")],
      ["the memory-limit reset", new Error(MEMORY_LIMIT)],
      ["the storage-timeout reset", new Error(STORAGE_TIMEOUT)],
      ["the overloaded Durable Object", new Error(OVERLOADED)],
    ];
    for (const [what, err] of transient) {
      expect(isTransientPlatformThrow(err), what).toBe(true);
      for (const route of ROUTES) {
        expect(threadRejectionErr(err, route), `${what} on ${route}`).toEqual({
          error: messageOf(err),
          status: 500,
          transient: true,
          cause: "system",
        });
      }
    }
    const deterministic: Array<[string, unknown]> = [
      ["a bug in the route", new TypeError("Cannot read properties of undefined (reading 'x')")],
      ["git's internal error, embedded", new Error("fatal: internal error")],
      ["the platform's word inside another sentence", new Error("internal error while cloning the mirror")],
      // A Worker's own failed outbound fetch carries exactly `internal error`;
      // wrapped by the route that made the GitHub or mirror subrequest it is
      // that route's deterministic failure, never a blip a re-probe clears.
      [
        "a Worker's own failed subrequest, wrapped by the route",
        new Error("attach-failed at clone: fetching the mirror failed", { cause: new TypeError("internal error") }),
      ],
      [
        "the same, two links down",
        new Error("op-failed", { cause: new Error("install", { cause: new TypeError("internal error") }) }),
      ],
      ["a GitHub overload line", new Error("GitHub API: overloaded, try again")],
      ["the bare word", new Error("overloaded")],
      ["the timeout text a route's own bound raises", new Error("The operation was aborted due to timeout")],
      ["a retryable flag that is not true", Object.assign(new Error("x"), { retryable: "yes" })],
    ];
    for (const [what, err] of deterministic) {
      expect(isTransientPlatformThrow(err), what).toBe(false);
      expect(threadRejectionErr(err, "/exec"), what).toEqual({
        error: messageOf(err),
        status: 500,
        transient: false,
        cause: "system",
      });
    }
  });
});

describe("catchAllErr is the one shape of the 500 for a throw no route named", () => {
  it("the words behind the route's own prefix where it has one, and the verdict as a field", () => {
    expect(catchAllErr(new Error(CONNECTION_LOST), "attach-failed")).toEqual({
      error: `attach-failed: ${CONNECTION_LOST}`,
      status: 500,
      transient: true,
      cause: "system",
    });
    expect(catchAllErr(new TypeError("boom"), "op-failed")).toEqual({
      error: "op-failed: boom",
      status: 500,
      transient: false,
      cause: "system",
    });
    expect(catchAllErr("a string was thrown")).toEqual({
      error: "a string was thrown",
      status: 500,
      transient: false,
      cause: "system",
    });
    // The typed predicates count here too: a reset or a replacement the fetch handler's catch-all meets is transient.
    expect(catchAllErr(new Error(RESET)).transient).toBe(true);
    expect(catchAllErr(new Error(STOPPED)).transient).toBe(true);
  });

  it("the remainder wording is exactly the four sentences the SDK's predicate does not name, each anchored so an embedding never matches — three read on the cause chain, the bare `internal error` on the top-level throw alone", () => {
    expect(TRANSIENT_PLATFORM_WORDING.source).toBe(
      "exceeded its memory limit and was reset|storage operation exceeded timeout which caused object to be reset|durable object is overloaded",
    );
    expect(PLATFORM_INTERNAL_ERROR_WORDING.source).toBe("^internal error\\.?$");
    expect(PLATFORM_INTERNAL_ERROR_WORDING.test("internal error")).toBe(true);
    expect(PLATFORM_INTERNAL_ERROR_WORDING.test("fatal: internal error")).toBe(false);
    // A route's own text with the same two words is not the platform's storage-timeout reset.
    expect(TRANSIENT_PLATFORM_WORDING.test("git lfs: storage operation failed")).toBe(false);
    expect(TRANSIENT_PLATFORM_WORDING.test(STORAGE_TIMEOUT)).toBe(true);
    expect(TRANSIENT_PLATFORM_WORDING.flags).toBe("i");
    // The SDK's own sentences are the SDK's to name: none of them is in the remainder.
    for (const sentence of [CONNECTION_LOST, STORAGE_STARTUP, RESET]) {
      expect(TRANSIENT_PLATFORM_WORDING.test(sentence), sentence).toBe(false);
    }
    // And the SDK's predicate, as its source reads, carries neither the bare
    // `internal error` nor the memory-limit reset without the `retryable` flag.
    expect(predicates.isPlatformTransientError(new Error("internal error"))).toBe(false);
    expect(predicates.isPlatformTransientError(new Error(MEMORY_LIMIT))).toBe(false);
    expect(sdk).toMatch(
      /return typed\.retryable === true && typed\.overloaded !== true && !message\.includes\("Durable Object is overloaded"\);/,
    );
  });
});

describe("the fallback hands its verdicts on", () => {
  it("threadRejectionErr's typed 500 walks the cause chain for the reset and the replacement no second time: the two predicates it settled run once, and a caller with no verdicts of its own has catchAllErr settle them once each", () => {
    const counts = { reset: 0, replaced: 0 };
    const counting: ThrowPredicates = {
      ...predicates,
      isControlReset: (err) => {
        counts.reset += 1;
        return predicates.isControlReset(err);
      },
      isRuntimeReplacement: (err) => {
        counts.replaced += 1;
        return predicates.isRuntimeReplacement(err);
      },
    };
    const b = threadErrBuilders(counting);
    expect(b.threadRejectionErr(new TypeError("boom"), "/exec")).toEqual({
      error: "boom",
      status: 500,
      transient: false,
      cause: "system",
    });
    expect(counts).toEqual({ reset: 1, replaced: 1 });
    counts.reset = 0;
    counts.replaced = 0;
    expect(b.catchAllErr(new TypeError("boom"), "attach-failed").transient).toBe(false);
    expect(counts).toEqual({ reset: 1, replaced: 1 });
  });
});

describe("the error classes and their builders", () => {
  it("each phase names its moment and its subject: a command's spawn or collect inside the DO, a request pending at the Worker's call; `known` rides the replacement either way", () => {
    const cause = new Error(STOPPED);
    expect(new ControlResetError("spawn", cause).message).toBe(
      `control-reset: the resident's Durable Object was reset (a deploy) while this command was starting; the container and its processes are as they were; the command's outcome is unknown (${STOPPED})`,
    );
    expect(new ControlResetError("collect", cause).message).toMatch(/while this command was running; /);
    expect(new ControlResetError("call", cause).message).toMatch(
      /while this request was pending at the Worker; .*the request's outcome is unknown/,
    );
    expect(new RuntimeReplacedError("spawn", cause, true).message).toBe(
      `runtime-replaced: the resident runtime was replaced (a deploy) while this command was starting; its output is lost (${STOPPED})`,
    );
    expect(new RuntimeReplacedError("collect", cause, false).message).toMatch(
      /while this command was running; its output is lost/,
    );
    expect(new RuntimeReplacedError("call", cause, true).message).toMatch(
      /while this request was pending at the Worker; its outcome is unknown/,
    );
    for (const [phase, known] of [
      ["spawn", true],
      ["collect", false],
      ["call", true],
    ] as const) {
      const err = new RuntimeReplacedError(phase, cause, known);
      expect(err.phase).toBe(phase);
      expect(err.known).toBe(known);
      expect(err.name).toBe("RuntimeReplacedError");
    }
    expect(new ControlResetError("call", cause).name).toBe("ControlResetError");
  });

  it("the two ThreadErr builders answer two distinct reasons the client keys on, on a 409", () => {
    const cause = new Error(MOVED);
    expect(runtimeReplacedErr(new RuntimeReplacedError("collect", cause, true))).toEqual({
      error: new RuntimeReplacedError("collect", cause, true).message,
      status: 409,
      reason: "runtime-replaced",
      cause: "system",
    });
    expect(controlResetErr(new ControlResetError("collect", cause))).toEqual({
      error: new ControlResetError("collect", cause).message,
      status: 409,
      reason: "control-reset",
      cause: "system",
    });
  });
});

describe("execFailureDocument is the /exec stream's one failure document", () => {
  it("a failure the Durable Object named rides with every field it carries, in the dual shape", () => {
    expect(
      execFailureDocument({
        error: "mirror-busy: mutex not acquired within 30000ms",
        status: 503,
        state: "degraded",
        stateReason: "github-unreachable: fetch failed",
        reason: "mirror-busy",
      }),
    ).toEqual({
      error: "mirror-busy: mutex not acquired within 30000ms",
      state: "degraded",
      stateReason: "github-unreachable: fetch failed",
      reason: "mirror-busy",
      status: 503,
      stdout: "",
      stderr: "mirror-busy: mutex not acquired within 30000ms",
      exitCode: 127,
    });
    expect(execFailureDocument({ error: "worktree-missing: gone", status: 409, needs: "attach" })).toEqual({
      error: "worktree-missing: gone",
      needs: "attach",
      status: 409,
      stdout: "",
      stderr: "worktree-missing: gone",
      exitCode: 127,
    });
  });

  it("a pending result that rejected rides the same document, its status, word and verdict beside the words", () => {
    expect(execFailureDocument(threadRejectionErr(new Error(CONNECTION_LOST), "/exec"))).toEqual({
      error: CONNECTION_LOST,
      status: 500,
      transient: true,
      cause: "system",
      stdout: "",
      stderr: CONNECTION_LOST,
      exitCode: 127,
    });
    expect(execFailureDocument(threadRejectionErr(new Error(RESET), "/exec"))).toMatchObject({
      status: 409,
      reason: "control-reset",
      exitCode: 127,
    });
    expect(execFailureDocument(threadRejectionErr(new Error(STOPPED), "/exec"))).toEqual({
      error: STOPPED,
      status: 409,
      cause: "system",
      stdout: "",
      stderr: STOPPED,
      exitCode: 127,
    });
  });
});

describe("every named refusal carries the seam's cause beside its words (record 0054)", () => {
  it("a throw no route named, a replaced runtime and a reset DO are `system`: the machinery's own, never the person's", () => {
    expect(catchAllErr(new Error("boom")).cause).toBe("system");
    expect(runtimeReplacedErr(new RuntimeReplacedError("spawn", new Error("moved"), true)).cause).toBe("system");
    expect(controlResetErr(new ControlResetError("call", new Error(RESET))).cause).toBe("system");
    // The withheld replacement word on /exec is the platform's too.
    expect(threadRejectionErr(new Error(STOPPED), "/exec").cause).toBe("system");
  });

  it("the cause rides the /exec failure document beside the words, so a streamed failure is read by a field", () => {
    const doc = execFailureDocument(catchAllErr(new Error("boom"), "attach-failed")) as Record<string, unknown>;
    expect(doc.cause).toBe("system");
    expect(doc.error).toBe("attach-failed: boom");
  });
});
