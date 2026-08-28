import type { Scope } from "../config.js";

// Config awareness (features/routing-and-config.md behavior 8). The config
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
  /** Effective channel scope (static config merged with runtime overrides). */
  channel: Scope;
  /** Effective user scope (static config merged with runtime overrides). */
  user: Scope;
  /** `agent:`/`model:` parsed from THIS message. */
  messageDirective: { agent?: string; model?: string };
  /** `agent:`/`model:` carried from an earlier message in the thread (stickiness). */
  threadDirective: { agent?: string; model?: string };
  /** Whether the invoking user may run `config set channel`. */
  canEditChannelConfig: boolean;
}

export const CONFIG_AWARENESS_HEADER = "Switchboard runtime config for this run:";

export function configAwarenessBlock(i: ConfigAwarenessInput): string {
  const overrides = [
    fmtScopeOverride("channel", i.channel),
    fmtScopeOverride("user", i.user),
  ].filter((s): s is string => s !== undefined);
  const scopeLine =
    overrides.length > 0
      ? `Scope: ${overrides.join("; ")}.`
      : "Scope: using defaults — no channel or user overrides are set.";

  const lines = [
    `${CONFIG_AWARENESS_HEADER} agent \`${i.agentName}\` on model \`${i.modelRef}\`.`,
    scopeLine,
  ];

  const fromMessage = fmtDirective(i.messageDirective);
  const fromThread = fmtDirective(i.threadDirective);
  if (fromMessage) {
    lines.push(`This message's \`${fromMessage}\` directive set the agent/model for this run.`);
  } else if (fromThread) {
    lines.push(`A \`${fromThread}\` directive earlier in this thread set the agent/model for this run (thread stickiness).`);
  }

  const channelGate = i.canEditChannelConfig
    ? "per-channel"
    : "per-channel; restricted for this user — ask an admin";
  lines.push(
    "Settings are inspectable and tunable by users: `config show` (effective settings here), " +
      "`config set me agent=<name> model=<provider>/<model>` (per-user), " +
      `\`config set channel …\` (${channelGate}), \`config clear me|channel\`, ` +
      "and per-message `agent:<name>` / `model:<provider>/<model>` directives.",
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
  return parts.length > 0 ? `${label} override: ${parts.join(", ")}` : undefined;
}

function fmtDirective(d: { agent?: string; model?: string }): string | undefined {
  const parts: string[] = [];
  if (d.agent) parts.push(`agent:${d.agent}`);
  if (d.model) parts.push(`model:${d.model}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
