/** The card sink (features/tracing.md): while a run is still setting up, the
 *  Slack card's title shows which setup step is running. The sink maps each
 *  streamed `dispatch.*` start to a display label (the table ships with the
 *  readers) and clears it when `run.agent` starts; it observes nothing until a
 *  card is bound (Null Object). */
import { isStreamed } from "./streamSpans.js";
import type { SpanSink } from "./types.js";

export interface SetupCard {
  setupLabel(label: string | undefined): void;
}

export interface CardSink extends SpanSink {
  bindCard(card: SetupCard): void;
}

export function createCardSink(label: (name: string) => string | undefined): CardSink {
  let card: SetupCard | undefined;
  return {
    bindCard(c) {
      card = c;
    },
    onStart(rec) {
      if (!card || !isStreamed(rec.name)) return;
      if (rec.name === "run.agent") {
        card.setupLabel(undefined);
        return;
      }
      if (rec.name.startsWith("dispatch.")) card.setupLabel(label(rec.name));
    },
    onEnd() {},
  };
}
