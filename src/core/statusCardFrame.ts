import type { StatusActivity, StatusUpdate } from "./types.js";
import { formatDuration } from "./time/formatDuration.js";
import { DEFAULT_VERBOSITY, shows, type Verbosity } from "./verbosity.js";

// The status card's one frame builder (docs/reference/specs/run-visibility.md item 2;
// docs/reference/specs/tracing.md). Every paint of the card — the 👀 ack, the spinner
// frames the heartbeat and each event refresh, the closes before a run started,
// the done frame — comes from one `CardShell`, so the title vocabulary lives in
// one place and a change to what a title carries (a duration, a shape line)
// lands on every paint at once. Pure: the clock is injected, nothing is sent.
//
// The card speaks at the request's verbosity (routing-and-config item 28):
// its label is `*<agent>* on `<model>`` plus the notes the stages add, each
// at the level it belongs to — a note above the request's level is kept but
// never painted — and the shape and queued lines of a close are `verbose`
// material. What every level sees: the glyph, the label, the elapsed time,
// the checklist, the activity, the run link.

/** The live card's rotating glyph (one step per heartbeat/event frame). */
export const SPINNER_GLYPHS = ["◐", "◓", "◑", "◒"];

/** Prefixes that mean "this card's run is still in flight": the spinner, and
 *  the 👀 setup card posted before the run loop owns it. A card that still
 *  starts with one of these after its process is gone is an orphan — the
 *  Slack adapter's reconnect sweep closes it as interrupted (docs/reference/specs/
 *  slack-channel.md item 8). Kept next to the glyphs it derives from so the
 *  two cannot drift apart. */
export const LIVE_CARD_PREFIXES = [...SPINNER_GLYPHS, "👀"];

/** The words that open a routed card's route note — `· route reason: <reason>`
 *  on the label at `debug` (routing-and-config item 21): why the router chose
 *  the preset, for someone debugging a route, never a repeat of the request
 *  for the person who typed it. */
export const ROUTE_REASON_PREFIX = "route reason:";

/** How a card closes. `done` is a run that ran (any outcome; the icon says
 *  which) and carries the run's duration, checklist and link. The other three
 *  close a card whose run never started, so they carry no duration and no
 *  link: `not_started` for the repo/PR gates (`… · not started (reason)`),
 *  `refused` for a preflight that wrote its own reason (`… · reason`), and
 *  `setup_failed` for a throw during setup (`❌ setup failed · reason`, no
 *  label — the failure, not the agent, is the headline). */
export type CardClose = (
  | { kind: "done"; icon: string; detail?: string }
  | { kind: "not_started"; icon: string; reason: string }
  | { kind: "refused"; icon: string; reason: string }
  | { kind: "setup_failed"; reason: string }
) & {
  /** The request's shape line (docs/reference/specs/tracing.md item 5), when informative: the first detail line at `verbose`. */
  shape?: string;
  /** The queued caption, when a minute or more: the second detail line at `verbose`. */
  queued?: string;
};

/** An activity flattened for a text-only surface (the CLI, the `[tool]` log
 *  line, the load simulator): a command on one line behind the `→ $` prefix
 *  the trace has always used, a line verbatim. */
export function activityText(activity: StatusActivity | undefined): string | undefined {
  if (!activity) return undefined;
  if (activity.kind === "line") return activity.text;
  return `→ $ ${activity.command.replace(/\s+/g, " ").trim()}`;
}

export interface LiveFrameParts {
  /** Appended to the title after the elapsed time (the quiet-wait suffix). */
  suffix?: string;
  /** Appended last as ` · notice` (the deploy-restart notice); live frames only. */
  notice?: string;
  /** Detail lines in order; empty entries are dropped and the rest joined with newlines. */
  detail?: ReadonlyArray<string | undefined>;
  /** What the run is doing now, typed (`StatusActivity`); live frames only. */
  activity?: StatusActivity;
}

export interface CardShell {
  /** The card's label as painted: `*agent* on \`model\``, then every note at
   *  or below the request's verbosity, ` · ` between — what the ship branch
   *  records on its instance and every frame's title opens with. */
  readonly label: string;
  /** Add a fact about the run to the label at the level it belongs to
   *  (routing-and-config item 28): `quiet` for what the person needs (work
   *  left behind), `verbose` for what the run is doing for them (the
   *  workspace, a clipped budget, a moved head), `debug` for the operator's
   *  words (the route's reason, the ledger). Painted on every later frame
   *  when the request's level shows it; kept, unpainted, otherwise. */
  note(level: Verbosity, text: string): void;
  /** The run's live page link, once the run exists; carried by every later live and done frame. */
  setLink(link: StatusUpdate["link"]): void;
  /** The run finished at this clock stamp: every later frame's elapsed time
   *  ends here, so the closed card's total is the run's, not the moment of the
   *  close (docs/reference/specs/tracing.md — the card is one of the duration surfaces). */
  freeze(finishedAt: number): void;
  /** The setup step in flight (the card sink's display label) — shown on live
   *  frames after the elapsed time until the agent loop starts (undefined). */
  setSetupLabel(label: string | undefined): void;
  /** The 👀 frame posted before anything is known. */
  ack(): StatusUpdate;
  /** A live frame: the next spinner glyph, the label, the elapsed seconds, the parts. */
  live(parts?: LiveFrameParts): StatusUpdate;
  /** A close, per `CardClose`. */
  close(close: CardClose): StatusUpdate;
}

export interface CardShellOptions {
  /** The card's base label — `*agent* on \`model\``; notes are added with `note`. */
  label: string;
  /** When the card's clock started (the ack). */
  startedAt: number;
  now: () => number;
  link?: StatusUpdate["link"];
  /** The request's verbosity (routing-and-config item 28): which notes the
   *  label paints and whether a close carries its shape and queued lines.
   *  Default `quiet` — the card of a caller that resolved no request. */
  verbosity?: Verbosity;
  /** Lines the ack and every live frame open their detail with, ahead of the
   *  run's own lines — a routed conductor's parts (routing-and-config item 21),
   *  so the thread reads what was asked from the first paint. A close carries
   *  none: its detail is the run's checklist as left. */
  lead?: readonly string[];
}

export function createCardShell(opts: CardShellOptions): CardShell {
  const verbosity = opts.verbosity ?? DEFAULT_VERBOSITY;
  const notes: Array<{ level: Verbosity; text: string }> = [];
  let link = opts.link;
  let frame = 0;
  let finishedAt: number | undefined;
  let setupLabel: string | undefined;
  const lead = opts.lead ?? [];
  const label = () => [opts.label, ...notes.filter((n) => shows(verbosity, n.level)).map((n) => n.text)].join(" · ");
  // The one duration formatter, clock style: floored like every other surface
  // (docs/reference/specs/tracing.md item 5), so the card never reads a second more than
  // the run page and the index for the same window.
  const elapsed = () => formatDuration((finishedAt ?? opts.now()) - opts.startedAt, "clock");
  const headline = (icon: string) => `${icon} ${label()} · ${elapsed()}`;
  // Detail order on a close: shape, queued (both `verbose` material — how the
  // request's time went, not what it produced), then the caller's own lines.
  const closeDetail = (close: CardClose, own?: string) =>
    [...(shows(verbosity, "verbose") ? [close.shape, close.queued] : []), own].filter(Boolean).join("\n") || undefined;
  return {
    get label() {
      return label();
    },
    note(level, text) {
      notes.push({ level, text });
    },
    setLink(next) {
      link = next;
    },
    freeze(at) {
      finishedAt = at;
    },
    setSetupLabel(next) {
      setupLabel = next;
    },
    ack() {
      const detail = lead.join("\n");
      return { title: `👀 ${label()} · preparing workspace…`, ...(detail ? { detail } : {}) };
    },
    live(parts = {}) {
      const glyph = SPINNER_GLYPHS[frame++ % SPINNER_GLYPHS.length]!;
      const detail = [...lead, ...(parts.detail ?? [])].filter(Boolean).join("\n");
      return {
        title:
          headline(glyph) +
          (setupLabel ? ` — ${setupLabel}` : "") +
          (parts.suffix ?? "") +
          (parts.notice ? ` · ${parts.notice}` : ""),
        detail: detail || undefined,
        ...(parts.activity ? { activity: parts.activity } : {}),
        link,
      };
    },
    close(close) {
      // Every close carries how long the request took, from the ack's clock —
      // a refusal that waited on a slow attach says so (docs/reference/specs/tracing.md).
      const detail = closeDetail(close, close.kind === "done" ? close.detail : undefined);
      switch (close.kind) {
        case "done":
          return { title: headline(close.icon), detail, link };
        case "not_started":
          return { title: `${close.icon} ${label()} · not started (${close.reason}) · ${elapsed()}`, detail };
        case "refused":
          return { title: `${close.icon} ${label()} · ${close.reason} · ${elapsed()}`, detail };
        case "setup_failed":
          return { title: `❌ setup failed · ${close.reason} · ${elapsed()}`, detail };
      }
    },
  };
}
