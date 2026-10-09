import { z } from "zod";
import { checkExecutionReceiptSchema } from "../core/checkExecution.js";
import { AGENT_SMOKE_POLL_MS, leaseMinimum, minutesToMs } from "../core/budgets.js";
import { answerOutcomeOf } from "../core/answerOutcome.js";
import { unwrapUntrusted } from "../core/untrusted.js";
import { StreamableHttpMcpClient } from "../mcp/client.js";
import { assertSmokeOriginMatchesPlan } from "./ingressSmoke.js";
import { systemClock } from "../core/trace/clock.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const component = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const configSchema = z
  .object({
    disposable: z.literal(true),
    channel: component,
    subject: component,
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    workspace: z
      .object({
        path: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/)
          .refine((p) => !p.split("/").includes("..")),
        answer: z.string().trim().min(1).max(128),
      })
      .strict(),
    review: z
      .object({
        number: z.number().int().positive(),
        head: sha,
        expectedVerdict: z.enum(["approve", "request_changes"]).optional(),
      })
      .strict(),
    maxObservedUsd: z.number().finite().positive().max(10),
  })
  .strict();
type SmokeConfig = z.infer<typeof configSchema>;
export const parseSmokeConfig = (value: unknown): SmokeConfig => configSchema.parse(value);
const buildSchema = z.object({ commit: sha, version: z.string().min(1).max(80).optional() });
type SmokeBuild = z.infer<typeof buildSchema>;
const runSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channelId: z.string(),
  threadKey: z.string(),
  agent: z.string(),
  repo: z.string().optional(),
  profile: z.object({
    minutes: z.number().finite().positive(),
    machine: z.enum(["none", "blank", "repo-cold", "repo-resident"]),
  }),
  finished: z.boolean(),
  persisted: z.boolean().optional(),
  status: z.string().optional(),
  provisional: z.boolean().optional(),
  restarting: z.boolean().optional(),
  replyOk: z.boolean().optional(),
  answerOutcome: z.unknown(),
  usage: z.object({ turns: z.number().int().nonnegative() }).optional(),
  cost: z.object({ usd: z.number().finite().nonnegative().nullable() }).optional(),
  parentInstanceId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  events: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      output: z.string().optional(),
      tool: z.string().optional(),
      callId: z.string().optional(),
      ok: z.boolean().optional(),
      cut: z.boolean().optional(),
      infra: z.boolean().optional(),
    }),
  ),
  reviewHead: z.string().optional(),
  reviewPost: z
    .object({
      posted: z.boolean(),
      verdict: z.enum(["approve", "request_changes"]).optional(),
      target: z.object({ repo: z.string(), number: z.number().int().positive() }).optional(),
      head: z.string().optional(),
    })
    .optional(),
});

// Read the tool's fixed evidence frame, never its prose or metadata diagnostics.
function recordedReviewCheck(
  event: z.infer<typeof runSchema>["events"][number],
  run: z.infer<typeof runSchema>,
  head: string,
): boolean {
  const lines = unwrapUntrusted(event.output ?? "").split("\n");
  if (lines.length !== 4 || lines[1] !== "<untrusted-check-evidence>" || lines[3] !== "</untrusted-check-evidence>")
    return false;
  try {
    const parsed = checkExecutionReceiptSchema.safeParse(JSON.parse(lines[2]!));
    if (!parsed.success) return false;
    const receipt = parsed.data;
    return (
      receipt.callId === event.callId &&
      receipt.owner.runId === run.id &&
      receipt.owner.requester === run.userId &&
      receipt.owner.threadKey === run.threadKey &&
      receipt.owner.repo === run.repo &&
      receipt.workspace.head === head &&
      receipt.command.trim().length > 0 &&
      receipt.completedAt !== undefined &&
      receipt.completedAt >= receipt.startedAt &&
      receipt.outcome.kind === "completed" &&
      receipt.outcome.exitCode === 0 &&
      receipt.outcome.truncated === false
    );
  } catch {
    return false;
  }
}

type Outcome = "passed" | "failed" | "incomplete" | "skipped";
export interface SmokeScenario {
  id: "answer" | "workspace" | "review";
  agent: "general" | "explore" | "review";
  text: string;
  minutes: number;
}
export interface SmokeTransport {
  health(): Promise<unknown>;
  request(scenario: SmokeScenario, thread: string): Promise<unknown>;
  readRun(id: string): Promise<unknown>;
}
interface ScenarioReceipt {
  id: SmokeScenario["id"];
  outcome: Outcome;
  reason: string;
  thread: string;
  runId?: string;
  build?: SmokeBuild;
  userId?: string;
  threadKey?: string;
  parentInstanceId?: string;
  idempotencyKey?: string;
  observedUsd?: number;
  artifact?: { repo: string; number: number; head: string; verdict?: "approve" | "request_changes" };
}
export const PRODUCT_ACCEPTANCE_GAP = {
  outcome: "incomplete",
  reason: "private-question-fix-draft-pr-unproven",
} as const;

export interface AgentSmokeReceipt {
  version: 1;
  scope: "deployment-capability-smoke";
  capabilityOutcome: Exclude<Outcome, "skipped">;
  build?: SmokeBuild;
  limits: {
    maxRuns: 3;
    scenarios: Array<{ id: SmokeScenario["id"]; runMinutes: number; requestDeadlineMs: number }>;
    maxObservedUsd: number;
  };
  observedUsd: number;
  scenarios: ScenarioReceipt[];
  liveGaps: ["private-question-fix-draft-pr"];
  productAcceptance: typeof PRODUCT_ACCEPTANCE_GAP;
}

/** Fixed capability representatives, selected once per deployment, not per model or preset. */
function scenarios(config: SmokeConfig): SmokeScenario[] {
  const general = leaseMinimum("general"),
    explore = leaseMinimum("explore"),
    review = leaseMinimum("review");
  return [
    {
      id: "answer",
      agent: "general",
      minutes: general,
      text: `What is 2 + 2? Answer only with the number. budget:${general}`,
    },
    {
      id: "workspace",
      agent: "explore",
      minutes: explore,
      text: `agent:explore budget:${explore} Read ${config.workspace.path} in ${config.repo} using the workspace. Reply only with its contents. Do not change files.`,
    },
    {
      id: "review",
      agent: "review",
      minutes: review,
      text: `agent:review budget:${review} Review https://github.com/${config.repo}/pull/${config.review.number} at head ${config.review.head}. Publish the review; do not change files or merge.`,
    },
  ];
}

/** Unknown acknowledgements stop admissions. Observation never retries, cancels or rolls back work. */
export async function runAgentSmoke(input: {
  config: unknown;
  expectedCommit?: string;
  thread: string;
  transport: SmokeTransport;
  onReceipt?: (receipt: AgentSmokeReceipt) => Promise<void>;
}): Promise<AgentSmokeReceipt> {
  const config = parseSmokeConfig(input.config);
  component.parse(input.thread);
  if (input.expectedCommit) sha.parse(input.expectedCommit);
  const selected = scenarios(config);
  const receipt: AgentSmokeReceipt = {
    version: 1,
    scope: "deployment-capability-smoke",
    capabilityOutcome: "incomplete",
    limits: {
      maxRuns: 3,
      scenarios: selected.map((s) => ({
        id: s.id,
        runMinutes: s.minutes,
        requestDeadlineMs: minutesToMs(s.minutes + 1),
      })),
      maxObservedUsd: config.maxObservedUsd,
    },
    observedUsd: 0,
    scenarios: selected.map((s) => ({
      id: s.id,
      outcome: "skipped",
      reason: "prior_scenario_unproven",
      thread: `${input.thread}-${s.id}`,
    })),
    liveGaps: ["private-question-fix-draft-pr"],
    productAcceptance: PRODUCT_ACCEPTANCE_GAP,
  };
  const save = async () => {
    await input.onReceipt?.(structuredClone(receipt));
  };
  await save();
  for (const [index, scenario] of selected.entries()) {
    const row = receipt.scenarios[index]!;
    row.outcome = "incomplete";
    row.reason = "build_unproven";
    try {
      const build = buildSchema.parse(await input.transport.health());
      receipt.build ??= build;
      if (
        (input.expectedCommit && build.commit !== input.expectedCommit) ||
        build.commit !== receipt.build.commit ||
        build.version !== receipt.build.version
      ) {
        await save();
        break;
      }
      row.reason = "request_ack_unknown";
      await save();
      const response = z
        .object({
          build: z.unknown().optional(),
          threadKey: z.unknown().optional(),
          run: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), status: z.string() }).optional(),
        })
        .parse(await input.transport.request(scenario, row.thread));
      // Save the original identity before monitoring; a missing read cannot erase an admitted effect.
      row.runId = response.run?.id;
      row.build = buildSchema.safeParse(response.build).data;
      row.reason = "run_record_unproven";
      await save();
      if (!response.run) {
        row.outcome = "failed";
        row.reason = "no_agent_run";
        break;
      }
      if (
        (response.run.status === "started" || response.threadKey !== undefined) &&
        response.threadKey !== `http:${config.channel}:${row.thread}`
      ) {
        row.reason = "run_identity_mismatch";
        break;
      }
      if (
        !row.build ||
        row.build.commit !== build.commit ||
        (build.version !== undefined && row.build.version !== build.version)
      ) {
        row.reason = "served_build_mismatch";
        break;
      }
      const run = runSchema.parse(await input.transport.readRun(response.run.id));
      row.userId = run.userId;
      row.threadKey = run.threadKey;
      row.parentInstanceId = run.parentInstanceId;
      row.idempotencyKey = run.idempotencyKey;
      if (run.cost?.usd !== undefined && run.cost.usd !== null) {
        row.observedUsd = run.cost.usd;
        receipt.observedUsd += run.cost.usd;
      }
      if (
        run.id !== row.runId ||
        run.userId !== `http:${config.subject}` ||
        run.channelId !== `http:${config.channel}` ||
        run.threadKey !== `http:${config.channel}:${row.thread}` ||
        run.agent !== scenario.agent ||
        (scenario.id !== "answer" && run.repo !== config.repo)
      ) {
        row.outcome = "failed";
        row.reason = "run_identity_mismatch";
        break;
      }
      if (run.profile.minutes !== scenario.minutes) {
        row.outcome = "failed";
        row.reason = "run_budget_mismatch";
        break;
      }
      if (scenario.id !== "answer" && !["repo-cold", "repo-resident"].includes(run.profile.machine)) {
        row.outcome = "failed";
        row.reason = "workspace_binding_unproven";
        break;
      }
      if (!run.finished || run.persisted !== true || run.provisional || run.restarting) break;
      if (!["started", "completed"].includes(response.run.status) || run.status !== "completed") {
        row.outcome = "failed";
        row.reason = "run_not_completed";
        break;
      }
      const answer = answerOutcomeOf(run.answerOutcome);
      const output = run.events.filter((e) => e.type === "answer").at(-1)?.text;
      if (
        answer?.ending !== "answered" ||
        answer.output === "absent" ||
        run.replyOk !== true ||
        !run.usage?.turns ||
        !output?.trim()
      ) {
        row.outcome = "failed";
        row.reason = "execution_output_unproven";
        break;
      }
      const text = unwrapUntrusted(output).trim();
      if (
        (scenario.id === "answer" && text !== "4") ||
        (scenario.id === "workspace" && text !== config.workspace.answer)
      ) {
        row.outcome = "failed";
        row.reason = "wrong_answer";
        break;
      }
      if (
        scenario.id !== "answer" &&
        !run.events.some(
          (event, i) =>
            event.type === "tool_result" &&
            event.ok === true &&
            !event.cut &&
            !event.infra &&
            event.callId &&
            (["read", "bash"].includes(event.tool ?? "") ||
              (scenario.id === "review" &&
                event.tool === "run_check" &&
                recordedReviewCheck(event, run, config.review.head))) &&
            run.events
              .slice(0, i)
              .some((call) => call.type === "tool_call" && call.tool === event.tool && call.callId === event.callId),
        )
      ) {
        row.outcome = "failed";
        row.reason = "workspace_execution_unproven";
        break;
      }
      if (scenario.id === "review") {
        const post = run.reviewPost;
        if (
          post?.posted !== true ||
          post.target?.repo !== config.repo ||
          post.target.number !== config.review.number ||
          post.head !== config.review.head ||
          run.reviewHead !== config.review.head
        ) {
          row.outcome = "failed";
          row.reason = "review_publication_unproven";
          break;
        }
        if (config.review.expectedVerdict && post.verdict !== config.review.expectedVerdict) {
          row.outcome = "failed";
          row.reason = "review_verdict_mismatch";
          break;
        }
        row.artifact = {
          repo: config.repo,
          number: post.target.number,
          head: post.head,
          ...(post.verdict ? { verdict: post.verdict } : {}),
        };
      }
      if (run.cost?.usd === undefined || run.cost.usd === null) {
        row.reason = "cost_unpriced";
        break;
      }
      if (receipt.observedUsd > config.maxObservedUsd) {
        row.outcome = "failed";
        row.reason = "observed_spend_exceeded";
        break;
      }
      const after = buildSchema.parse(await input.transport.health());
      if (after.commit !== build.commit || after.version !== build.version) {
        row.reason = "build_changed";
        break;
      }
      row.outcome = "passed";
      row.reason = "accepted";
      await save();
    } catch {
      // Preserve the last known phase and identity; remote diagnostic prose is not authority.
      break;
    }
  }
  receipt.capabilityOutcome = receipt.scenarios.some((s) => s.outcome === "failed")
    ? "failed"
    : receipt.scenarios.every((s) => s.outcome === "passed")
      ? "passed"
      : "incomplete";
  await save();
  return receipt;
}

/** Existing HTTP ingress for requests and MCP run reads; neither introduces a controller. */
export function agentSmokeTransport(input: {
  origin: string;
  healthUrl: string;
  token: string;
  config: unknown;
  fetch?: typeof globalThis.fetch;
}): SmokeTransport {
  assertSmokeOriginMatchesPlan(input.origin, input.healthUrl);
  if (!input.token) throw new Error("SMOKE_INGRESS_TOKEN is not set");
  const config = parseSmokeConfig(input.config);
  const fetch = input.fetch ?? globalThis.fetch;
  const boundedFetch: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error" });
  const mcp = new StreamableHttpMcpClient({
    url: new URL("/mcp", input.origin).href,
    headers: { authorization: `Bearer ${input.token}` },
    fetch: boundedFetch,
  });
  const deadlines = new Map<string, number>();
  return {
    async health() {
      const response = await boundedFetch(input.healthUrl, { signal: AbortSignal.timeout(minutesToMs(0.5)) });
      if (!response.ok) throw new Error("health_unavailable");
      const body = z.object({ ok: z.literal(true), build: buildSchema }).parse(await response.json());
      return body.build;
    },
    async request(scenario, thread) {
      const deadline = systemClock() + minutesToMs(scenario.minutes + 1);
      const response = await boundedFetch(new URL("/ingress", input.origin), {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: scenario.text, channel: config.channel, thread, async: true }),
        signal: AbortSignal.timeout(minutesToMs(scenario.minutes + 1)),
      });
      if (!response.ok) throw new Error("ingress_unavailable");
      const body = await response.json();
      if (response.status !== 202) return body;
      const admission = z
        .object({
          runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          threadKey: z.unknown().optional(),
          build: z.unknown().optional(),
        })
        .parse(body);
      deadlines.set(admission.runId, deadline);
      return {
        run: { id: admission.runId, status: "started" },
        build: admission.build,
        threadKey: admission.threadKey,
      };
    },
    async readRun(id) {
      const deadline = deadlines.get(id);
      if (deadline === undefined) throw new Error("admission_unproven");
      while (systemClock() < deadline) {
        const signal = AbortSignal.timeout(deadline - systemClock());
        const result = await mcp.callTool("runs_get", { id, include: "messages" }, { signal });
        if (result.isError || result.content.length !== 1) throw new Error("record_unavailable");
        const block = result.content[0];
        const prefix = "runs.get: ok\n";
        if (block?.type !== "text" || typeof block.text !== "string" || !block.text.startsWith(prefix))
          throw new Error("record_protocol_mismatch");
        const record: unknown = JSON.parse(block.text.slice(prefix.length));
        const state = z
          .object({
            id: z.literal(id),
            finished: z.boolean(),
            persisted: z.boolean().optional(),
            provisional: z.boolean().optional(),
            restarting: z.boolean().optional(),
          })
          .parse(record);
        if (state.finished && state.persisted === true && !state.provisional && !state.restarting) return record;
        const left = deadline - systemClock();
        if (left > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(AGENT_SMOKE_POLL_MS, left)));
      }
      throw new Error("run_deadline_exceeded");
    },
  };
}
