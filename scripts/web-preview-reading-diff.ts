// The preview's reading-diff fixture (docs/reference/specs/reading-diff.md item 6): one PR
// review's two `review_artifact` payloads — the full `git diff` of a 19-file
// change and meat's abridged reading of it — assembled here from small
// builders so every hunk header counts its own lines. The change is the
// preview's "webhook retry" story told from the API side: a new backoff
// helper, a removed legacy sender, a renamed doc, a binary asset, a
// minified fixture with one very long line, and a pure rename — every file
// shape the panel has to render.

const hunk = (oldStart: number, newStart: number, lines: readonly string[], heading = ""): string => {
  const oldCount = lines.filter((l) => !l.startsWith("+")).length;
  const newCount = lines.filter((l) => !l.startsWith("-")).length;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${heading ? ` ${heading}` : ""}\n${lines.join("\n")}\n`;
};
const modified = (path: string, ...hunks: string[]): string =>
  `diff --git a/${path} b/${path}\nindex 3f2a9c1..8b7d0e4 100644\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
const added = (path: string, lines: readonly string[]): string =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..8b7d0e4\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
const deleted = (path: string, lines: readonly string[]): string =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 3f2a9c1..0000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}\n`;
const renamed = (from: string, to: string, similarity: number, ...hunks: string[]): string =>
  `diff --git a/${from} b/${to}\nsimilarity index ${similarity}%\nrename from ${from}\nrename to ${to}\n` +
  (hunks.length > 0 ? `index 3f2a9c1..8b7d0e4 100644\n--- a/${from}\n+++ b/${to}\n${hunks.join("")}` : "");
const binaryAdded = (path: string): string =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..8b7d0e4\nBinary files /dev/null and b/${path} differ\n`;

const sender = modified(
  "src/webhooks/sender.ts",
  hunk(1, 1, [
    ' import { createHmac } from "node:crypto";',
    ' import type { Delivery, WebhookTarget } from "./types.js";',
    '+import { backoffDelays, isRetryable, type RetryPolicy } from "./retry.js";',
    '+import { counters } from "../metrics/counters.js";',
    " ",
    "-const TIMEOUT_MS = 10_000;",
    "+const TIMEOUT_MS = 10_000;",
    "+const DEFAULT_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };",
    " ",
    " export interface SendResult {",
    "   ok: boolean;",
    "   status?: number;",
    "+  attempts: number;",
    " }",
  ]),
  hunk(
    24,
    28,
    [
      " export async function sendWebhook(target: WebhookTarget, delivery: Delivery): Promise<SendResult> {",
      "-  const res = await post(target, delivery);",
      "-  return { ok: res.ok, status: res.status };",
      "+  const policy = target.retry ?? DEFAULT_POLICY;",
      "+  let attempt = 0;",
      "+  for (const delayMs of [0, ...backoffDelays(policy)]) {",
      "+    if (delayMs > 0) await sleep(delayMs);",
      "+    attempt++;",
      "+    const res = await post(target, delivery);",
      "+    if (res.ok) return { ok: true, status: res.status, attempts: attempt };",
      "+    // A 4xx is the receiver saying no: retrying would only repeat the refusal.",
      "+    if (!isRetryable(res.status)) return { ok: false, status: res.status, attempts: attempt };",
      "+    counters.webhookRetryTotal.inc({ target: target.id });",
      "+  }",
      "+  return { ok: false, attempts: attempt };",
      " }",
      " ",
      "+const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));",
      "+",
      " async function post(target: WebhookTarget, delivery: Delivery): Promise<Response> {",
      "   const body = JSON.stringify(delivery);",
      '   const signature = createHmac("sha256", target.secret).update(body).digest("hex");',
    ],
    "export async function sendWebhook",
  ),
);

const retry = added("src/webhooks/retry.ts", [
  "// Exponential backoff for webhook deliveries: the delay doubles from",
  "// `baseDelayMs` and is capped at `maxDelayMs`; `maxAttempts` counts the first",
  "// try, so a policy of 5 yields four delays.",
  "",
  "export interface RetryPolicy {",
  "  maxAttempts: number;",
  "  baseDelayMs: number;",
  "  maxDelayMs: number;",
  "}",
  "",
  "export function backoffDelays(policy: RetryPolicy): number[] {",
  "  const delays: number[] = [];",
  "  for (let i = 1; i < policy.maxAttempts; i++) {",
  "    delays.push(Math.min(policy.baseDelayMs * 2 ** (i - 1), policy.maxDelayMs));",
  "  }",
  "  return delays;",
  "}",
  "",
  "/** A response worth trying again: a network failure, a 5xx, or a 429. */",
  "export function isRetryable(status: number | undefined): boolean {",
  "  if (status === undefined) return true;",
  "  return status >= 500 || status === 429;",
  "}",
]);

const retryTest = added("src/webhooks/retry.test.ts", [
  'import { describe, expect, it } from "vitest";',
  'import { backoffDelays, isRetryable } from "./retry.js";',
  "",
  'describe("backoffDelays", () => {',
  '  it("doubles from the base and stops at the cap", () => {',
  "    expect(backoffDelays({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 3_000 })).toEqual([500, 1_000, 2_000, 3_000]);",
  "  });",
  '  it("a single attempt has no delays", () => {',
  "    expect(backoffDelays({ maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 3_000 })).toEqual([]);",
  "  });",
  "});",
  "",
  'describe("isRetryable", () => {',
  '  it("retries network failures, 5xx and 429; never another 4xx", () => {',
  "    expect(isRetryable(undefined)).toBe(true);",
  "    expect(isRetryable(503)).toBe(true);",
  "    expect(isRetryable(429)).toBe(true);",
  "    expect(isRetryable(400)).toBe(false);",
  "    expect(isRetryable(404)).toBe(false);",
  "  });",
  "});",
]);

const senderTest = modified(
  "src/webhooks/sender.test.ts",
  hunk(1, 1, [
    '-import { describe, expect, it, vi } from "vitest";',
    '+import { afterEach, describe, expect, it, vi } from "vitest";',
    ' import { sendWebhook } from "./sender.js";',
    " ",
    '-const target = { id: "t1", url: "https://hooks.example/in", secret: "s" };',
    '+const target = { id: "t1", url: "https://hooks.example/in", secret: "s", retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } };',
    "+afterEach(() => vi.restoreAllMocks());",
  ]),
  hunk(
    18,
    19,
    [
      '   it("signs the body", async () => {',
      "     const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));",
      '     vi.stubGlobal("fetch", fetch);',
      "-    await sendWebhook(target, delivery);",
      "+    const result = await sendWebhook(target, delivery);",
      "+    expect(result).toEqual({ ok: true, status: 200, attempts: 1 });",
      "     const [, init] = fetch.mock.calls[0];",
      '     expect(init.headers["x-signature"]).toMatch(/^[0-9a-f]{64}$/);',
      "   });",
      "+",
      '+  it("retries a 503 up to the policy, then gives up", async () => {',
      "+    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));",
      '+    vi.stubGlobal("fetch", fetch);',
      "+    const result = await sendWebhook(target, delivery);",
      "+    expect(result).toEqual({ ok: false, status: 503, attempts: 3 });",
      "+    expect(fetch).toHaveBeenCalledTimes(3);",
      "+  });",
      "+",
      '+  it("never retries a 4xx", async () => {',
      "+    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));",
      '+    vi.stubGlobal("fetch", fetch);',
      "+    const result = await sendWebhook(target, delivery);",
      "+    expect(result.attempts).toBe(1);",
      "+    expect(fetch).toHaveBeenCalledTimes(1);",
      "+  });",
      " });",
    ],
    'describe("sendWebhook"',
  ),
);

const types = modified(
  "src/webhooks/types.ts",
  hunk(1, 1, [
    '+import type { RetryPolicy } from "./retry.js";',
    "+",
    " export interface WebhookTarget {",
    "   id: string;",
    "   url: string;",
    "   secret: string;",
    "+  /** Absent → the sender's default policy. */",
    "+  retry?: RetryPolicy;",
    " }",
  ]),
);

const queue = modified(
  "src/webhooks/queue.ts",
  hunk(
    41,
    41,
    [
      "   for (const delivery of batch) {",
      "     const result = await sendWebhook(target, delivery);",
      "-    if (!result.ok) failed.push(delivery.id);",
      "+    if (!result.ok) failed.push({ id: delivery.id, attempts: result.attempts, status: result.status });",
      "   }",
    ],
    "export async function drain",
  ),
);

const legacySender = deleted("src/webhooks/legacySender.ts", [
  "// The pre-signature sender, kept for receivers that never verified a body.",
  "// Every receiver has been on the signed path for two releases; this is dead.",
  'import type { Delivery, WebhookTarget } from "./types.js";',
  "",
  "export async function sendUnsigned(target: WebhookTarget, delivery: Delivery): Promise<boolean> {",
  "  const res = await fetch(target.url, {",
  '    method: "POST",',
  '    headers: { "content-type": "application/json" },',
  "    body: JSON.stringify(delivery),",
  "  });",
  "  return res.ok;",
  "}",
]);

const retriesDoc = renamed(
  "src/webhooks/backoff.md",
  "docs/webhooks/retries.md",
  71,
  hunk(1, 1, [
    "-# Backoff (draft)",
    "+# Webhook retries",
    " ",
    "-Deliveries are tried once. Retrying is on the roadmap.",
    "+A delivery is tried up to `maxAttempts` times. The delay before each retry doubles from `baseDelayMs` and never exceeds `maxDelayMs`.",
    "+",
    "+| Response | Retried |",
    "+|---|---|",
    "+| network failure | yes |",
    "+| 5xx, 429 | yes |",
    "+| any other 4xx | no — the receiver refused the body |",
  ]),
);

const configSchema = modified(
  "src/config/schema.ts",
  hunk(
    58,
    58,
    [
      "   webhooks: z.object({",
      "     targets: z.array(webhookTarget),",
      "+    retry: z",
      "+      .object({",
      "+        maxAttempts: z.number().int().min(1).max(10).default(5),",
      "+        baseDelayMs: z.number().int().min(0).default(500),",
      "+        maxDelayMs: z.number().int().min(0).default(30_000),",
      "+      })",
      "+      .default({}),",
      "   }),",
    ],
    "export const appConfig = z.object({",
  ),
);

const configSchemaTest = modified(
  "src/config/schema.test.ts",
  hunk(
    77,
    77,
    [
      '   it("webhook targets need a url and a secret", () => {',
      '     expect(() => appConfig.parse({ ...base, webhooks: { targets: [{ id: "t" }] } })).toThrow();',
      "   });",
      "+",
      '+  it("retry defaults to five attempts from half a second, capped at thirty", () => {',
      "+    const parsed = appConfig.parse({ ...base, webhooks: { targets: [] } });",
      "+    expect(parsed.webhooks.retry).toEqual({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 });",
      "+  });",
      "+",
      '+  it("refuses more than ten attempts", () => {',
      "+    expect(() => appConfig.parse({ ...base, webhooks: { targets: [], retry: { maxAttempts: 11 } } })).toThrow();",
      "+  });",
    ],
    'describe("webhooks"',
  ),
);

const defaultYaml = modified(
  "config/default.yaml",
  hunk(12, 12, [
    " webhooks:",
    "   targets: []",
    "+  retry:",
    "+    maxAttempts: 5",
    "+    baseDelayMs: 500",
    "+    maxDelayMs: 30000",
  ]),
);

const webhooksDoc = modified(
  "docs/reference/webhooks.md",
  hunk(30, 30, [
    " ## Delivery",
    " ",
    "-Each event is posted once to every target; a failed post is logged and dropped.",
    "+Each event is posted to every target and retried on a network failure, a 5xx or a 429 under the target's retry policy (`webhooks.retry` in the config, or a per-target override) — exponential backoff from `baseDelayMs`, doubling each time and capped at `maxDelayMs`, for at most `maxAttempts` tries counting the first; any other 4xx is final, because the receiver refused the body and would refuse it again. The outcome of every delivery, including how many attempts it took, is on the `webhook_retry_total` counter and in the drain report.",
    " ",
    " ## Signing",
  ]),
);

const packageJson = modified(
  "package.json",
  hunk(31, 31, ['     "vitest": "^5.0.0",', '-    "zod": "^4.1.0"', '+    "zod": "^4.3.2"', "   }"]),
);

const payloadFixture = added("src/webhooks/fixtures/payload.json", [
  '{"id":"dlv_01J9Y3K7Q2M8N4P6R8S0T2V4W6","event":"order.updated","attempt":1,"data":{"orderId":"ord_9f8e7d6c","status":"shipped","items":[{"sku":"SKU-0001","qty":2,"unitPrice":1999},{"sku":"SKU-0042","qty":1,"unitPrice":4999},{"sku":"SKU-0107","qty":3,"unitPrice":299}],"shipping":{"carrier":"ups","tracking":"1Z999AA10123456784","eta":"in two days"},"totals":{"subtotal":9894,"tax":812,"shipping":0,"grand":10706}},"signature":"f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00"}',
]);

const flowPng = binaryAdded("assets/webhook-flow.png");

const index = modified(
  "src/index.ts",
  hunk(
    88,
    88,
    [
      "   const queue = createWebhookQueue({",
      "     targets: config.webhooks.targets,",
      "+    retry: config.webhooks.retry,",
      "     send: sendWebhook,",
      "   });",
    ],
    "async function main()",
  ),
);

const counters = modified(
  "src/metrics/counters.ts",
  hunk(19, 19, [
    '   webhookSentTotal: counter("webhook_sent_total", ["target"]),',
    '+  webhookRetryTotal: counter("webhook_retry_total", ["target"]),',
    '   webhookFailedTotal: counter("webhook_failed_total", ["target", "status"]),',
  ]),
);

const changelog = modified(
  "CHANGELOG.md",
  hunk(1, 1, [
    " # Changelog",
    " ",
    "+## Unreleased",
    "+",
    "+- Webhook deliveries retry with exponential backoff (five attempts, never on a 4xx); `webhooks.retry` configures the policy.",
    "+- The unsigned legacy sender is gone.",
    "+",
    " ## 2.4.0",
  ]),
);

const smokeScript = renamed("scripts/smoke-webhooks.sh", "scripts/smoke/webhooks.sh", 100);

/** The full `git diff origin/main...HEAD`, capped the way the producer caps it. */
export const READING_DIFF_GIT =
  [
    sender,
    retry,
    retryTest,
    senderTest,
    types,
    queue,
    legacySender,
    retriesDoc,
    configSchema,
    configSchemaTest,
    defaultYaml,
    webhooksDoc,
    packageJson,
    payloadFixture,
    flowPng,
    index,
    counters,
    changelog,
    smokeScript,
  ].join("") + "…[4 812 more chars]";

/** meat's abridged reading: the concepts of the change, mechanical noise dropped. */
export const READING_DIFF_MEAT = [
  modified(
    "src/webhooks/sender.ts",
    hunk(
      24,
      28,
      [
        " export async function sendWebhook(target: WebhookTarget, delivery: Delivery): Promise<SendResult> {",
        "-  const res = await post(target, delivery);",
        "-  return { ok: res.ok, status: res.status };",
        "+  const policy = target.retry ?? DEFAULT_POLICY;",
        "+  let attempt = 0;",
        "+  for (const delayMs of [0, ...backoffDelays(policy)]) {",
        "+    if (delayMs > 0) await sleep(delayMs);",
        "+    attempt++;",
        "+    const res = await post(target, delivery);",
        "+    if (res.ok) return { ok: true, status: res.status, attempts: attempt };",
        "+    // A 4xx is the receiver saying no: retrying would only repeat the refusal.",
        "+    if (!isRetryable(res.status)) return { ok: false, status: res.status, attempts: attempt };",
        "+    counters.webhookRetryTotal.inc({ target: target.id });",
        "+  }",
        "+  return { ok: false, attempts: attempt };",
        " }",
      ],
      "export async function sendWebhook",
    ),
  ),
  added("src/webhooks/retry.ts", [
    "export function backoffDelays(policy: RetryPolicy): number[] {",
    "  const delays: number[] = [];",
    "  for (let i = 1; i < policy.maxAttempts; i++) {",
    "    delays.push(Math.min(policy.baseDelayMs * 2 ** (i - 1), policy.maxDelayMs));",
    "  }",
    "  return delays;",
    "}",
    "",
    "/** A response worth trying again: a network failure, a 5xx, or a 429. */",
    "export function isRetryable(status: number | undefined): boolean {",
    "  if (status === undefined) return true;",
    "  return status >= 500 || status === 429;",
    "}",
  ]),
  configSchema,
  legacySender,
  counters,
].join("");

export const READING_DIFF_SUMMARY =
  "Webhook deliveries gain a retry policy: exponential backoff from 500 ms, doubling to a 30 s cap, five attempts at most, and never after a 4xx; the policy is configurable under webhooks.retry, retries are counted, and the unsigned legacy sender is removed.";
