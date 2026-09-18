// The extension pi loads for `load:pi` (docs/reference/specs/load-harness.md,
// the pi driver items). pi starts it with `-e <this file>` and every other
// discovery off, so it is the whole tool surface the harness adds: the two
// terminal tools a Switchboard child ends with, and a `tool_call` hook that
// reports every call the model asked for. It imports nothing — pi's own loader
// (jiti) runs it as written, and its tool schemas are plain JSON Schema, which
// pi validates without TypeBox (packages/ai/src/utils/validation.ts,
// `validateToolArguments`). Because pi holds the model to the schema it is
// served, the two definitions are the bot's own — the native table's
// description and schema (src/tools/submit.ts), transcribed since nothing
// can be imported here and held equal by piExtension.test.ts — so the model
// is asked for exactly what the production relay asks it for: a verdict whose
// `head` is required, a description whose every field is named. Its one
// channel back to the driver is pi's `notify` UI request: in RPC mode that is
// written to stdout as an `extension_ui_request` with `method: "notify"`, so
// the notice rides the same JSONL stream as pi's events and the driver pairs
// it with them by `toolCallId`.

/** Every notice starts with this so the driver can tell the harness's
 *  notifies from an extension's ordinary ones (there are none here, but pi's
 *  own code may notify). */
export const HOOK_PREFIX = "switchboard-pi ";

export type HookNoticePayload =
  | { kind: "session_start"; mode: string | undefined; hasUI: boolean | undefined }
  | { kind: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "submit_pr_description"; params: Record<string, unknown> }
  | { kind: "submit_verdict"; params: Record<string, unknown> };

/** The slice of pi's `ExtensionContext.ui` this extension uses. */
export interface PiNotifyUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface PiExtensionContext {
  ui: PiNotifyUi;
  mode?: string;
  hasUI?: boolean;
}

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** The slice of pi's tool definition this extension fills: name, label,
 *  description, a JSON-Schema `parameters` object and `execute`. */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: PiExtensionContext,
  ): Promise<PiToolResult>;
}

/** pi's `tool_call` event as the hook reads it. */
export interface PiToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** The slice of pi's `ExtensionAPI` this extension calls. */
export interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
  on(event: string, handler: (event: unknown, ctx: PiExtensionContext) => unknown): void;
}

const notify = (ctx: PiExtensionContext, payload: HookNoticePayload) =>
  ctx.ui.notify(HOOK_PREFIX + JSON.stringify(payload), "info");

/** One terminal tool as pi registers it, less its `execute`: the native
 *  tool's description and input schema. */
interface PiToolDeclaration {
  description: string;
  parameters: PiToolDefinition["parameters"];
}

/** `submit_pr_description` as `submitPrDescriptionTool` declares it in
 *  src/tools/submit.ts — the same description and schema, so the model
 *  writes the same object a native coding run would. The driver validates the
 *  object with Switchboard's own parser; this declaration only shapes the call. */
const SUBMIT_PR_DESCRIPTION: PiToolDeclaration = {
  description:
    "Submit the PR description as a typed object. REQUIRED after pushing your branch: Switchboard renders the GitHub PR body from this object at the pushed head and opens (or updates) the pull request itself — never open a PR yourself. The body is a fixed-size MAP for the reader (tldr, why, at most 7 pointers, feedbackWanted, risk, verified) with decisions, validation and agentNotes collapsed under it; every field is capped in visible characters (a link's URL is not counted) and the tool refuses an object over a cap naming the field and the count, so cut and resubmit. `title` becomes the PR's title (at most 72 characters); on Switchboard's own repository it is also judged as that repository's CI `title` check judges it — `type(scope): description`, type from its release config, scope one of its code map's Areas or none — and refused with that check's own sentence, so fix the title and resubmit; pointer anchors are (path, from, to) line ranges at your pushed head, rendered as links. Call it after your last push; if you push again afterwards, call it again — the last valid call wins.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The PR title — one line naming the change, `type(scope): what a reader can now do or expect`, at most 72 characters in all; on Switchboard's own repository a title its CI title check would refuse (type, scope, grammar) is refused here with the same sentence",
      },
      tldr: {
        type: "string",
        description:
          "Two sentences for a reader with zero context: what this PR does and why it matters (≤300 visible chars)",
      },
      why: {
        type: "string",
        description:
          "The problem and the motivation, with the triggering issue/request, record and stack hyperlinked; why, never what (≤400)",
      },
      pointers: {
        type: "array",
        description:
          "Where to look: 1–7 rows in reading order, the files a reviewer would open first (load the pr-description skill first). Rendered as `N. [label](permalink) text ⚠ risk`",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Names the thing the row links to (≤60)" },
            text: { type: "string", description: "One sentence: what it does or why it is shaped so (≤160)" },
            risk: { type: "string", description: "Optional; only where a mistake would matter — renders as ⚠ (≤100)" },
            anchor: {
              type: "object",
              description:
                "The lines the label links to: repo-relative path + inclusive 1-based line range at the pushed head",
              properties: { path: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } },
              required: ["path", "from", "to"],
            },
          },
          required: ["label", "text", "anchor"],
        },
      },
      feedbackWanted: {
        type: "string",
        description: "The one or two things you want the reviewer's judgement on (≤200)",
      },
      risk: {
        type: "string",
        description:
          "What breaks if this is wrong, the blast radius, the rollback; over 400 changed lines, say so and name the split considered (≤300)",
      },
      verified: {
        type: "string",
        description: "One line for a person: which suites ran and passed, what is still human-gated (≤200)",
      },
      decisions: {
        type: "array",
        description:
          "Non-obvious choices (0–10): the alternative rejected and the fact that decided it; collapsed below the map",
        items: {
          type: "object",
          properties: { title: { type: "string" }, rationale: { type: "string", description: "≤400" } },
          required: ["title", "rationale"],
        },
      },
      validation: {
        type: "object",
        description: "What you actually ran and the real results — never fabricated; collapsed below the map",
        properties: {
          criteria: {
            type: "array",
            description: "1–30 rows",
            items: {
              type: "object",
              properties: {
                criterion: { type: "string", description: "≤200" },
                proof: { type: "string", description: "A test id or a command with its outcome (≤300)" },
              },
              required: ["criterion", "proof"],
            },
          },
        },
        required: ["criteria"],
      },
      agentNotes: {
        type: "string",
        description:
          "Optional: what a reviewing agent needs that a person does not — the rebase done, generated files to skip, the repro command (≤2000)",
      },
    },
    required: ["title", "tldr", "why", "pointers", "feedbackWanted", "risk", "verified", "decisions", "validation"],
  },
};

/** `submit_verdict` as `submitVerdictTool` declares it in src/tools/submit.ts
 *  — the description that says to run `git rev-parse HEAD` in the checkout
 *  reviewed, and the schema that requires `head` beside the verdict and the
 *  summary. The reviewed-head guard's fallback reads that head; served without
 *  it, a model follows the schema it is given and submits verdicts naming none. */
const SUBMIT_VERDICT: PiToolDeclaration = {
  description:
    "Record your review verdict. REQUIRED before your final message when reviewing a PR: " +
    "`approve` when no finding at or above the severity to address remains (the level in force for this run, `minor` by default: " +
    "a major or minor finding means `request_changes`; nits alone never block), `request_changes` otherwise. " +
    "Switchboard writes the verdict as the first line of the GitHub comment itself (`LGTM:` only for approve); " +
    "a review with no submitted verdict is posted as NOT approving. Call it once, after your analysis; a later call replaces the earlier one. " +
    "`head` is the commit you reviewed — run `git rev-parse HEAD` in the checkout you read and tested and pass its output; " +
    "Switchboard posts to the PR only if that commit IS the PR's head, so a review of the wrong branch can never land on a PR. " +
    "Enumerate EVERY issue you report in `findings` with STABLE ids assigned in order (F1, F2, …) — a fix round " +
    "references findings by these ids, so never renumber them. Severity is exactly one of blocking|major|minor|nit; " +
    "the entry carries the file (plus line when it points at one) and a one-line title, while the full explanation " +
    "stays in your review text keyed by the same ids. An `approve` carrying a finding at or above the severity to address " +
    "is downgraded to `request_changes` and the ack names the finding and the level — approve only when every finding sits below it.",
  parameters: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "request_changes"], description: "approve | request_changes" },
      summary: { type: "string", description: "One-line rationale shown right after the verdict token" },
      head: {
        type: "string",
        description: "Output of `git rev-parse HEAD` in the checkout you reviewed (the commit the review is about)",
      },
      findings: {
        type: "array",
        description: "Every issue you report, one entry each, in the order reported — rendered under the verdict line",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: 'Stable id assigned in order: "F1", "F2", … — dispositions reference it',
            },
            severity: {
              type: "string",
              enum: ["blocking", "major", "minor", "nit"],
              description: "blocking | major | minor | nit",
            },
            file: { type: "string", description: "Repo-relative file the finding points at" },
            line: { type: "integer", description: "1-based line number, when the finding points at one" },
            title: {
              type: "string",
              description: "One line naming the issue (the full explanation goes in your review text)",
            },
          },
          required: ["id", "severity", "file", "title"],
        },
      },
    },
    required: ["verdict", "summary", "head"],
  },
};

const isToolCallEvent = (e: unknown): e is PiToolCallEvent =>
  typeof e === "object" && e !== null && typeof (e as PiToolCallEvent).toolCallId === "string";

export default function piExtension(pi: PiExtensionApi): void {
  pi.registerTool({
    name: "submit_pr_description",
    label: "Submit PR description",
    ...SUBMIT_PR_DESCRIPTION,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      notify(ctx, { kind: "submit_pr_description", params });
      const title = typeof params.title === "string" ? params.title : "(no title)";
      return {
        content: [
          {
            type: "text",
            text: `PR description recorded (title: ${title}). Switchboard validates it against its schema and opens or updates the PR; a later call replaces this one.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "submit_verdict",
    label: "Submit verdict",
    ...SUBMIT_VERDICT,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      notify(ctx, { kind: "submit_verdict", params });
      const verdict = typeof params.verdict === "string" ? params.verdict : "(no verdict)";
      return {
        content: [{ type: "text", text: `Verdict recorded (${verdict}). A later call replaces this one.` }],
        details: {},
      };
    },
  });

  // Observe, never block: the spike measures what the model asked for and
  // previews it against the policy on the driver's side. A returned value
  // here would be pi's `{ block, reason }`; returning nothing lets the call run.
  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEvent(event)) return;
    notify(ctx, { kind: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
  });

  pi.on("session_start", (_event, ctx) => {
    notify(ctx, { kind: "session_start", mode: ctx.mode, hasUI: ctx.hasUI });
  });
}
