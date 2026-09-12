// The extension pi loads for `load:pi` (docs/reference/specs/load-harness.md,
// the pi driver items). pi starts it with `-e <this file>` and every other
// discovery off, so it is the whole tool surface the harness adds: the two
// terminal tools a Switchboard child ends with, and a `tool_call` hook that
// reports every call the model asked for. It imports nothing — pi's own loader
// (jiti) runs it as written, and its tool schemas are plain JSON Schema, which
// pi validates without TypeBox (packages/ai/src/utils/validation.ts,
// `validateToolArguments`). Its one channel back to the driver is pi's `notify`
// UI request: in RPC mode that is written to stdout as an `extension_ui_request`
// with `method: "notify"`, so the notice rides the same JSONL stream as pi's
// events and the driver pairs it with them by `toolCallId`.

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

const str = (description: string) => ({ type: "string", description });
const list = (items: unknown) => ({ type: "array", items });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

/** `submit_pr_description` as the bot's `full` toolset declares it
 *  (src/tools/workspace.ts): the same field names, so the model writes the
 *  same object a native coding run would. The driver validates the object
 *  with Switchboard's own schema; this schema only shapes the call. */
const PR_DESCRIPTION_PARAMETERS: PiToolDefinition["parameters"] = obj(
  {
    title: str("The PR title — a conventional-commit changelog line"),
    tldr: str("Two sentences for a reader with no context"),
    whatWhy: str("The change and its motivation"),
    tour: list(
      obj(
        {
          title: str("What this step of the change is"),
          description: str("The explanation, before the code"),
          lookFor: str("Optional: what the reader should notice"),
          anchor: obj(
            {
              path: str("Repo-relative path"),
              from: { type: "integer", description: "First line, 1-based, in the pushed head" },
              to: { type: "integer", description: "Last line, inclusive" },
            },
            ["path", "from", "to"],
          ),
        },
        ["title", "description", "anchor"],
      ),
    ),
    remaining: list(
      obj({ path: str("A touched file the Tour did not cover"), note: str("One line on it") }, ["path", "note"]),
    ),
    decisions: list(
      obj({ title: str("The decision"), rationale: str("Why, and what was rejected") }, ["title", "rationale"]),
    ),
    risks: str("What could go wrong and how it is bounded"),
    validation: obj(
      {
        summary: str("Optional one-line overall result"),
        criteria: list(
          obj({ criterion: str("What must hold"), proof: str("What you ran and saw") }, ["criterion", "proof"]),
        ),
      },
      ["criteria"],
    ),
  },
  ["title", "tldr", "whatWhy", "tour", "remaining", "decisions", "risks", "validation"],
) as PiToolDefinition["parameters"];

const VERDICT_PARAMETERS: PiToolDefinition["parameters"] = obj(
  {
    verdict: { type: "string", enum: ["approve", "request_changes"], description: "The verdict" },
    summary: str("One paragraph a reader acts on"),
    findings: list(
      obj(
        {
          id: str("Stable id, F1, F2, …"),
          severity: { type: "string", enum: ["blocking", "major", "minor", "nit"] },
          file: str("Repo-relative path"),
          line: { type: "integer", description: "Optional line" },
          title: str("One line"),
        },
        ["id", "severity", "file", "title"],
      ),
    ),
  },
  ["verdict", "summary"],
) as PiToolDefinition["parameters"];

const isToolCallEvent = (e: unknown): e is PiToolCallEvent =>
  typeof e === "object" && e !== null && typeof (e as PiToolCallEvent).toolCallId === "string";

export default function piExtension(pi: PiExtensionApi): void {
  pi.registerTool({
    name: "submit_pr_description",
    label: "Submit PR description",
    description:
      "Submit the PR description as a typed object once the change is committed. Switchboard renders the body and opens or updates the PR; a later call replaces this one.",
    parameters: PR_DESCRIPTION_PARAMETERS,
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
    description:
      "Submit the review verdict as a typed object: approve or request_changes, a summary, and findings with severities. A later call replaces this one.",
    parameters: VERDICT_PARAMETERS,
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
