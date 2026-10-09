import { z } from "zod";
import { AGENT_SMOKE_POLL_MS, MINUTE_MS } from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";
import { assertSmokeOriginMatchesPlan } from "./ingressSmoke.js";

const userId = z.string().regex(/^U[A-Z0-9]+$/);
const configSchema = z
  .object({
    disposable: z.literal(true),
    workspaceId: z.string().regex(/^T[A-Z0-9]+$/),
    userId,
    botUserId: userId,
    channelId: z.string().regex(/^C[A-Z0-9]+$/),
  })
  .strict()
  .refine((c) => c.userId !== c.botUserId);
export const parseSlackSmokeConfig = (value: unknown) => configSchema.parse(value);
const healthSchema = z.object({
  ok: z.literal(true),
  build: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), builtAt: z.string().min(1) }),
  startedAt: z.string().min(1),
  draining: z.literal(false),
  slack: z.object({ connected: z.literal(true) }),
  loadedBase: z.object({
    source: z.object({ kind: z.literal("state"), key: z.string().min(1), version: z.number().int().positive() }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
type Health = z.infer<typeof healthSchema>;
export interface SlackSmokeReceipt {
  scope: "slack-command-smoke";
  outcome: "passed" | "incomplete";
  reason: string;
  limits: { maxMessages: 1; maxWaitMs: number };
  build?: { commit: string };
  identity?: { workspaceId: string; userId: string; botUserId: string };
  message?: { channel: string; ts: string };
  reply?: { ts: string };
}

/** One user mention in a pinned public test channel; unknown effects are observed, never replayed. */
export async function runSlackCommandSmoke(input: {
  origin: string;
  healthUrl: string;
  expectedCommit: string;
  userToken: string;
  config: unknown;
  fetch?: typeof globalThis.fetch;
  onReceipt?: (receipt: SlackSmokeReceipt) => Promise<void>;
}): Promise<SlackSmokeReceipt> {
  const receipt: SlackSmokeReceipt = {
    scope: "slack-command-smoke",
    outcome: "incomplete",
    reason: "configuration_unproven",
    limits: { maxMessages: 1, maxWaitMs: MINUTE_MS },
  };
  const save = () => input.onReceipt?.(structuredClone(receipt));
  await save();
  try {
    assertSmokeOriginMatchesPlan(input.origin, input.healthUrl);
    const healthUrl = new URL("/healthz", input.origin).href;
    const config = parseSlackSmokeConfig(input.config);
    if (!input.userToken) throw Error("missing test-user token");
    const expected = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(input.expectedCommit);
    const deadline = systemClock() + MINUTE_MS;
    const fetch = input.fetch ?? globalThis.fetch;
    const bounded: typeof fetch = (url, init) => {
      const left = deadline - systemClock();
      if (left <= 0) throw Error("deadline exceeded");
      return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(left) });
    };
    const readHealth = async () => {
      const r = await bounded(healthUrl);
      if (!r.ok) throw Error("health unavailable");
      const h = healthSchema.parse(await r.json());
      if (h.build.commit !== expected) throw Error("wrong build");
      return h;
    };
    const request = async (method: string, body: Record<string, string>) => {
      const response = await bounded("https://slack.com/api/" + method, {
        method: "POST",
        headers: { authorization: "Bearer " + input.userToken, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
      const value: unknown = await response.json();
      return { ok: response.ok, value };
    };
    const api = async (method: string, body: Record<string, string>): Promise<unknown> => {
      const answer = await request(method, body);
      if (!answer.ok) throw Error("Slack API unavailable");
      z.object({ ok: z.literal(true) }).parse(answer.value);
      return answer.value;
    };
    receipt.reason = "health_unproven";
    await save();
    const before = await readHealth();
    receipt.build = { commit: before.build.commit };
    receipt.reason = "identity_unproven";
    await save();
    const identity = z
      .object({
        team_id: z.literal(config.workspaceId),
        user_id: z.literal(config.userId),
        bot_id: z.never().optional(),
      })
      .parse(await api("auth.test", {}));
    receipt.identity = { workspaceId: identity.team_id, userId: identity.user_id, botUserId: config.botUserId };
    receipt.reason = "conversation_unproven";
    await save();
    const conversation = z
      .object({
        channel: z.object({
          id: z.literal(config.channelId),
          context_team_id: z.literal(config.workspaceId),
          is_member: z.literal(true),
          is_private: z.literal(false),
          is_shared: z.literal(false),
          is_pending_ext_shared: z.literal(false),
        }),
      })
      .parse(await api("conversations.info", { channel: config.channelId }));
    receipt.reason = "message_ack_unknown";
    await save();
    const posted = await request("chat.postMessage", {
      channel: conversation.channel.id,
      text: `<@${config.botUserId}> status show`,
      unfurl_links: "false",
      unfurl_media: "false",
    });
    // Save usable native message identity before accepting its sender or other metadata.
    const message = z
      .object({ channel: z.string().regex(/^[CDG][A-Z0-9]+$/), ts: z.string().regex(/^\d+\.\d+$/) })
      .parse(posted.value);
    receipt.message = message;
    await save();
    if (!posted.ok) throw Error("Slack API unavailable");
    z.object({ ok: z.literal(true) }).parse(posted.value);
    receipt.reason = "message_binding_unproven";
    await save();
    z.object({
      channel: z.literal(conversation.channel.id),
      message: z.object({ user: z.literal(config.userId) }),
    }).parse(posted.value);
    receipt.reason = "reply_unproven";
    await save();
    while (systemClock() < deadline) {
      const thread = z
        .object({
          has_more: z.boolean().optional(),
          messages: z.array(
            z.object({
              user: z.string().optional(),
              ts: z.string(),
              thread_ts: z.string().optional(),
              text: z.string().optional(),
            }),
          ),
        })
        .parse(await api("conversations.replies", { channel: message.channel, ts: message.ts, limit: "50" }));
      if (thread.has_more) throw Error("thread inventory incomplete");
      const reply = thread.messages.find(
        (m) =>
          m.user === config.botUserId &&
          m.thread_ts === message.ts &&
          m.ts !== message.ts &&
          m.text?.startsWith("Switchboard "),
      );
      if (reply) {
        if (!matchesStatus(reply.text!, before)) throw Error("status reply mismatch");
        receipt.reply = { ts: reply.ts };
        receipt.reason = "final_health_unproven";
        await save();
        const after = await readHealth();
        if (
          after.startedAt !== before.startedAt ||
          after.build.builtAt !== before.build.builtAt ||
          JSON.stringify(after.loadedBase) !== JSON.stringify(before.loadedBase)
        )
          throw Error("process or config changed");
        if (systemClock() >= deadline) throw Error("deadline exceeded");
        receipt.outcome = "passed";
        receipt.reason = "accepted";
        await save();
        return receipt;
      }
      const left = deadline - systemClock();
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(AGENT_SMOKE_POLL_MS, left)));
    }
  } catch {
    // Fixed phase only: remote prose and credential values never become receipts.
  }
  await save();
  return receipt;
}

function matchesStatus(text: string, health: Health): boolean {
  const lines = text.trim().split("\n");
  const source = health.loadedBase.source;
  return (
    lines.length === 3 &&
    lines[0]!.includes(` · build ${health.build.commit.slice(0, 8)} (built ${health.build.builtAt})`) &&
    lines[1]!.startsWith(`started ${health.startedAt} · `) &&
    lines[1]!.endsWith(" · not draining") &&
    lines[2] === `Loaded base: state ${source.key} v${source.version} · sha256 ${health.loadedBase.sha256}`
  );
}
