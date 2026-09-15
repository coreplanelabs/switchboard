import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../../artifacts/store.js";
import type { Executor } from "../../execution/executor.js";
import type { RunEvent } from "../runEvents.js";
import type { StagedFile } from "../types.js";
import {
  attachmentsLine,
  copyStaged,
  excludeCommand,
  formatSize,
  noWorkspaceLine,
  pullCommandFor,
  pullStaged,
  stagedBasename,
  stageIntoWorkspace,
  stageThreadArtifacts,
  stagingIndex,
  WorkspaceFiles,
} from "./staging.js";

// Feature: docs/reference/specs/execution.md item 20 (record 0033) — inbound staging:
// the bot copies a thread's large file into the store and the CONTAINER pulls
// it into `attachments/`; the turn's line names every file, landed or not.

// Small enough for the in-memory copy to hold every byte (it refuses a short
// body like the Worker does), large enough for the sizes to read as a person's.
const clip: StagedFile = {
  name: "clip.mp4",
  size: 312_000,
  type: "video/mp4",
  url: "https://files.slack.com/files-pri/T1-F1/clip.mp4",
  messageId: "1700000000.000200",
};
const brief: StagedFile = {
  name: "brief.pdf",
  size: 12_500,
  type: "application/pdf",
  url: "https://files.slack.com/files-pri/T1-F2/brief.pdf",
  messageId: "1700000000.000200",
};
const THREAD = "slack:C1:1700000000.000100";

/** An executor recording every command and answering by script. */
function recorder(answer: (command: string) => string = () => "") {
  const commands: Array<{ command: string; timeoutMs?: number }> = [];
  const executor: Executor = {
    exec: async (command, opts) => {
      commands.push({ command, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      return answer(command);
    },
    readFile: async () => "",
    writeFile: async () => "",
  };
  return { commands, executor };
}

/** A store whose copies are served from a fake Slack: the URL's file name decides the bytes. */
function storeWithSlack(bodies: Record<string, number> = { "clip.mp4": clip.size, "brief.pdf": brief.size }) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const name = String(input).split("/").pop()!;
    const size = bodies[name];
    if (size === undefined) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(size), { status: 200, headers: { "content-type": "video/mp4" } });
  }) as unknown as typeof fetch;
  return new InMemoryArtifactStore({ bucket: "test", fetch: fetchImpl });
}

describe("staging — the commands", () => {
  it("the pull makes the directory and fetches the presigned URL to `attachments/<index>-<basename>`, both single-quoted; a hostile name is a filename, not a command", () => {
    expect(
      pullCommandFor("https://r2.example/k?X-Amz-Signature=s", stagedBasename(1, 'clip"; echo pwned; ".mp4')),
    ).toBe(
      "mkdir -p attachments && curl -fsS -o 'attachments/1-clip_echo_pwned_.mp4' 'https://r2.example/k?X-Amz-Signature=s'",
    );
    expect(stagedBasename(2, "a.png")).toBe("2-a.png");
    expect(stagedBasename(3, "../../etc/passwd")).toBe("3-passwd");
  });

  it("the resident's exclude appends `attachments/` to .git/info/exclude once", () => {
    expect(excludeCommand()).toBe(
      "mkdir -p .git/info && { grep -qxF 'attachments/' .git/info/exclude 2>/dev/null || echo 'attachments/' >> .git/info/exclude; }",
    );
  });

  it("sizes read as a person says them", () => {
    expect(formatSize(312_000_000)).toBe("312 MB");
    expect(formatSize(6_291_456)).toBe("6 MB");
    expect(formatSize(840_000)).toBe("840 KB");
    expect(formatSize(1_200_000_000)).toBe("1.2 GB");
    expect(formatSize(12)).toBe("12 B");
  });

  it("the turn's line names every landed file with its size and type, every failed one with its reason; the workspace-less line points at agent:coding", () => {
    expect(
      attachmentsLine([
        { file: clip, basename: "1-clip.mp4", key: "k1" },
        { file: brief, basename: "2-brief.pdf", key: "k2", error: "the copy into the store failed: HTTP 502" },
      ]),
    ).toBe(
      "Attached files are in ./attachments/: 1-clip.mp4 (312 KB, video/mp4). brief.pdf could not be staged: the copy into the store failed: HTTP 502",
    );
    expect(noWorkspaceLine([clip])).toBe(
      "this agent has no workspace for clip.mp4 (312 KB, video/mp4); ask `agent:coding` to work with it",
    );
  });
});

describe("staging — copy then pull", () => {
  it("copies every file under the thread's inbound key, publishes an `artifact` event per copy after it answered, then pulls each in order; a resident gets the exclude first", async () => {
    const store = storeWithSlack();
    const events: RunEvent[] = [];
    const rec = recorder();
    const { line, outcomes } = await stageIntoWorkspace([clip, brief], {
      store,
      threadKey: THREAD,
      nextIndex: stagingIndex(),
      publish: (e) => void events.push(e),
      executor: rec.executor,
      resident: true,
      timeoutMs: 120_000,
    });
    expect(outcomes.map((o) => [o.basename, o.key, o.error])).toEqual([
      ["1-clip.mp4", "threads/slack-C1-1700000000.000100/in/1700000000.000200/1-clip.mp4", undefined],
      ["2-brief.pdf", "threads/slack-C1-1700000000.000100/in/1700000000.000200/2-brief.pdf", undefined],
    ]);
    expect(store.copies.map((c) => c.key)).toEqual(outcomes.map((o) => o.key));
    // Each event names the message its file arrived with (the page's join key, live-view.md item 26).
    expect(events).toEqual([
      {
        type: "artifact",
        direction: "in",
        key: outcomes[0]!.key,
        name: "clip.mp4",
        size: clip.size,
        contentType: "video/mp4",
        messageId: clip.messageId,
      },
      {
        type: "artifact",
        direction: "in",
        key: outcomes[1]!.key,
        name: "brief.pdf",
        size: brief.size,
        contentType: "application/pdf",
        messageId: brief.messageId,
      },
    ]);
    expect(rec.commands.map((c) => c.command.split(" ").slice(0, 2).join(" "))).toEqual([
      "mkdir -p",
      "mkdir -p",
      "mkdir -p",
    ]);
    expect(rec.commands[0]!.command).toBe(excludeCommand());
    expect(rec.commands[1]!.command).toMatch(
      /^mkdir -p attachments && curl -fsS -o 'attachments\/1-clip\.mp4' 'memory:\/\/test\/threads/,
    );
    expect(rec.commands[2]!.command).toContain("'attachments/2-brief.pdf'");
    expect(rec.commands.map((c) => c.timeoutMs)).toEqual([120_000, 120_000, 120_000]);
    expect(line).toBe(
      "Attached files are in ./attachments/: 1-clip.mp4 (312 KB, video/mp4), 2-brief.pdf (13 KB, application/pdf)",
    );
  });

  it("a sandbox gets no exclude; two files of one name take 1- and 2-; a failed copy is named and never pulled; a failed pull carries curl's words and is not retried", async () => {
    const store = storeWithSlack({ "a.png": 10 }); // the second `a.png` URL below 404s
    const first: StagedFile = {
      ...clip,
      name: "a.png",
      type: "image/png",
      size: 10,
      url: "https://files.slack.com/x/a.png",
    };
    const second: StagedFile = { ...first, url: "https://files.slack.com/x/gone/missing.png" };
    const rec = recorder((command) => (command.includes("'attachments/1-a.png'") ? "exit 22:\ncurl: (22) 403" : ""));
    const copied = await copyStaged([first, second], { store, threadKey: THREAD, nextIndex: stagingIndex() });
    expect(copied.map((o) => o.basename)).toEqual(["1-a.png", "2-a.png"]);
    expect(copied[1]!.error).toMatch(/the copy into the store failed: .*HTTP 404/);
    const pulled = await pullStaged(copied, { store, executor: rec.executor, resident: false });
    expect(rec.commands).toHaveLength(1); // one pull for the one copy that landed; no exclude on a sandbox
    expect(pulled[0]!.error).toBe("the pull into the workspace failed: exit 22:\ncurl: (22) 403");
    expect(pulled[1]!.error).toMatch(/copy into the store failed/);
    expect(attachmentsLine(pulled)).toMatch(
      /^a\.png could not be staged: the pull [\s\S]*\. a\.png could not be staged: the copy/,
    );
  });

  it("nothing to stage runs no command", async () => {
    const rec = recorder();
    const out = await stageIntoWorkspace([], {
      store: storeWithSlack(),
      threadKey: THREAD,
      nextIndex: stagingIndex(),
      executor: rec.executor,
      resident: true,
    });
    expect(out).toEqual({ line: "", outcomes: [] });
    expect(rec.commands).toEqual([]);
  });

  it("one counter across a run's rounds: the request's file takes 1-, a later steer's file of the same name takes 2- — no workspace path is reused", async () => {
    const store = storeWithSlack({ "clip.mp4": clip.size });
    const nextIndex = stagingIndex();
    const rec = recorder();
    const first = await stageIntoWorkspace([clip], {
      store,
      threadKey: THREAD,
      nextIndex,
      executor: rec.executor,
      resident: false,
    });
    const later = { ...clip, messageId: "1700000000.000900" }; // another message, the same name
    const second = await stageIntoWorkspace([later], {
      store,
      threadKey: THREAD,
      nextIndex,
      executor: rec.executor,
      resident: false,
    });
    expect(first.outcomes.map((o) => o.basename)).toEqual(["1-clip.mp4"]);
    expect(second.outcomes.map((o) => o.basename)).toEqual(["2-clip.mp4"]);
    expect(second.outcomes[0]!.key).toBe("threads/slack-C1-1700000000.000100/in/1700000000.000900/2-clip.mp4");
    expect(rec.commands.map((c) => /attachments\/([^']+)'/.exec(c.command)![1])).toEqual(["1-clip.mp4", "2-clip.mp4"]);
  });
});

// A later run in the thread: the files dropped on earlier messages are in the
// store under the thread's keys for the retention window, and the prior runs'
// records name them (`artifact`, `direction: "in"`) — the record is the
// catalogue. The new run pulls them beside its own message's files; nothing
// is copied again and Slack is never asked.
describe("staging — the thread's earlier files", () => {
  const inEvent = (key: string, name: string, size: number): RunEvent => ({
    type: "artifact",
    direction: "in",
    key,
    name,
    size,
    contentType: "video/mp4",
    messageId: "1700000000.000100",
  });
  const K1 = "threads/slack-C1-1700000000.000100/in/1700000000.000100/1-first.mp4";
  const K2 = "threads/slack-C1-1700000000.000100/in/1700000000.000300/1-second.mp4";

  it("a file the catalogue says the store holds takes the run's next index and its own `in` event; one the store no longer holds is named as expired with no index and no event; one the store could not be asked about is named so; nothing is copied and the store is not asked again", () => {
    const events: RunEvent[] = [];
    const nextIndex = stagingIndex();
    nextIndex(); // the run already numbered one file
    const outcomes = stageThreadArtifacts(
      [
        { key: K1, name: "first.mp4", size: 10, contentType: "video/mp4", held: true },
        { key: K2, name: "second.mp4", size: 20, contentType: "video/mp4", held: false },
        { key: "threads/t/in/3/1-third.mp4", name: "third.mp4", size: 30, contentType: "video/mp4" },
      ],
      { nextIndex, messageId: "1700000000.000900", publish: (e) => void events.push(e) },
    );
    expect(outcomes).toEqual([
      { file: { name: "first.mp4", size: 10, type: "video/mp4" }, basename: "2-first.mp4", key: K1, earlier: true },
      {
        file: { name: "second.mp4", size: 20, type: "video/mp4" },
        basename: "second.mp4", // no index taken: nothing lands for it
        key: K2,
        earlier: true,
        error: "the store no longer holds it (its retention passed)",
      },
      {
        file: { name: "third.mp4", size: 30, type: "video/mp4" },
        basename: "third.mp4",
        key: "threads/t/in/3/1-third.mp4",
        earlier: true,
        error: "the store could not be asked whether it still holds it",
      },
    ]);
    // Re-pulled for THIS run's request: the event names the request's message, not the one the file first came on.
    expect(events).toEqual([{ ...inEvent(K1, "first.mp4", 10), messageId: "1700000000.000900" }]);
    expect(attachmentsLine(outcomes)).toBe(
      "Attached files are in ./attachments/: 2-first.mp4 (10 B, video/mp4, from earlier in the thread). second.mp4 could not be staged: the store no longer holds it (its retention passed). third.mp4 could not be staged: the store could not be asked whether it still holds it",
    );
  });

  it("WorkspaceFiles resolves a key to the path THIS run staged it under, across every round, and nothing for a file that did not land", () => {
    const files = new WorkspaceFiles();
    files.record([
      { file: { name: "first.mp4", size: 10, type: "video/mp4" }, basename: "1-first.mp4", key: K1 },
      { file: { name: "second.mp4", size: 20, type: "video/mp4" }, basename: "second.mp4", key: K2, error: "gone" },
    ]);
    files.record([
      {
        file: { name: "steer.bin", size: 5, type: "application/octet-stream" },
        basename: "2-steer.bin",
        key: "threads/t/in/9/2-steer.bin",
      },
    ]);
    expect(files.pathOf(K1)).toBe("attachments/1-first.mp4");
    expect(files.pathOf("threads/t/in/9/2-steer.bin")).toBe("attachments/2-steer.bin");
    expect(files.pathOf(K2)).toBeUndefined();
  });
});
