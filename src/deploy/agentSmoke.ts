import { z } from "zod";
import { checkExecutionReceiptSchema } from "../core/checkExecution.js";
import { sandboxRunTargetOf, type SandboxRunTarget, type SandboxRunObservation } from "./sandboxRunEvidence.js";
import {
  AGENT_SMOKE_POLL_MS,
  AGENT_SMOKE_REVIEW_MINUTES,
  PRESET_FLOORS,
  SECOND_MS,
  leaseMinimum,
  minutesToMs,
} from "../core/budgets.js";
import { answerOutcomeOf } from "../core/answerOutcome.js";
import { redactSecrets, stripAnsi } from "../core/redact.js";
import { unwrapUntrusted } from "../core/untrusted.js";
import { McpError } from "../mcp/types.js";
import { StreamableHttpMcpClient } from "../mcp/client.js";
import { assertSmokeOriginMatchesPlan } from "./ingressSmoke.js";
import { systemClock } from "../core/trace/clock.js";
import { parseModelRef } from "../core/provider.js";
import { RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import { causeOf, REFUSAL_CODES, type Refusal } from "../core/refusal.js";

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
    requireVouchedControls: z.boolean().optional(),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    model: z
      .string()
      .max(200)
      .regex(/^\S+$/)
      .refine((value) => {
        try {
          const ref = parseModelRef(value);
          return ref.provider.length > 0 && ref.model.length > 0;
        } catch {
          return false;
        }
      }, "model must be a full provider/model reference")
      .optional(),
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
        transport: z.enum(["http", "mcp"]).optional(),
        effort: z.enum(["medium", "high"]).optional(),
      })
      .strict(),
    maxObservedUsd: z.number().finite().positive().max(10),
  })
  .strict()
  .refine(
    (config) =>
      config.review.transport !== "mcp" || (config.model === "openai/gpt-6.1-sol" && config.review.effort === "high"),
    "MCP Review requires explicit openai/gpt-6.1-sol and high effort",
  );
type SmokeConfig = z.infer<typeof configSchema>;
export const parseSmokeConfig = (value: unknown): SmokeConfig => configSchema.parse(value);
const buildSchema = z.object({ commit: sha, version: z.string().min(1).max(80).optional() });
const admissionReceiptSchema = z.object({
  status: z.enum(["pending", "accepted", "rejected", "stale", "throttled"]),
  receiptId: z.string().min(1).max(2048),
  runId: z.string().optional(),
});
type SmokeBuild = z.infer<typeof buildSchema>;
const runSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channelId: z.string(),
  threadKey: z.string(),
  agent: z.string(),
  model: z.string().optional(),
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
  finishedAt: z.number().finite().optional(),
  sealedAt: z.number().finite().optional(),
  eventCount: z.number().int().nonnegative().optional(),
  storedEventCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
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
      kind: z.string().optional(),
      control: z.string().optional(),
      effort: z.string().optional(),
      card: z
        .object({
          ref: z.string(),
          levels: z.union([
            z.literal("unknown"),
            z.record(z.string(), z.union([z.literal("refused"), z.object({ word: z.string(), named: z.boolean() })])),
          ]),
          capField: z.string(),
          window: z.number().positive(),
          cache: z.enum(["automatic", "markers", "none", "unknown"]),
          provenance: z.object({ levels: z.string(), capField: z.string(), window: z.string() }),
        })
        .optional(),
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
  transport?: "http" | "mcp";
}
export interface SmokeTransport {
  health(): Promise<unknown>;
  readerReady?(): Promise<void>;
  request(
    scenario: SmokeScenario,
    thread: string,
    onIntake?: (intake: SmokeIntakeReceipt) => Promise<void>,
  ): Promise<unknown>;
  readRun(id: string, onRecord?: (record: unknown) => Promise<void>): Promise<unknown>;
}
interface SmokeCapture {
  body?: unknown;
  preview?: string;
  truncated: boolean;
}
interface SmokeIntakeReceipt {
  request: SmokeCapture & { method: "POST"; path: "/ingress" | "/mcp" };
  response?: SmokeCapture & { status?: number; format: "json" | "non-json" };
}
interface ScenarioReceipt {
  sandbox?: { first?: SandboxRunObservation; ended?: SandboxRunObservation; observationError?: "unavailable" };
  id: SmokeScenario["id"];
  outcome: Outcome;
  reason: string;
  thread: string;
  runId?: string;
  transport?: "http" | "mcp";
  requestKey?: string;
  receiptId?: string;
  admissionStatus?: string;
  refusal?: Pick<Refusal, "code" | "cause">;
  requestedEffort?: string;
  actualEffort?: string;
  build?: SmokeBuild;
  userId?: string;
  threadKey?: string;
  parentInstanceId?: string;
  idempotencyKey?: string;
  observedUsd?: number;
  requestedModel?: string;
  actualModel?: string;
  modelControls?: { effort: string; capField: string; window: number; cache: string };
  artifact?: { repo: string; number: number; head: string; verdict?: "approve" | "request_changes" };
  outputReadback?: {
    kind: "native-persisted-run";
    receiptId: string;
    runId: string;
    sealedAt: number;
    eventCount: number;
    utf8Bytes: number;
  };
  evidence?: { identityVerified: boolean; record: unknown; unverifiedObservation?: unknown };
  failedChecks?: string[];
  readRetry?: Pick<SmokeObservationError, "code" | "operation">;
  observationError?: SmokeObservationError;
  intake?: SmokeIntakeReceipt;
}

interface SmokeObservationError {
  code: string;
  operation?: "runs_list" | "runs_get";
  rpcCode?: number;
  fields?: Array<{ path: string; code: string }>;
  http?: { status: number; authChallenge: boolean };
}

export class SmokeReaderError extends Error {
  constructor(readonly observation: SmokeObservationError) {
    super(observation.code);
  }
}

/** Intake diagnostics are bounded after redaction; HTML and headers are never retained. */
function captureIntake(
  value: unknown,
  token: string,
  identity?: { userId: string; threadKey: string; repo: string },
): SmokeCapture {
  const sanitize = (item: unknown, depth: number): unknown => {
    if (depth > 16) return "«redacted-depth-limit»";
    if (typeof item === "string") {
      // Replies can themselves contain JSON, including another encoded string.
      // Redact decoded values before escaping them for the artifact.
      try {
        return JSON.stringify(sanitize(JSON.parse(item), depth + 1));
      } catch {
        // A reply may prefix or suffix JSON with prose. Inspect each structured
        // fragment as data; a partial fragment is excluded rather than guessed.
        let text = "";
        let cursor = 0;
        for (let start = 0; start < item.length; start++) {
          const first = item[start];
          if (first !== "{" && first !== "[" && first !== '"') continue;
          const closes = first === "{" ? ["}"] : first === "[" ? ["]"] : [];
          let quoted = first === '"';
          let escaped = false;
          let end = start + 1;
          for (; end < item.length; end++) {
            const char = item[end];
            if (quoted) {
              if (escaped) escaped = false;
              else if (char === "\\") escaped = true;
              else if (char === '"') {
                quoted = false;
                if (!closes.length) {
                  end++;
                  break;
                }
              }
            } else if (char === '"') quoted = true;
            else if (char === "{" || char === "[") closes.push(char === "{" ? "}" : "]");
            else if (char === "}" || char === "]") {
              const expected = closes.pop();
              if (char !== expected || !closes.length) {
                end++;
                break;
              }
            }
          }
          text += item.slice(cursor, start);
          try {
            text += JSON.stringify(sanitize(JSON.parse(item.slice(start, end)), depth + 1));
          } catch {
            text += "«redacted-json-fragment»";
          }
          cursor = end;
          start = end - 1;
        }
        text += item.slice(cursor);
        return redactSecrets(stripAnsi(text).replaceAll(token, "«redacted»")).replace(
          /(https?:\/\/[^\s"<>?#]+)[?#][^\s"<>]*/g,
          "$1?«redacted»",
        );
      }
    }
    if (Array.isArray(item)) return item.map((entry) => sanitize(entry, depth + 1));
    if (item !== null && typeof item === "object") {
      if (
        identity &&
        Object.entries(identity).some(([key, expected]) => key in item && Reflect.get(item, key) !== expected)
      )
        return { excluded: "foreign_identity" };
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => {
          // Reuse the shared secret-name policy for whole JSON field values.
          const assignment = `${key}: "capture-value"`;
          return [
            sanitize(key, depth + 1),
            /^(?:code|state|authorization|cookie|set-cookie)$/i.test(key) ||
            redactSecrets(assignment).endsWith('"«redacted»"')
              ? "«redacted»"
              : sanitize(entry, depth + 1),
          ];
        }),
      );
    }
    return item;
  };
  const text = JSON.stringify(sanitize(value, 0));
  const maxChars = 16_000;
  if (text.length > maxChars) return { preview: text.slice(0, maxChars), truncated: true };
  try {
    return { body: JSON.parse(text), truncated: false };
  } catch {
    return { preview: text, truncated: false };
  }
}

/** Preserve JSON structure and diagnostic text, without credentials from the transport or log. */
function safeSmokeRecord(value: unknown, token?: string): unknown {
  if (typeof value === "string") return redactSecrets(token ? value.replaceAll(token, "«redacted»") : value);
  if (Array.isArray(value)) return value.map((item) => safeSmokeRecord(item, token));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeSmokeRecord(item, token)]));
  return value;
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
  slackConnection?: { required: true; connected?: boolean; checks: number };
  scenarios: ScenarioReceipt[];
  liveGaps: ["private-question-fix-draft-pr"];
  productAcceptance: typeof PRODUCT_ACCEPTANCE_GAP;
}

/** A phase change can be printed without exposing the retained request or output. */
export function smokeProgress(receipt: AgentSmokeReceipt) {
  const row = receipt.scenarios
    .slice()
    .reverse()
    .find((scenario) => scenario.outcome !== "skipped");
  if (!row) return;
  const safeId = (id: string) => redactSecrets(stripAnsi(id)).slice(0, 200);
  return {
    event: "smoke.progress",
    scenario: row.id,
    phase: row.reason,
    outcome: row.outcome,
    requestDeadlineMs: receipt.limits.scenarios.find((scenario) => scenario.id === row.id)!.requestDeadlineMs,
    ...(row.runId ? { runId: safeId(row.runId) } : {}),
    ...(row.receiptId ? { receiptId: safeId(row.receiptId) } : {}),
    ...(row.refusal ? { refusal: row.refusal } : {}),
    ...(row.observationError
      ? {
          observationError: {
            code: row.observationError.code,
            ...(row.observationError.operation ? { operation: row.observationError.operation } : {}),
            ...(row.observationError.rpcCode !== undefined ? { rpcCode: row.observationError.rpcCode } : {}),
            ...(row.observationError.http ? { http: row.observationError.http } : {}),
          },
        }
      : {}),
  };
}

/** Fixed capability representatives, selected once per deployment, not per model or preset. */
function scenarios(config: SmokeConfig): SmokeScenario[] {
  const general = leaseMinimum("general"),
    explore = PRESET_FLOORS.explore,
    review = AGENT_SMOKE_REVIEW_MINUTES;
  const selected: SmokeScenario[] = [
    {
      id: "answer",
      agent: "general",
      minutes: general,
      text: `agent:general What is 2 + 2? Answer only with the number. budget:${general}`,
    },
    {
      id: "workspace",
      agent: "explore",
      minutes: explore,
      text: `agent:explore budget:${explore} Read ${config.workspace.path} in ${config.repo} using the workspace. Reply only with its contents. Do not change files.`,
    },
    {
      id: "review",
      transport: config.review.transport ?? "http",
      agent: "review",
      minutes: review,
      text: `agent:review budget:${review} Review https://github.com/${config.repo}/pull/${config.review.number} at head ${config.review.head}. Publish the review; do not change files or merge.`,
    },
  ];
  return selected.map((s) => ({
    ...s,
    text: `${s.text}${config.model ? ` model:${config.model}` : ""}${s.id === "review" && config.review.effort ? ` effort:${config.review.effort}` : ""}`,
  }));
}

/** Unknown acknowledgements stop admissions. Observation never retries, cancels or rolls back work. */
export async function runAgentSmoke(input: {
  config: unknown;
  expectedCommit?: string;
  requireSlackConnection?: boolean;
  thread: string;
  transport: SmokeTransport;
  onReceipt?: (receipt: AgentSmokeReceipt) => Promise<void>;
  observeSandbox?: (target: SandboxRunTarget) => Promise<SandboxRunObservation>;
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
    ...(input.requireSlackConnection ? { slackConnection: { required: true as const, checks: 0 } } : {}),
    scenarios: selected.map((s) => ({
      id: s.id,
      outcome: "skipped",
      reason: "prior_scenario_unproven",
      thread: `${input.thread}-${s.id}`,
      transport: s.transport ?? "http",
      ...(s.id === "review" && config.review.effort ? { requestedEffort: config.review.effort } : {}),
      ...(config.model ? { requestedModel: config.model } : {}),
    })),
    liveGaps: ["private-question-fix-draft-pr"],
    productAcceptance: PRODUCT_ACCEPTANCE_GAP,
  };
  const save = async () => {
    await input.onReceipt?.(structuredClone(receipt));
  };
  const readHealth = async () => {
    const health = await input.transport.health();
    const build = buildSchema.parse(health);
    if (receipt.slackConnection) {
      const slack = z.object({ slackConnected: z.boolean().optional() }).safeParse(health);
      const connected = slack.success ? slack.data.slackConnected : undefined;
      receipt.slackConnection.connected = connected;
      receipt.slackConnection.checks++;
      if (connected !== true) return undefined;
    }
    return build;
  };
  await save();
  for (const [index, scenario] of selected.entries()) {
    const row = receipt.scenarios[index]!;
    row.outcome = "incomplete";
    row.reason = "build_unproven";
    await save();
    try {
      const build = await readHealth();
      if (!build) {
        row.reason = "slack_connection_unproven";
        break;
      }
      receipt.build ??= build;
      if (
        (input.expectedCommit && build.commit !== input.expectedCommit) ||
        build.commit !== receipt.build.commit ||
        build.version !== receipt.build.version
      ) {
        await save();
        break;
      }
      row.reason = "reader_unproven";
      await save();
      await input.transport.readerReady?.();
      row.reason = "request_ack_unknown";
      row.requestKey = row.thread;
      await save();
      const raw = await input.transport.request(scenario, row.thread, async (intake) => {
        row.intake = intake;
        await save();
      });
      const object = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const known = admissionReceiptSchema.safeParse(object.admission);
      if (known.success) {
        row.receiptId = known.data.receiptId;
        row.admissionStatus = known.data.status;
        const owner = z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .safeParse(known.data.runId);
        if (owner.success) row.runId = owner.data;
      }
      const parsedRun = z
        .object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), status: z.string() })
        .safeParse(object.run);
      if (parsedRun.success && row.runId === undefined) row.runId = parsedRun.data.id;
      await save();
      const response = z
        .object({
          build: z.unknown().optional(),
          threadKey: z.unknown().optional(),
          accessError: z.string().optional(),
          run: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), status: z.string() }).optional(),
        })
        .parse(raw);
      // Save the original identity before monitoring; a missing read cannot erase an admitted effect.
      row.runId ??= response.run?.id;
      row.build = buildSchema.safeParse(response.build).data;
      row.reason = "run_record_unproven";
      await save();
      if (known.success && !["pending", "accepted"].includes(known.data.status)) {
        row.reason = "admission_refused";
        break;
      }
      if (!response.run) {
        if (known.success && ["pending", "accepted"].includes(known.data.status)) row.reason = "original_owner_pending";
        else if (scenario.transport === "mcp" && (response.accessError || object.admission))
          row.reason = "mcp_access_unproven";
        else {
          row.outcome = "failed";
          row.reason = "no_agent_run";
        }
        break;
      }
      if (known.success && known.data.runId !== response.run.id) {
        row.reason = "original_owner_mismatch";
        break;
      }
      const source = scenario.transport ?? "http";
      if (
        (response.run.status === "started" || response.threadKey !== undefined) &&
        response.threadKey !== `${source}:${config.channel}:${row.thread}`
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
      const sandboxObserved = new Set<"first" | "ended">();
      const retainRun = async (value: unknown) => {
        const raw = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const identityVerified =
          raw.id === row.runId &&
          raw.userId === `${source}:${config.subject}` &&
          raw.channelId === `${source}:${config.channel}` &&
          raw.threadKey === `${source}:${config.channel}:${row.thread}` &&
          raw.agent === scenario.agent &&
          (scenario.id === "answer" || raw.repo === config.repo);
        // An observation from another actor/thread is diagnostic, not authority to expose its content.
        const record = identityVerified
          ? raw
          : Object.fromEntries(
              [
                "id",
                "userId",
                "channelId",
                "threadKey",
                "agent",
                "repo",
                "finished",
                "persisted",
                "status",
                "provisional",
                "restarting",
                "eventCount",
                "storedEventCount",
                "truncated",
              ]
                .filter((key) => raw[key] !== undefined && (raw[key] === null || typeof raw[key] !== "object"))
                .map((key) => [key, raw[key]]),
            );
        if (!identityVerified && row.evidence?.identityVerified) {
          row.evidence.unverifiedObservation = safeSmokeRecord(record);
        } else {
          row.evidence = { identityVerified, record: safeSmokeRecord(record) };
        }
        // Save the run before auxiliary provider reads. Observation failure
        // must never erase the original identity or turn acceptance green.
        await save();
        if (identityVerified && scenario.id !== "answer" && input.observeSandbox) {
          const phase = raw.finished === true ? "ended" : "first";
          row.sandbox ??= {};
          if (!sandboxObserved.has(phase)) {
            const target = sandboxRunTargetOf({ threadKey: String(raw.threadKey), events: raw.events });
            if (
              phase === "ended" ||
              (target.backend !== null && (target.backend !== "sandbox" || target.sandboxKey !== null))
            )
              sandboxObserved.add(phase);
            try {
              row.sandbox[phase] = await input.observeSandbox(target);
            } catch {
              row.sandbox.observationError = "unavailable";
            }
            await save();
          }
        }
      };
      let originalRecord: unknown;
      try {
        originalRecord = await input.transport.readRun(response.run.id, retainRun);
      } catch (error) {
        const observation = error instanceof SmokeReaderError ? error.observation : null;
        if (
          source !== "http" ||
          !known.success ||
          known.data.status !== "accepted" ||
          !observation ||
          !["runs_list", "runs_get"].includes(observation.operation ?? "") ||
          !["mcp_transport_failed", "mcp_timeout"].includes(observation.code)
        )
          throw error;
        // The admission may already be running. Retry only this read of its
        // original ID; never send a second request or extend its deadline.
        row.readRetry = { code: observation.code, operation: observation.operation };
        await save();
        await new Promise((resolve) => setTimeout(resolve, SECOND_MS));
        originalRecord = await input.transport.readRun(response.run.id, retainRun);
      }
      await retainRun(originalRecord);
      const decision = z
        .object({
          id: z.literal(response.run.id),
          userId: z.literal(`${source}:${config.subject}`),
          channelId: z.literal(`${source}:${config.channel}`),
          threadKey: z.literal(`${source}:${config.channel}:${row.thread}`),
          repo: z.literal(config.repo).optional(),
          agent: z.literal("door"),
          finished: z.literal(true),
          persisted: z.literal(true),
          provisional: z.literal(false).optional(),
          restarting: z.literal(false).optional(),
          events: z.array(z.unknown()),
        })
        .safeParse(originalRecord);
      if (decision.success) {
        row.outcome = "failed";
        row.reason = "no_agent_run";
        for (const event of decision.data.events) {
          const refusal = z
            .object({
              type: z.literal("refusal"),
              code: z.enum(REFUSAL_CODES),
              cause: z.enum(["request", "policy", "system"]),
            })
            .safeParse(event);
          if (refusal.success && refusal.data.cause === causeOf(refusal.data.code)) {
            row.refusal = { code: refusal.data.code, cause: refusal.data.cause };
            row.reason = "admission_refused";
            break;
          }
        }
        break;
      }
      const run = runSchema.parse(originalRecord);
      row.userId = run.userId;
      row.threadKey = run.threadKey;
      row.parentInstanceId = run.parentInstanceId;
      row.idempotencyKey = run.idempotencyKey;
      if (run.model !== undefined) row.actualModel = run.model;
      if (run.cost?.usd !== undefined && run.cost.usd !== null) {
        row.observedUsd = run.cost.usd;
        receipt.observedUsd += run.cost.usd;
      }
      if (
        run.id !== row.runId ||
        run.userId !== `${source}:${config.subject}` ||
        run.channelId !== `${source}:${config.channel}` ||
        run.threadKey !== `${source}:${config.channel}:${row.thread}` ||
        run.agent !== scenario.agent ||
        (scenario.id !== "answer" && run.repo !== config.repo)
      ) {
        row.outcome = "failed";
        row.reason = "run_identity_mismatch";
        break;
      }
      if (scenario.id === "review" && config.review.effort) {
        row.actualEffort = run.events
          .slice()
          .reverse()
          .find((event) => event.type === "run_meta")?.effort;
        if (row.actualEffort !== config.review.effort) {
          row.outcome = "failed";
          row.reason = "run_effort_mismatch";
          break;
        }
      }
      if (run.profile.minutes !== scenario.minutes) {
        row.outcome = "failed";
        row.reason = "run_budget_mismatch";
        break;
      }
      if (config.model && run.model !== config.model) {
        row.outcome = "failed";
        row.reason = "run_model_mismatch";
        break;
      }
      if (scenario.id !== "answer" && !["repo-cold", "repo-resident"].includes(run.profile.machine)) {
        row.outcome = "failed";
        row.reason = "workspace_binding_unproven";
        break;
      }
      if (!run.finished || run.persisted !== true || run.provisional || run.restarting) break;
      if (config.requireVouchedControls) {
        const meta = run.events.find((event) => event.type === "run_meta");
        const card = meta?.card;
        const level = card?.levels !== "unknown" && meta?.effort ? card?.levels[meta.effort] : undefined;
        if (
          !card ||
          card.ref !== run.model ||
          !meta?.effort ||
          !level ||
          level === "refused" ||
          !level.named ||
          [card.provenance.levels, card.provenance.capField, card.provenance.window].some(
            (source) => !["registry", "operator"].includes(source),
          ) ||
          card.cache === "unknown" ||
          run.events.some((event) => event.type === "run_note" && event.kind === "control_degraded")
        ) {
          row.outcome = "failed";
          row.reason = "model_controls_unproven";
          break;
        }
        row.modelControls = { effort: meta.effort, capField: card.capField, window: card.window, cache: card.cache };
      }
      if (!["started", "completed"].includes(response.run.status) || run.status !== "completed") {
        row.outcome = "failed";
        row.reason = "run_not_completed";
        break;
      }
      const answer = answerOutcomeOf(run.answerOutcome);
      const output = run.events.filter((e) => e.type === "answer").at(-1)?.text;
      // Native async calls return an admitted run handle. Their result is the
      // authenticated saved run, separate from physical channel reply delivery.
      const nativeAsync = Object.hasOwn(object, "admission");
      const outputChecks = {
        "answerOutcome.ending": answer?.ending === "answered",
        "answerOutcome.output": answer?.output !== "absent",
        ...(nativeAsync
          ? {
              "admission.accepted": known.success && known.data.status === "accepted",
              "admission.started": response.run.status === "started",
              "run.sealedAt":
                run.sealedAt !== undefined && run.finishedAt !== undefined && run.sealedAt >= run.finishedAt,
              "events.complete":
                run.eventCount !== undefined &&
                run.eventCount > 0 &&
                run.events.length === run.eventCount &&
                (run.storedEventCount === undefined || run.storedEventCount === run.eventCount) &&
                !run.truncated,
            }
          : { replyOk: run.replyOk === true }),
        "usage.turns": Boolean(run.usage?.turns),
        "events.answer.text": Boolean(output?.trim()),
      };
      const failedChecks = Object.entries(outputChecks)
        .filter(([, passed]) => !passed)
        .map(([field]) => field);
      if (failedChecks.length) {
        row.failedChecks = failedChecks;
        row.outcome = "failed";
        row.reason = "execution_output_unproven";
        break;
      }
      const text = unwrapUntrusted(output ?? "").trim();
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
      const after = await readHealth();
      if (!after) {
        row.reason = "slack_connection_unproven";
        break;
      }
      if (after.commit !== build.commit || after.version !== build.version) {
        row.reason = "build_changed";
        break;
      }
      if (nativeAsync && known.success && run.sealedAt !== undefined && run.eventCount !== undefined) {
        row.outputReadback = {
          kind: "native-persisted-run",
          receiptId: known.data.receiptId,
          runId: run.id,
          sealedAt: run.sealedAt,
          eventCount: run.eventCount,
          utf8Bytes: new TextEncoder().encode(text).byteLength,
        };
      }
      row.outcome = "passed";
      row.reason = "accepted";
      await save();
    } catch (error) {
      // Preserve the last known phase and identity; remote diagnostic prose is not authority.
      const knownErrors = [
        "health_unavailable",
        "ingress_unavailable",
        "admission_unproven",
        "record_unavailable",
        "record_protocol_mismatch",
        "run_deadline_exceeded",
      ];
      row.observationError =
        error instanceof SmokeReaderError
          ? error.observation
          : error instanceof z.ZodError
            ? {
                code: "record_invalid",
                fields: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
              }
            : {
                code:
                  error instanceof Error && knownErrors.includes(error.message) ? error.message : "observation_failed",
              };
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
  access?: { clientId?: string; clientSecret?: string };
  fetch?: typeof globalThis.fetch;
}): SmokeTransport {
  assertSmokeOriginMatchesPlan(input.origin, input.healthUrl);
  if (!input.token) throw new Error("SMOKE_INGRESS_TOKEN is not set");
  const clientId = input.access?.clientId;
  const clientSecret = input.access?.clientSecret;
  if (clientId?.trim() && !clientSecret?.trim()) throw new Error("SMOKE_ACCESS_CLIENT_SECRET is not set");
  if (clientSecret?.trim() && !clientId?.trim()) throw new Error("SMOKE_ACCESS_CLIENT_ID is not set");
  const config = parseSmokeConfig(input.config);
  const fetch = input.fetch ?? globalThis.fetch;
  const boundedFetch: typeof fetch = (url, init) => fetch(url, { ...init, redirect: "error" });
  const mcpUrl = new URL("/mcp", input.origin).href;
  let http: SmokeObservationError["http"];
  const mcp = new StreamableHttpMcpClient({
    url: mcpUrl,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(clientId?.trim() && clientSecret?.trim()
        ? { "cf-access-client-id": clientId, "cf-access-client-secret": clientSecret }
        : {}),
    },
    fetch: async (url, init) => {
      if (url !== mcpUrl) throw new Error("mcp_destination_refused");
      const response = await fetch(url, { ...init, redirect: "manual" });
      // Only closed facts are retained. Bodies, challenge values and headers
      // can contain credentials or untrusted prose and never enter the receipt.
      http = { status: response.status, authChallenge: response.headers.has("www-authenticate") };
      return response;
    },
  });
  const readerCall = async (name: "runs_list" | "runs_get", args: Record<string, unknown>, signal: AbortSignal) => {
    http = undefined;
    try {
      return await mcp.callTool(name, args, { signal });
    } catch (error) {
      // The asynchronous fetch callback updates this closure after the reset.
      const observedHttp = http as SmokeObservationError["http"];
      const code =
        observedHttp?.status === 401 ||
        (observedHttp && observedHttp.status >= 300 && observedHttp.status < 400 && observedHttp.authChallenge)
          ? "mcp_auth_required"
          : observedHttp?.status === 403
            ? "mcp_access_denied"
            : observedHttp && observedHttp.status >= 300
              ? "mcp_http_failed"
              : error instanceof McpError && error.code === -32001
                ? "mcp_read_unauthorized"
                : error instanceof McpError && typeof error.code === "number"
                  ? "mcp_rpc_failed"
                  : error instanceof McpError && error.code === "timeout"
                    ? "mcp_timeout"
                    : error instanceof McpError && error.code === "protocol"
                      ? "mcp_protocol_mismatch"
                      : "mcp_transport_failed";
      throw new SmokeReaderError({
        code,
        operation: name,
        ...(error instanceof McpError && typeof error.code === "number" && Number.isSafeInteger(error.code)
          ? { rpcCode: error.code }
          : {}),
        ...(observedHttp ? { http: observedHttp } : {}),
      });
    }
  };
  const deadlines = new Map<string, number>();
  const httpOwners = new Map<string, string>();
  const waitForHttpOwner = async (id: string, threadKey: string, deadline: number) => {
    // Native admission can precede the readable Core row. Observe authorized
    // metadata before the first point read; masked missing/denied reads are never retried.
    while (systemClock() < deadline) {
      const result = await readerCall(
        "runs_list",
        {
          status: "all",
          channel: `http:${config.channel}`,
          thread: threadKey,
          limit: RUN_LIST_MAX_LIMIT,
          readUser: `http:${config.subject}`,
          readRepo: config.repo,
        },
        AbortSignal.timeout(deadline - systemClock()),
      );
      if (result.isError) throw new SmokeReaderError({ code: "mcp_read_refused", ...(http ? { http } : {}) });
      try {
        const block = result.content[0];
        const prefix = "runs.list: ok\n";
        if (
          result.content.length !== 1 ||
          block?.type !== "text" ||
          typeof block.text !== "string" ||
          !block.text.startsWith(prefix)
        )
          throw new Error("invalid reader result");
        const page = z
          .object({
            storeUnavailable: z.boolean().optional(),
            ledgerUnavailable: z.boolean().optional(),
            readScope: z.object({
              channelId: z.literal(`http:${config.channel}`),
              userId: z.literal(`http:${config.subject}`),
              repo: z.literal(config.repo),
              allowed: z.boolean(),
            }),
            runs: z
              .array(
                z.object({
                  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
                  channelId: z.literal(`http:${config.channel}`),
                  userId: z.literal(`http:${config.subject}`),
                  threadKey: z.literal(threadKey),
                }),
              )
              .max(RUN_LIST_MAX_LIMIT),
            nextBefore: z.object({ finishedAt: z.number().int().nonnegative(), id: z.string().min(1) }).nullish(),
          })
          .parse(JSON.parse(block.text.slice(prefix.length)));
        if (page.storeUnavailable || page.ledgerUnavailable)
          throw new SmokeReaderError({ code: "mcp_reader_unavailable", ...(http ? { http } : {}) });
        if (!page.readScope.allowed)
          throw new SmokeReaderError({ code: "mcp_read_scope_denied", ...(http ? { http } : {}) });
        if (page.runs.some((run) => run.id === id)) return;
        // A partial page is not evidence of absence. Stop rather than declare
        // readiness or restart an unbounded scan of an unexpectedly busy thread.
        if (page.nextBefore)
          throw new SmokeReaderError({ code: "mcp_run_listing_incomplete", ...(http ? { http } : {}) });
      } catch (error) {
        if (error instanceof SmokeReaderError) throw error;
        throw new SmokeReaderError({ code: "mcp_protocol_mismatch", ...(http ? { http } : {}) });
      }
      const left = deadline - systemClock();
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(AGENT_SMOKE_POLL_MS, left)));
    }
    throw new Error("run_deadline_exceeded");
  };
  return {
    async health() {
      const response = await boundedFetch(input.healthUrl, { signal: AbortSignal.timeout(minutesToMs(0.5)) });
      if (!response.ok) throw new Error("health_unavailable");
      const body = z
        .object({ ok: z.literal(true), build: buildSchema, slack: z.object({ connected: z.boolean() }).optional() })
        .parse(await response.json());
      return { ...body.build, ...(body.slack ? { slackConnected: body.slack.connected } : {}) };
    },
    async readerReady() {
      const result = await readerCall(
        "runs_list",
        {
          channel: `http:${config.channel}`,
          status: "all",
          limit: 1,
          readUser: `http:${config.subject}`,
          readRepo: config.repo,
        },
        AbortSignal.timeout(minutesToMs(0.5)),
      );
      if (result.isError) throw new SmokeReaderError({ code: "mcp_read_refused", ...(http ? { http } : {}) });
      const block = result.content[0];
      const prefix = "runs.list: ok\n";
      try {
        if (
          result.content.length !== 1 ||
          block?.type !== "text" ||
          typeof block.text !== "string" ||
          !block.text.startsWith(prefix)
        )
          throw new Error("invalid reader result");
        const page = z
          .object({
            storeUnavailable: z.boolean().optional(),
            ledgerUnavailable: z.boolean().optional(),
            readScope: z.unknown().optional(),
            runs: z
              .array(
                z.object({
                  channelId: z.literal(`http:${config.channel}`),
                  userId: z.literal(`http:${config.subject}`),
                }),
              )
              .max(1),
          })
          .parse(JSON.parse(block.text.slice(prefix.length)));
        if (page.storeUnavailable || page.ledgerUnavailable)
          throw new SmokeReaderError({ code: "mcp_reader_unavailable", ...(http ? { http } : {}) });
        const scope = z
          .object({
            channelId: z.literal(`http:${config.channel}`),
            userId: z.literal(`http:${config.subject}`),
            repo: z.literal(config.repo),
            allowed: z.boolean(),
          })
          .parse(page.readScope);
        if (!scope.allowed) throw new SmokeReaderError({ code: "mcp_read_scope_denied", ...(http ? { http } : {}) });
      } catch (error) {
        if (error instanceof SmokeReaderError) throw error;
        throw new SmokeReaderError({ code: "mcp_protocol_mismatch", ...(http ? { http } : {}) });
      }
    },
    async request(scenario, thread, onIntake) {
      const deadline = systemClock() + minutesToMs(scenario.minutes + 1);
      const args = { text: scenario.text, channel: config.channel, thread, async: true, idempotencyKey: thread };
      const signal = AbortSignal.timeout(minutesToMs(scenario.minutes + 1));
      const source = scenario.transport ?? "http";
      const intake: SmokeIntakeReceipt = {
        request: {
          method: "POST",
          path: source === "mcp" ? "/mcp" : "/ingress",
          ...captureIntake(source === "mcp" ? { name: "dispatch", arguments: args } : args, input.token),
        },
      };
      await onIntake?.(intake);
      let body: unknown;
      if (scenario.transport === "mcp") {
        try {
          const result = await mcp.callTool("dispatch", args, { signal });
          body = result.structuredContent;
          if (body !== undefined) {
            intake.response = {
              format: "json",
              ...captureIntake(body, input.token, {
                userId: `mcp:${config.subject}`,
                threadKey: `mcp:${config.channel}:${thread}`,
                repo: config.repo,
              }),
            };
            await onIntake?.(intake);
          }
          if (result.isError && body === undefined) return { accessError: "mcp_access_unproven" };
        } catch (error) {
          if (error instanceof McpError && error.code === -32001) return { accessError: "mcp_access_unproven" };
          throw error;
        }
      } else {
        const response = await boundedFetch(new URL("/ingress", input.origin), {
          method: "POST",
          headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
          body: JSON.stringify(args),
          signal,
        });
        try {
          body = await response.json();
        } catch {
          intake.response = { status: response.status, format: "non-json", truncated: false };
          await onIntake?.(intake);
          throw new Error("ingress_unavailable");
        }
        intake.response = {
          status: response.status,
          format: "json",
          ...captureIntake(body, input.token, {
            userId: `http:${config.subject}`,
            threadKey: `http:${config.channel}:${thread}`,
            repo: config.repo,
          }),
        };
        await onIntake?.(intake);
        if (!response.ok && !(body && typeof body === "object" && "admission" in body))
          throw new Error("ingress_unavailable");
        if (response.status !== 202) return body;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return body;
      const response = body as Record<string, unknown>;
      const admission = z.object({ runId: z.unknown().optional() }).safeParse(response.admission);
      const assigned = z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .safeParse(response.runId ?? (admission.success ? admission.data.runId : undefined));
      if (!assigned.success) {
        // HTTP202 may already have admitted work. An unusable owner cannot
        // prove no agent ran; retain its captured response and stop.
        if (source === "http" && !admissionReceiptSchema.safeParse(response.admission).success)
          throw new Error("admission_unproven");
        return response;
      }
      deadlines.set(assigned.data, deadline);
      const accepted = admissionReceiptSchema.safeParse(response.admission);
      const expectedThread = `http:${config.channel}:${thread}`;
      if (
        source === "http" &&
        accepted.success &&
        accepted.data.status === "accepted" &&
        accepted.data.runId === assigned.data &&
        response.threadKey === expectedThread
      )
        httpOwners.set(assigned.data, expectedThread);
      return {
        ...(response.admission === undefined ? {} : { admission: response.admission }),
        run: { id: assigned.data, status: "started" },
        build: response.build,
        threadKey: response.threadKey,
      };
    },
    async readRun(id, onRecord) {
      const deadline = deadlines.get(id);
      if (deadline === undefined) throw new Error("admission_unproven");
      const threadKey = httpOwners.get(id);
      if (threadKey) {
        await waitForHttpOwner(id, threadKey, deadline);
        httpOwners.delete(id);
      }
      while (systemClock() < deadline) {
        const signal = AbortSignal.timeout(deadline - systemClock());
        const result = await readerCall("runs_get", { id, include: "messages" }, signal);
        if (result.isError || result.content.length !== 1) throw new Error("record_unavailable");
        const block = result.content[0];
        const prefix = "runs.get: ok\n";
        if (block?.type !== "text" || typeof block.text !== "string" || !block.text.startsWith(prefix))
          throw new Error("record_protocol_mismatch");
        const record: unknown = JSON.parse(block.text.slice(prefix.length));
        // runs_get include:messages supplies the complete retained event history, not an event page.
        // Save each original observation before parsing or the next read can fail.
        const safeRecord = safeSmokeRecord(record, input.token);
        await onRecord?.(safeRecord);
        const state = z
          .object({
            id: z.literal(id),
            finished: z.boolean(),
            persisted: z.boolean().optional(),
            provisional: z.boolean().optional(),
            restarting: z.boolean().optional(),
          })
          .parse(record);
        if (state.finished && state.persisted === true && !state.provisional && !state.restarting) return safeRecord;
        const left = deadline - systemClock();
        if (left > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(AGENT_SMOKE_POLL_MS, left)));
      }
      throw new Error("run_deadline_exceeded");
    },
  };
}
