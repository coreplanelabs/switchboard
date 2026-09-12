import { fmtEffectiveBoundary, type Scope } from "../config.js";
import { clipSourceLabel, type BoundaryScope, type EffectiveBoundary } from "../config/profile.js";
import { EFFORT_LEVELS, type Effort } from "../effort.js";

// Config awareness (docs/reference/specs/routing-and-config.md behavior 8). The config
// system — per-user / per-channel / per-agent layers, runtime overrides,
// per-message directives — exists and is applied on every dispatch, but until
// this block the model was never TOLD, so a config-blind agent (general: no
// tools, fast model) confabulated "I'm stateless, nothing is tunable". This
// renders the RESOLVED state of one run plus the exact commands to inspect and
// change it. Pure: inputs are the values the dispatcher already resolved, so
// the block can never disagree with what actually ran. Names only — agent,
// model refs, scope keys — never credentials. It rides on every turn, so it is
// deliberately a few lines.

export interface ConfigAwarenessInput {
  /** The agent that is actually running (post-resolution, post-gate). */
  agentName: string;
  /** The `<provider>/<model>` ref that is actually running. */
  modelRef: string;
  /** The effort the config layers resolved for this run; undefined = none set
   *  (the agent definition / provider default applies). */
  effort?: Effort;
  /** Effective channel scope (static config merged with runtime overrides). */
  channel: Scope;
  /** Effective user scope (static config merged with runtime overrides). */
  user: Scope;
  /** `agent:`/`model:`/`effort:`/`budget:` parsed from THIS message. */
  messageDirective: DirectiveSet;
  /** `agent:`/`model:`/`effort:` carried from an earlier message in the thread
   *  (stickiness); a budget is never carried, so the set has none. */
  threadDirective: Omit<DirectiveSet, "budget">;
  /** Whether the invoking user may run `config set channel`. */
  canEditChannelConfig: boolean;
  /** The boundary in force on this run's path (docs/reference/specs/routing-and-config.md
   *  item 2), intersected across the scopes with each axis's scope. Absent →
   *  no line (byte-identical to before boundaries existed). */
  boundary?: EffectiveBoundary;
  /** The budget this run actually has, against the preset's own; `boundedBy`
   *  names the scope whose boundary clipped it — or `directive` when the
   *  message's own `budget:` did — and `directive` is that directive's value
   *  when the message carried one, so a directive that narrowed nothing is
   *  said to have. Absent, or equal to the preset's with nothing clipping and
   *  no directive → no line. */
  budget?: { minutes: number; presetMinutes: number; boundedBy?: BoundaryScope; directive?: number };
  /** External MCP servers (docs/reference/specs/mcp-tools.md item 17): whether the
   *  self-serve registry is on, and which servers answered / did not for THIS
   *  run — so an agent never says "I cannot load MCPs" when a user can add one.
   *  Absent → no line (byte-identical to before the feature). */
  mcp?: { registryOn: boolean; served: string[]; unavailable: string[] };
}

type DirectiveSet = { agent?: string; model?: string; effort?: Effort; budget?: number };

export const CONFIG_AWARENESS_HEADER = "Switchboard runtime config for this run:";

export function configAwarenessBlock(i: ConfigAwarenessInput): string {
  const overrides = [fmtScopeOverride("channel", i.channel), fmtScopeOverride("user", i.user)].filter(
    (s): s is string => s !== undefined,
  );
  const scopeLine =
    overrides.length > 0
      ? `Scope: ${overrides.join("; ")}.`
      : "Scope: using defaults — no channel or user overrides are set.";

  const effort = i.effort ? `at effort \`${i.effort}\`` : "at the model's default effort";
  const lines = [
    `${CONFIG_AWARENESS_HEADER} agent \`${i.agentName}\` on model \`${i.modelRef}\` ${effort}.`,
    scopeLine,
  ];

  const fromMessage = fmtDirective(i.messageDirective);
  const fromThread = fmtDirective(i.threadDirective);
  if (fromMessage) {
    lines.push(`This message's \`${fromMessage}\` directive set the agent/model/effort for this run.`);
  } else if (fromThread) {
    lines.push(
      `A \`${fromThread}\` directive earlier in this thread set the agent/model/effort for this run (thread stickiness).`,
    );
  }

  // Custom instructions: name WHICH scopes carry them, never
  // the text — the instructions block itself carries that, right after this.
  const withInstructions = (["channel", "user"] as const).filter((k) => i[k].instructions?.trim());
  if (withInstructions.length > 0) {
    lines.push(
      `Custom instructions are active for this run (${withInstructions.join(", ")}) — see the block below. ` +
        "They are advisory prompt content and did not affect the agent/model/permission resolution above.",
    );
  }

  if (i.mcp) {
    const { registryOn, served, unavailable } = i.mcp;
    if (served.length > 0)
      lines.push(
        `External MCP servers connected for this run: ${served.join(", ")} — their tools are named \`mcp__<server>__*\` (details: \`mcp list\`, \`mcp show <name>\`).`,
      );
    if (unavailable.length > 0)
      lines.push(`MCP servers configured for this agent that did not answer this run: ${unavailable.join(", ")}.`);
    if (registryOn && served.length === 0 && unavailable.length === 0) {
      lines.push(
        "External MCP servers: none connected for you or org-wide yet. Anyone can connect one for their own runs with `mcp add <name> --url <url>` (a one-time link takes the token; never paste tokens in chat); admins add org-wide ones with `--scope org`. `mcp list` shows what exists.",
      );
    }
  }

  // The boundary in force and the budget it clipped: a cap on what any run in
  // the scope may have, never a grant — so an agent asked how long it has, or
  // why it cannot push here, answers from the values the gate judged.
  if (i.boundary) {
    lines.push(
      `Boundary in force: ${fmtEffectiveBoundary(i.boundary)} — a boundary caps what any run in its scope may have and never grants; a preset above a cap is refused, a budget above it clipped. ` +
        "Users set their own with `config set me --boundary.maxMinutes <n> --boundary.maxIdentity <none|read|write> --boundary.machines <a,b>` (it can only tighten the channel's and the defaults'); `config set channel --boundary.…` caps a channel.",
    );
  }
  if (i.budget?.boundedBy !== undefined) {
    lines.push(
      `Budget: ${i.budget.minutes} min (clipped by the ${clipSourceLabel(i.budget.boundedBy)}; the preset asks ${i.budget.presetMinutes}).`,
    );
  }
  // A `budget:` directive that did not win — at or above the preset's own
  // budget, or above a boundary that clipped tighter — narrowed nothing, and
  // the model is told so, or it would answer "you asked for 200" to "how long
  // do you have?".
  if (i.budget?.directive !== undefined && i.budget.boundedBy !== "directive") {
    const stands =
      i.budget.boundedBy === undefined ? `the preset's ${i.budget.presetMinutes} min` : `${i.budget.minutes} min`;
    lines.push(`This message's \`budget:${i.budget.directive}\` narrowed nothing: the run's budget is ${stands}.`);
  }

  const channelGate = i.canEditChannelConfig ? "per-channel" : "per-channel; restricted for this user — ask an admin";
  // The level list is the ladder itself, so a level added to EFFORT_LEVELS is
  // advertised here without anyone remembering to retype it. Stated once (the
  // block rides on every turn); the directive form points back at it.
  const levels = `<${EFFORT_LEVELS.join("|")}>`;
  lines.push(
    "Users inspect and tune settings: `config show`, " +
      `\`config set me --agent <name> --model <provider>/<model> --effort ${levels}\` (per-user; \`--models.<agent>\` / \`--efforts.<agent>\` per agent), ` +
      `\`config set channel …\` (${channelGate}), \`config instructions me|channel "<free text>"\` ` +
      "(custom instructions), `config clear me|channel`, " +
      "and per-message `agent:<name>` / `model:<provider>/<model>` / `effort:<level>` / `budget:<minutes>` directives.",
    "When asked about your settings or tuning, answer from this block — you are not stateless or untunable.",
  );
  return lines.join("\n");
}

function fmtScopeOverride(label: "channel" | "user", s: Scope): string | undefined {
  const parts: string[] = [];
  if (s.agent) parts.push(`agent \`${s.agent}\``);
  if (s.model) parts.push(`model \`${s.model}\``);
  const perAgent = Object.entries(s.models ?? {});
  if (perAgent.length > 0) {
    parts.push(`models ${perAgent.map(([agent, ref]) => `${agent}=\`${ref}\``).join(", ")}`);
  }
  if (s.effort) parts.push(`effort \`${s.effort}\``);
  const perAgentEffort = Object.entries(s.efforts ?? {});
  if (perAgentEffort.length > 0) {
    parts.push(`efforts ${perAgentEffort.map(([agent, e]) => `${agent}=\`${e}\``).join(", ")}`);
  }
  return parts.length > 0 ? `${label} override: ${parts.join(", ")}` : undefined;
}

function fmtDirective(d: DirectiveSet): string | undefined {
  const parts: string[] = [];
  if (d.agent) parts.push(`agent:${d.agent}`);
  if (d.model) parts.push(`model:${d.model}`);
  if (d.effort) parts.push(`effort:${d.effort}`);
  if (d.budget !== undefined) parts.push(`budget:${d.budget}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
