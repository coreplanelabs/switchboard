import { describe, expect, it } from "vitest";
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  handleCheckRunIntake,
  verifyWebhookSignature,
  type CheckRunIntakeDeps,
  createMergeWaitRegistry,
} from "./checksIntake.js";
import { checksSettledEventType, type WorkflowSender } from "./contract.js";

const SECRET = "hush";
const HEAD = "a".repeat(40);

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "completed",
    check_run: { head_sha: HEAD },
    repository: { full_name: "octo/repo" },
    ...over,
  });

function workflow() {
  const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
  const sender: WorkflowSender = {
    async get(id) {
      return {
        async sendEvent(event) {
          sent.push({ instance: id, ...event });
        },
      };
    },
  };
  return { sender, sent };
}

function deps(over: Partial<CheckRunIntakeDeps> = {}): CheckRunIntakeDeps {
  return {
    secret: SECRET,
    checksSettled: async () => true,
    instancesWaitingAt: async () => ["plan-x"],
    workflow: workflow().sender,
    now: () => 1000,
    ...over,
  };
}

describe("the GitHub check-run intake — the checks-settled event's publisher (http-ingress item 12)", () => {
  it("verifies the webhook signature: a valid HMAC passes, a wrong secret, a tampered body and a missing header are refused 401, and no secret disables the intake 503 — never open", async () => {
    const raw = body();
    const good = await sign(SECRET, raw);
    expect(await verifyWebhookSignature(SECRET, raw, good)).toBe(true);
    expect(await verifyWebhookSignature("other", raw, good)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, raw + " ", good)).toBe(false);

    const refused = await handleCheckRunIntake(
      { event: "check_run", signature: await sign("other", raw) },
      raw,
      deps(),
    );
    expect(refused.status).toBe(401);
    const missing = await handleCheckRunIntake({ event: "check_run" }, raw, deps());
    expect(missing.status).toBe(401);
    const disabled = await handleCheckRunIntake(
      { event: "check_run", signature: good },
      raw,
      deps({ secret: undefined }),
    );
    expect(disabled.status).toBe(503);
  });

  it("a completed check_run whose head has every check settled sends checks-settled-<head> to each waiting instance, best effort", async () => {
    const raw = body();
    const w = workflow();
    const res = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, raw) },
      raw,
      deps({ workflow: w.sender, instancesWaitingAt: async (h) => (h === HEAD ? ["plan-x", "plan-y"] : []) }),
    );
    expect(res).toEqual({ status: 200, body: { ok: true, settled: true, sent: 2, of: 2 } });
    expect(w.sent).toEqual([
      { instance: "plan-x", type: checksSettledEventType(HEAD), payload: { headSha: HEAD, settledAt: 1000 } },
      { instance: "plan-y", type: checksSettledEventType(HEAD), payload: { headSha: HEAD, settledAt: 1000 } },
    ]);
  });

  it("anything that is not the last settled check run sends nothing: another event, a non-completed action, checks still pending; a malformed body is 400; a failed send is answered, never thrown", async () => {
    const other = await handleCheckRunIntake({ event: "push", signature: await sign(SECRET, body()) }, body(), deps());
    expect(other.body).toMatchObject({ ignored: "event" });
    const created = body({ action: "created" });
    const notDone = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, created) },
      created,
      deps(),
    );
    expect(notDone.body).toMatchObject({ ignored: "action" });
    const raw = body();
    const pending = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, raw) },
      raw,
      deps({ checksSettled: async () => false }),
    );
    expect(pending.body).toEqual({ ok: true, settled: false });
    const bad = "{not json";
    const invalid = await handleCheckRunIntake({ event: "check_run", signature: await sign(SECRET, bad) }, bad, deps());
    expect(invalid.status).toBe(400);
    const noHead = body({ check_run: {} });
    const headless = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, noHead) },
      noHead,
      deps(),
    );
    expect(headless.status).toBe(400);
    const failing: WorkflowSender = {
      async get() {
        throw new Error("instance ended");
      },
    };
    const failed = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, raw) },
      raw,
      deps({ workflow: failing }),
    );
    expect(failed).toEqual({ status: 200, body: { ok: true, settled: true, sent: 0, of: 1 } });
    expect(GITHUB_SIGNATURE_HEADER).toBe("x-hub-signature-256");
    expect(GITHUB_EVENT_HEADER).toBe("x-github-event");
  });
});

describe("the merge-wait registry — who the settled head wakes", () => {
  it("notes waiters per head, answers them until the TTL passes, and never mixes heads", () => {
    const reg = createMergeWaitRegistry(10_000);
    reg.note("aaa111", "plan-x", 1_000);
    reg.note("aaa111", "plan-y", 2_000);
    reg.note("bbb222", "plan-z", 1_000);
    expect(reg.waitingAt("aaa111", 5_000).sort()).toEqual(["plan-x", "plan-y"]);
    expect(reg.waitingAt("bbb222", 5_000)).toEqual(["plan-z"]);
    expect(reg.waitingAt("ccc333", 5_000)).toEqual([]);
    // plan-x's entry expires; plan-y's stands.
    expect(reg.waitingAt("aaa111", 12_000)).toEqual(["plan-y"]);
    expect(reg.waitingAt("aaa111", 13_000)).toEqual([]);
  });
});
