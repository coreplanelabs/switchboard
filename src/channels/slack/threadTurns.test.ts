import { describe, expect, it } from "vitest";
import { STATUS_PREFIXES } from "../../core/dispatch/reply.js";
import { threadTurns } from "./threadTurns.js";

// The pure half of `SlackIO.history()`: one Slack thread page in, the kept
// turns out. The rules are the ones `history()` applied inline before the
// mapping was lifted here, so the conversation reader (record 0037) reads a
// linked thread through the same eyes the current thread is read with.
describe("threadTurns — the thread-page-to-turns mapping", () => {
  const files = [{ id: "F1", name: "a.png", mimetype: "image/png", size: 10, url_private: "https://x/a.png" }];

  it("skips the triggering message, strips the bot mention, assigns roles by bot_id and stamps epoch ms", () => {
    const thread = [
      { user: "UA", text: "<@UBOT> first ask", ts: "1.0" },
      { bot_id: "B1", text: "an answer", ts: "2.0" },
      { user: "UA", text: "hi", ts: "3.0" },
    ];
    const turns = threadTurns(thread, { skipTs: "3.0", botUserId: "UBOT" });
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "first ask"],
      ["assistant", "an answer"],
    ]);
    expect(turns.map((t) => t.at)).toEqual([1_000, 2_000]);
  });

  it("with no skip ts every message is kept — a linked thread has no triggering message", () => {
    const thread = [
      { user: "UA", text: "one", ts: "1.0" },
      { user: "UB", text: "two", ts: "2.0" },
    ];
    expect(threadTurns(thread, {}).map((t) => t.text)).toEqual(["one", "two"]);
  });

  it("a ts that does not parse leaves the turn without a time; the turn is kept", () => {
    const [turn] = threadTurns([{ user: "UA", text: "no clock", ts: "not-a-ts" }], {});
    expect(turn.text).toBe("no clock");
    expect("at" in turn).toBe(false);
  });

  it("drops the bot's own status cards by their prefixes", () => {
    const thread = STATUS_PREFIXES.map((p, i) => ({ bot_id: "B1", text: `${p} working`, ts: `${i + 1}.0` }));
    thread.push({ bot_id: "B1", text: "a real answer", ts: "99.0" });
    expect(threadTurns(thread, {}).map((t) => t.text)).toEqual(["a real answer"]);
  });

  it("keeps a user's files and drops a bot's; a message with neither text nor files is dropped", () => {
    const thread = [
      { user: "UA", text: "", ts: "1.0", files },
      { bot_id: "B1", text: "", ts: "2.0", files },
      { user: "UA", text: "", ts: "3.0" },
    ];
    const turns = threadTurns(thread, {});
    expect(turns).toHaveLength(1);
    expect(turns[0].files).toEqual(files);
  });

  it("keeps the author id on every turn so a reader can name the speaker", () => {
    const thread = [
      { user: "UA", text: "one", ts: "1.0" },
      { bot_id: "B1", text: "two", ts: "2.0" },
    ];
    expect(threadTurns(thread, {}).map((t) => [t.user, t.botId])).toEqual([
      ["UA", undefined],
      [undefined, "B1"],
    ]);
  });
});
