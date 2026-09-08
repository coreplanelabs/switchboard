import type { StatusUpdate } from "./types.js";

// The status card's one frame builder (features/run-visibility.md item 2;
// features/tracing.md). Every paint of the card — the 👀 ack, the spinner
// frames the heartbeat and each event refresh, the closes before a run started,
// the done frame — comes from one `CardShell`, so the title vocabulary lives in
// one place and a change to what a title carries (a duration, a shape line)
// lands on every paint at once. Pure: the clock is injected, nothing is sent.

/** The live card's rotating glyph (one step per heartbeat/event frame). */
export const SPINNER_GLYPHS = ["◐", "◓", "◑", "◒"];

/** Prefixes that mean "this card's run is still in flight": the spinner, and
 *  the 👀 setup card posted before the run loop owns it. A card that still
 *  starts with one of these after its process is gone is an orphan — the
 *  Slack adapter's reconnect sweep closes it as interrupted (features/
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
export type CardClose =
  | { kind: "done"; icon: string; detail?: string }
  | { kind: "not_started"; icon: string; reason: string }
  | { kind: "refused"; icon: string; reason: string }
  | { kind: "setup_failed"; reason: string };

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
  const elapsed = () => `${Math.round((opts.now() - opts.startedAt) / 1000)}s`;
  const headline = (icon: string) => `${icon} ${label} · ${elapsed()}`;
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
    ack() {
      return { title: `👀 ${label} · preparing workspace…` };
    },
    live(parts = {}) {
      const glyph = SPINNER_GLYPHS[frame++ % SPINNER_GLYPHS.length]!;
      const detail = (parts.detail ?? []).filter(Boolean).join("\n");
      return {
        title: headline(glyph) + (parts.suffix ?? "") + (parts.notice ? ` · ${parts.notice}` : ""),
        detail: detail || undefined,
        link,
      };
    },
    close(close) {
      switch (close.kind) {
        case "done":
          return { title: headline(close.icon), detail: close.detail, link };
        case "not_started":
          return { title: `${close.icon} ${label} · not started (${close.reason})` };
        case "refused":
          return { title: `${close.icon} ${label} · ${close.reason}` };
        case "setup_failed":
          return { title: `❌ setup failed · ${close.reason}` };
      }
    },
  };
}
