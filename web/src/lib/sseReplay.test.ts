import { describe, expect, it } from "vitest";
import { parseSseReplay } from "./sseReplay";

// Feature: docs/reference/specs/live-view.md item 28 — a run's timeline on the
// unit page folds the replay `/runs/:id/events` writes for a finished run.

describe("parseSseReplay — the stored replay as frames for the fold", () => {
  it("reads one frame per data block in order, keeps notices, drops the named transport frames and anything that is not a typed record", () => {
    const text = [
      "retry: 3000",
      "",
      'id: 1\ndata: {"type":"input","text":"go","seq":1}',
      "",
      'data: {"type":"replay_note","summary":"2 records omitted"}',
      "",
      'id: 4\ndata: {"type":"answer","text":"done","seq":4}',
      "",
      "event: end\ndata: {}",
      "",
      "data: not json",
      "",
      'data: {"no":"type"}',
      "",
      "",
    ].join("\n");
    expect(parseSseReplay(text)).toEqual([
      { type: "input", text: "go", seq: 1 },
      { type: "replay_note", summary: "2 records omitted" },
      { type: "answer", text: "done", seq: 4 },
    ]);
  });

  it("an empty replay is no frames; CRLF line ends read the same", () => {
    expect(parseSseReplay("")).toEqual([]);
    expect(parseSseReplay("retry: 3000\n\nevent: end\ndata: {}\n\n")).toEqual([]);
    expect(parseSseReplay('id: 1\r\ndata: {"type":"input","text":"go"}\r\n\r\n')).toEqual([
      { type: "input", text: "go" },
    ]);
  });
});
