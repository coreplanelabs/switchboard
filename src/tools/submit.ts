// The `submit_*` tools: a run's typed deliverables, handed to the dispatcher
// through a sink on the context instead of written as prose — the review's
// verdict with its findings, a coding run's answer to those findings, the PR
// description and a plan unit's handoff. Each validates fail-closed and
// answers a readable `error:` line the model can act on within its own budget,
// never a throw (`failsInText`); each mutates run state, so none is
// side-effect-free. Relayed to pi like every bot tool
// (docs/reference/specs/harness-pi.md item 7); the load harness's extension
// (src/load/piExtension.ts) transcribes two of these definitions and a test
// holds them equal. The toolset wiring stays in src/tools/workspace.ts.

import { z } from "zod";
import { parsePrDescription, type PrDescription } from "../core/prDescription.js";
import { downgradeNote, parseDispositionsInput, parseVerdictInput } from "../core/reviewVerdict.js";
import { parseHandoff } from "../core/ship/handoff.js";
import type { RunnableTool } from "./runnableTool.js";

export const submitVerdictTool: RunnableTool = {
  name: "submit_verdict",
  failsInText: true,
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
  inputSchema: {
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
  async run(input, ctx) {
    // The level in force rides the context (the dispatcher resolved it for
    // the run); absent — a CLI, a unit test — the parser holds the default.
    const verdict = parseVerdictInput(input, {
      ...(ctx.addressSeverity !== undefined ? { addressSeverity: ctx.addressSeverity } : {}),
    });
    if (!verdict) return "error: verdict must be exactly `approve` or `request_changes`";
    ctx.onVerdict?.(verdict);
    const notes: string[] = [];
    if (verdict.downgraded) notes.push(`downgraded from approve: ${downgradeNote(verdict.downgraded)}`);
    if (verdict.findings) notes.push(`${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}`);
    if (verdict.droppedFindings?.length) notes.push(`dropped: ${verdict.droppedFindings.join("; ")}`);
    return notes.length
      ? `verdict recorded: ${verdict.verdict} (${notes.join("; ")})`
      : `verdict recorded: ${verdict.verdict}`;
  },
};

// A coding run's answer to a review's findings (docs/reference/specs/agent-ship.md
// item 6): one typed disposition per finding, recorded on the run's record as
// submitted, so the plan runner can match them to its round's findings and
// split a cap report into declined (disposition recorded) vs unaddressed
// (none). Validation mirrors submit_verdict's fail-closed style — the parse
// lives beside the findings in src/core/reviewVerdict.ts. The tool holds no
// list of a review's ids: an id the review never issued is recorded like any
// other and the runner drops it, with a note to the re-review.
export const submitDispositionsTool: RunnableTool = {
  name: "submit_dispositions",
  failsInText: true,
  description:
    "Record one disposition per review finding after addressing them: `fixed` (the finding is addressed in your " +
    "pushed code) or `declined` (deliberately not doing it — the note says why). `findingId` is the finding's " +
    "stable id from the review (F1, F2, …) — use exactly those ids; an id the review never issued answers nothing " +
    "and is dropped when the plan runner reads your record. Every finding gets exactly one entry, every severity " +
    "included (nits too). Call it once with the complete set after your last push; a later call replaces the " +
    "earlier one. The set rides this run's record, where the plan runner reads it for the re-review.",
  inputSchema: {
    type: "object",
    properties: {
      dispositions: {
        type: "array",
        description: "The complete set — one entry per finding from the review",
        items: {
          type: "object",
          properties: {
            findingId: { type: "string", description: 'The finding\'s stable id from the review (e.g. "F1")' },
            disposition: { type: "string", enum: ["fixed", "declined"], description: "fixed | declined" },
            note: { type: "string", description: "One line: what was done, or why it was declined" },
          },
          required: ["findingId", "disposition", "note"],
        },
      },
    },
    required: ["dispositions"],
  },
  async run(input, ctx) {
    const parsed = parseDispositionsInput(input);
    if (!parsed) return "error: dispositions must be an array of { findingId, disposition: fixed|declined, note }";
    // The run loop hands every run the sink; a context without one (a unit
    // test's, a CLI's) records nothing and the ack says so, never "recorded".
    if (!ctx.onDispositions) return "no run is recording dispositions here";
    ctx.onDispositions(parsed.dispositions);
    const drops = parsed.dropped.length ? ` (dropped: ${parsed.dropped.join("; ")})` : "";
    return `dispositions recorded: ${parsed.dispositions.length}${drops}; a later call replaces this one`;
  },
};

// The coding agent's PR deliverable (docs/reference/specs/pr-description.md): a typed
// PrDescription instead of hand-written markdown. The dispatcher renders the
// GitHub body from the submitted object at the pushed head and opens/edits
// the PR itself, so the loop's ground truth comes from code, never from prose.
// Validation mirrors submit_verdict: a schema violation comes back as a
// readable string error naming the failing path — never a throw — so the
// model can fix the object and call again within its own budget.
export const submitPrDescriptionTool: RunnableTool = {
  name: "submit_pr_description",
  failsInText: true,
  description:
    "Submit the PR description as a typed object. REQUIRED after pushing your branch: Switchboard renders the GitHub PR body from this object at the pushed head and opens (or updates) the pull request itself — never open a PR yourself. The body is a fixed-size MAP for the reader (tldr, why, at most 7 pointers, feedbackWanted, risk, verified) with decisions, validation and agentNotes collapsed under it; every field is capped in visible characters (a link's URL is not counted) and the tool refuses an object over a cap naming the field and the count, so cut and resubmit. `title` becomes the PR's title; pointer anchors are (path, from, to) line ranges at your pushed head, rendered as links. Call it after your last push; if you push again afterwards, call it again — the last valid call wins.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The PR title — one line naming the change, `type(scope): what a reader can now do or expect`, at most 72 characters in all",
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
  async run(input, ctx) {
    let desc: PrDescription;
    try {
      desc = parsePrDescription(input);
    } catch (err) {
      const detail =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
          : String(err);
      return `error: invalid PR description — ${detail}`;
    }
    ctx.onPrDescription?.(desc);
    return `PR description recorded (title: ${desc.title}). Switchboard renders the body at your pushed head and opens or updates the PR; a later call replaces this one.`;
  },
};

// The handoff beside the description (docs/reference/specs/agent-coding.md item 9,
// agent-ship.md item 14): a coding child of a plan unit says, as data, where
// it departed from the unit, what it found and did not do, and which criteria
// it could not prove. The dispatcher records the object on the run; the ship
// pipeline posts it to the unit's board issue. Validation mirrors
// submit_pr_description — a bad object is a readable string error naming the
// path, never a throw. No sink means no run is listening (a unit context):
// say so rather than ack a recording that never happened.
const handoffEntry = (fields: Record<string, string>): Record<string, unknown> => ({
  type: "object",
  properties: Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, { type: "string", description: d }])),
  required: Object.keys(fields),
});

export const submitHandoffTool: RunnableTool = {
  name: "submit_handoff",
  failsInText: true,
  description:
    "Submit the unit handoff as a typed object — REQUIRED when your first user turn carries a `## Contract` block: once, " +
    "after submit_pr_description and before your final message. `deviations`: where you departed from the unit as written " +
    "(from, to, why); `followUps`: what you found and did not do, and where it belongs (what, where); `unproven`: which of " +
    "the unit's test scenarios or criteria you could not prove, and why (criterion, why). Switchboard records it on the run " +
    "and posts it to the unit's board issue, where a person decides each row. Submit empty lists when there is nothing to " +
    "say — never skip it. A later call replaces the earlier one; an invalid object returns an error naming the field to fix.",
  inputSchema: {
    type: "object",
    properties: {
      deviations: {
        type: "array",
        description: "Where you departed from the unit as written ([] when you did not)",
        items: handoffEntry({
          from: "What the unit said",
          to: "What you did instead",
          why: "Why — one or two sentences",
        }),
      },
      followUps: {
        type: "array",
        description: "What you found and did not do ([] when nothing)",
        items: handoffEntry({ what: "The follow-up, as one line", where: "Where it belongs: a file, a unit, a spec" }),
      },
      unproven: {
        type: "array",
        description: "The unit's test scenarios or criteria you could not prove ([] when every one is proven)",
        items: handoffEntry({
          criterion: "The scenario or criterion, as the unit states it",
          why: "Why it is unproven",
        }),
      },
    },
    required: ["deviations", "followUps", "unproven"],
  },
  async run(input, ctx) {
    const parsed = parseHandoff(input);
    if (!parsed.ok) return `error: invalid handoff — ${parsed.error}`;
    if (!ctx.onHandoff)
      return "no run is recording a handoff here — it was not recorded (it applies to a coding run started for a plan unit)";
    ctx.onHandoff(parsed.handoff);
    const h = parsed.handoff;
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return (
      `handoff recorded: ${count(h.deviations.length, "deviation", "deviations")}, ` +
      `${count(h.followUps.length, "follow-up", "follow-ups")}, ${h.unproven.length} unproven; a later call replaces this one`
    );
  },
};
