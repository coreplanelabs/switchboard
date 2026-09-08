import type { StatusUpdate } from "./types.js";
import { formatDuration } from "./time/formatDuration.js";

// The status card's one frame builder (docs/reference/specs/run-visibility.md item 2;
// docs/reference/specs/tracing.md). Every paint of the card — the 👀 ack, the spinner
// frames the heartbeat and each event refresh, the closes before a run started,
// the done frame — comes from one `CardShell`, so the title vocabulary lives in
// one place and a change to what a title carries (a duration, a shape line)
// lands on every paint at once. Pure: the clock is injected, nothing is sent.

/** The live card's rotating glyph (one step per heartbeat/event frame). */
export const SPINNER_GLYPHS = ["◐", "◓", "◑", "◒"];

/** Prefixes that mean "this card's run is still in flight": the spinner, and
 *  the 👀 setup card posted before the run loop owns it. A card that still
 *  starts with one of these after its process is gone is an orphan — the
 *  Slack adapter's reconnect sweep closes it as interrupted (docs/reference/specs/
 *  slack-channel.md item 8). Kept next to the glyphs it derives from so the
 *  two cannot drift apart. */
export const LIVE_CARD_PREFIXES = [...SPINNER_GLYPHS, "👀"];

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
  /** The request's shape line (docs/reference/specs/tracing.md item 5), when informative: the first detail line. */
  shape?: string;
  /** The queued caption, when a minute or more: the second detail line. */
  queued?: string;
};

export interface LiveFrameParts {
  /** Appended to the title after the elapsed time (the quiet-wait suffix). */
  suffix?: string;
  /** Appended last as ` · notice` (the deploy-restart notice); live frames only. */
  notice?: string;
  /** Detail lines in order; empty entries are dropped and the rest joined with newlines. */
  detail?: ReadonlyArray<string | undefined>;
}

export interface CardShell {
  /** The card's label — `*agent* on \`model\``, plus any note appended later. */
  readonly label: string;
  setLabel(label: string): void;
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
  label: string;
  /** When the card's clock started (the ack). */
  startedAt: number;
  now: () => number;
  link?: StatusUpdate["link"];
}

export function createCardShell(opts: CardShellOptions): CardShell {
  let label = opts.label;
  let link = opts.link;
  let frame = 0;
  let finishedAt: number | undefined;
  let setupLabel: string | undefined;
  // The one duration formatter, clock style: floored like every other surface
  // (docs/reference/specs/tracing.md item 5), so the card never reads a second more than
  // the run page and the index for the same window.
  const elapsed = () => formatDuration((finishedAt ?? opts.now()) - opts.startedAt, "clock");
  const headline = (icon: string) => `${icon} ${label} · ${elapsed()}`;
  // Detail order on a close: shape, queued, then the caller's own lines.
  const closeDetail = (close: CardClose, own?: string) =>
    [close.shape, close.queued, own].filter(Boolean).join("\n") || undefined;
  return {
    get label() {
      return label;
    },
    setLabel(next) {
      label = next;
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
      return { title: `👀 ${label} · preparing workspace…` };
    },
    live(parts = {}) {
      const glyph = SPINNER_GLYPHS[frame++ % SPINNER_GLYPHS.length]!;
      const detail = (parts.detail ?? []).filter(Boolean).join("\n");
      return {
        title:
          headline(glyph) +
          (setupLabel ? ` — ${setupLabel}` : "") +
          (parts.suffix ?? "") +
          (parts.notice ? ` · ${parts.notice}` : ""),
        detail: detail || undefined,
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
          return { title: `${close.icon} ${label} · not started (${close.reason}) · ${elapsed()}`, detail };
        case "refused":
          return { title: `${close.icon} ${label} · ${close.reason} · ${elapsed()}`, detail };
        case "setup_failed":
          return { title: `❌ setup failed · ${close.reason} · ${elapsed()}`, detail };
      }
    },
  };
}
