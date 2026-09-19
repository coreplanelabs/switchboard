// The one rendering of another sender's words (record 0062,
// docs/reference/specs/thread-admission.md items 3, 4 and 9): wherever a
// message is re-rendered into a run's prompt — the unit-thread fold before a
// coding spawn (record 0051's fold rule), the live steer's follow-up prompt,
// the fresh turn a run's leftovers become — the text is attributed to its
// sender through this module, so a reader always knows who said what and no
// second rendering can drift. Platform-blind and pure: the sender is a
// namespaced id with an optional display name, nothing more.

/** One sender's words as a re-rendered prompt carries them: who said it (the
 *  display name when the platform gave one, the namespaced id otherwise), the
 *  text, and how many attachments could not travel with it. */
export interface ThreadEventText {
  sender: string;
  senderName?: string;
  text: string;
  attachmentsDropped?: number;
}

/** The attributed line: `<sender>: <text>`, with a note on its own line when
 *  the event lost attachments on the way. */
export function attributedText(e: ThreadEventText): string {
  const dropped =
    e.attachmentsDropped !== undefined && e.attachmentsDropped > 0
      ? `\n(${e.attachmentsDropped} attachment${e.attachmentsDropped === 1 ? "" : "s"} could not be carried and ${e.attachmentsDropped === 1 ? "is" : "are"} not attached.)`
      : "";
  return `${e.senderName ?? e.sender}: ${e.text}${dropped}`;
}

/** The attributed join of a unit's unconsumed thread events (record 0051's
 *  fold rule) and of the follow-ups a fresh turn merges: one block per event
 *  in arrival order — the fold before a coding spawn, the leftovers a unit's
 *  end runs as one fresh turn, and `mergeFollowUps`'s text all read the same. */
export function foldThreadEvents(events: ReadonlyArray<ThreadEventText>): string {
  return events.map(attributedText).join("\n\n");
}
