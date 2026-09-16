// A finished run's stored replay, as `GET /runs/:id/events` writes it without a
// token (src/channels/liveView/sse.ts, `serveHistoryEvents`): one `id: <seq>` +
// `data: <json>` frame per record, a `data:` frame alone for an omission
// notice, and `event: end` last — the transport a page reads in one fetch when
// it folds another run's timeline (a unit's run, a conductor's child). Named
// frames (`end`, `finished`, `replay_elided`) are the transport's, never the
// record's, so they are left out; a frame whose data is not a typed object is
// skipped rather than fed to the fold.

export function parseSseReplay(text: string): unknown[] {
  const frames: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.some((l) => l.startsWith("event:"))) continue;
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      const value: unknown = JSON.parse(data);
      if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string")
        frames.push(value);
    } catch {
      // a frame that is not JSON is not a record
    }
  }
  return frames;
}
