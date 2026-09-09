import { describe, expect, it, vi } from "vitest";
import type { ParsedChatCommand } from "../commandChat.js";
import {
  afterReply,
  attachmentSuffix,
  composeRunLabel,
  deliverAnswer,
  LONG_COMMAND_REPLY_CHARS,
  replyCommandOutput,
  type ReplyDeps,
} from "./reply.js";
import type { ChannelIO } from "../types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type ResolvedRequest } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { NullMemoryStore } from "../memory/index.js";
import { pendingReflectionCount } from "../memory/reflection.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import type { StopMode } from "../runEvents.js";
import { RunRegistry } from "../runRegistry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import { createCardShell } from "../statusCardFrame.js";
import type { StatusUpdate } from "../types.js";

// docs/reference/specs/command-registry.md item 27 / mcp-tools.md item 19: a command reply
// longer than one chat message goes out as an attachment where the channel
// has one — lead line as the message, the whole text as `<group>-<verb>.md`,
// converted from the chat dialect to CommonMark (`toMarkdownDocument`).

const invoke: ParsedChatCommand = { kind: "invoke", id: "mcp.show", input: { args: ["vanta"], options: {} } };
const help: ParsedChatCommand = { kind: "reply", text: "usage…" };

function io(withAttach: boolean) {
  const reply = vi.fn(async (_text: string) => {});
  const attach = vi.fn(async (_file: { name: string; text: string; lead: string }) => {});
  const base: ChannelIO = {
    reply,
    status: async () => ({ update: async () => {}, done: async () => {} }) as never,
    history: async () => [],
  };
  return { io: withAttach ? { ...base, attach } : base, reply, attach };
}

describe("replyCommandOutput", () => {
  const long = `• \`vanta\` (user) ✅ connected — https://mcp.vanta.com/mcp\nTools (100):\n${Array.from({ length: 100 }, (_, i) => `  - \`tool_${i}\` — ${"x".repeat(80)}`).join("\n")}`;

  it("a long reply on a channel with attach: the first line leads, the whole text is the file as a Markdown document, named after the command", async () => {
    const { io: channel, reply, attach } = io(true);
    await replyCommandOutput(channel, invoke, long);
    expect(reply).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
    const file = attach.mock.calls[0][0];
    expect(file.name).toBe("mcp-show.md");
    // `•` -> `-`, one line per fact kept by hard breaks; nothing dropped
    expect(
      file.text.startsWith(
        "- `vanta` (user) ✅ connected — https://mcp.vanta.com/mcp  \nTools (100):  \n  - `tool_0` — ",
      ),
    ).toBe(true);
    expect(file.text.split("\n")).toHaveLength(long.split("\n").length);
    expect(file.text).toContain("`tool_99`");
    expect(file.lead.startsWith("• `vanta` (user) ✅ connected — https://mcp.vanta.com/mcp\n")).toBe(true);
    expect(file.lead).toMatch(/full output attached — [\d,]+ chars/);
    expect(file.lead).not.toContain("tool_0");
  });

  it("a short reply is a plain reply even with attach; a long one without attach is a plain reply; a help reply attaches as `command.md`", async () => {
    const short = io(true);
    await replyCommandOutput(short.io, invoke, "x".repeat(LONG_COMMAND_REPLY_CHARS));
    expect(short.reply).toHaveBeenCalledWith("x".repeat(LONG_COMMAND_REPLY_CHARS));
    expect(short.attach).not.toHaveBeenCalled();
    const plain = io(false);
    await replyCommandOutput(plain.io, invoke, long);
    expect(plain.reply).toHaveBeenCalledWith(long);
    const usage = io(true);
    await replyCommandOutput(usage.io, help, `usage\n${"y".repeat(LONG_COMMAND_REPLY_CHARS)}`);
    expect(usage.attach.mock.calls[0][0].name).toBe("command.md");
  });
});

// Feature: docs/reference/specs/live-view.md — the human-readable run label the dispatcher
// stamps on each run for the Access-gated /runs index. `composeRunLabel` is the
// pure, channel-agnostic composer: agent-first, repo-identified for repo runs,
// channel+user (names or stripped ids) for chat runs, always with a short quoted
// snippet of the request, capped to a sane length.
// Feature: docs/reference/specs/live-view.md item 12 — the one-line attachment note the
// dispatcher appends to the `input` event's text.
describe("attachmentSuffix", () => {
  const img = { name: "a.png", mediaType: "image/png" as const, data: "" };
  const doc = { name: "a.txt", mediaType: "text/plain" as const, data: "" };
  it("is empty with no attachments", () => {
    expect(attachmentSuffix(undefined, undefined)).toBe("");
    expect(attachmentSuffix([], [])).toBe("");
  });
  it("counts images and documents with singular/plural", () => {
    expect(attachmentSuffix([img], undefined)).toBe("[+1 image]");
    expect(attachmentSuffix([img, img], [doc])).toBe("[+2 images, 1 document]");
    expect(attachmentSuffix(undefined, [doc, doc])).toBe("[+2 documents]");
  });
});

describe("composeRunLabel", () => {
  const base = { agent: "review", channelId: "slack:C0BQ", userId: "slack:U123", text: "" };

  it("a repo run is repo-identified: agent · owner/repo · snippet", () => {
    expect(composeRunLabel({ ...base, agent: "coding", repo: "owner/repo", text: "fix the login bug" })).toBe(
      'coding · owner/repo · "fix the login bug"',
    );
  });

  it("a chat run shows channel + user display names when available", () => {
    expect(
      composeRunLabel({
        ...base,
        channelName: "general",
        userName: "alice",
        text: "run these with bash",
      }),
    ).toBe('review · #general · alice · "run these with bash"');
  });

  it("falls back to the raw ids (slack: prefix stripped) when names are absent", () => {
    expect(composeRunLabel({ ...base, text: "hello" })).toBe('review · #C0BQ · U123 · "hello"');
  });

  it("uses the channel name but the stripped user id when only one name resolved", () => {
    expect(composeRunLabel({ ...base, channelName: "general", text: "hi" })).toBe('review · #general · U123 · "hi"');
  });

  it("is channel-agnostic: http/mcp ids (no names) strip their platform prefix", () => {
    expect(composeRunLabel({ agent: "review", channelId: "http:svc", userId: "http:alice", text: "go" })).toBe(
      'review · #svc · alice · "go"',
    );
  });

  it("empty (or whitespace-only) text yields no snippet segment", () => {
    expect(composeRunLabel({ ...base, repo: "owner/repo", text: "   " })).toBe("review · owner/repo");
    expect(composeRunLabel({ ...base, channelName: "c", userName: "u", text: "" })).toBe("review · #c · u");
  });

  it("collapses internal whitespace in the snippet", () => {
    expect(composeRunLabel({ ...base, channelName: "c", userName: "u", text: "  do   this\n\tnow  " })).toBe(
      'review · #c · u · "do this now"',
    );
  });

  it("prefers the first sentence when it ends within the budget", () => {
    expect(composeRunLabel({ ...base, repo: "owner/repo", text: "Deploy the app. Then celebrate loudly." })).toBe(
      'review · owner/repo · "Deploy the app…"',
    );
  });

  it("truncates a long snippet at a word boundary with an ellipsis", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c",
      userName: "u",
      text: "please run all of the integration tests and then report the results back to me thanks, and while you are at it check the deploy logs too",
    });
    expect(label.startsWith('review · #c · u · "please run all of the ')).toBe(true);
    expect(label.length).toBeLessThan(140); // ~100 chars of snippet (live-view item 21): a laptop-width row, not half of one
    expect(label.endsWith('…"')).toBe(true);
    expect(label).not.toContain("  "); // no doubled whitespace leaks through
    expect(label).not.toMatch(/ …"$/); // cut on a word boundary — no trailing space before the ellipsis
  });

  it("unwraps Slack angle-links and compacts GitHub PR/issue URLs to owner/repo#N", () => {
    expect(
      composeRunLabel({
        ...base,
        repo: "acme/api",
        text: "<https://github.com/acme/api/pull/41|https://github.com/acme/api/pull/41> — lead with a verdict",
      }),
    ).toBe('review · acme/api · "acme/api#41 — lead with a verdict"');
    expect(composeRunLabel({ ...base, repo: "o/r", text: "<https://github.com/o/r/issues/7>" })).toBe(
      'review · o/r · "o/r#7"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "fix https://github.com/o/r/pull/12/files please" })).toBe(
      'review · o/r · "fix o/r#12 please"',
    );
  });

  it("a Slack link with a human label shows the label, and other URLs drop their scheme", () => {
    expect(composeRunLabel({ ...base, repo: "o/r", text: "see <https://example.com/docs/a|the docs>" })).toBe(
      'review · o/r · "see the docs"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "read https://www.example.com/x/y" })).toBe(
      'review · o/r · "read example.com/x/y"',
    );
  });

  it("a snippet never ends in a severed URL", () => {
    const label = composeRunLabel({
      ...base,
      repo: "o/r",
      text: "please look at https://example.com/a/very/long/path/that/keeps/going/and/going/forever/more/and/more/and/more/and/more/still",
    });
    expect(label).not.toMatch(/https?:/);
    expect(label.endsWith('…"')).toBe(true);
  });

  it("a dot at the snippet budget edge inside a token is not a sentence end", () => {
    // 100 chars of prose, then a hostname whose first '.' lands exactly at index 100 (the snippet budget).
    const lead = "x".repeat(96) + " api";
    expect(lead.length).toBe(100);
    const label = composeRunLabel({ ...base, repo: "o/r", text: `${lead}.example.com is down please look` });
    expect(label).not.toContain('api…"');
    expect(label.startsWith(`review · o/r · "${"x".repeat(96)}`)).toBe(true);
  });

  it("trailing punctuation after a URL stays in the prose", () => {
    expect(composeRunLabel({ ...base, repo: "o/r", text: "fix https://github.com/o/r/pull/12, then deploy" })).toBe(
      'review · o/r · "fix o/r#12, then deploy"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "(see https://example.com/a)." })).toBe(
      'review · o/r · "(see example.com/a)."',
    );
  });

  it("Slack user/channel mentions render as their label or a readable stub", () => {
    expect(
      composeRunLabel({ ...base, repo: "o/r", text: "<@U0AAAAAAAAA> review this. Sent using <@U0BBBBBBBBB|Claude>" }),
    ).toBe('review · o/r · "@user review this…"');
    expect(composeRunLabel({ ...base, repo: "o/r", text: "post in <#C0AAAAAAAAA|general> and <#C0BQ>" })).toBe(
      'review · o/r · "post in #general and #channel"',
    );
    expect(composeRunLabel({ ...base, repo: "o/r", text: "cc <!here> and <!subteam^S123|@eng>" })).toBe(
      'review · o/r · "cc @here and @eng"',
    );
  });

  it("caps the overall label to a sane length", () => {
    const label = composeRunLabel({
      ...base,
      channelName: "c".repeat(200),
      userName: "u".repeat(200),
      text: "hello there",
    });
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label.endsWith("…")).toBe(true);
  });
});

// The answer's delivery and what follows it (docs/reference/specs/run-history.md
// items 35–36, docs/reference/specs/agent-review.md item 6, docs/reference/specs/memory.md).
describe("deliverAnswer — the answer reaches the thread", () => {
  const NOW = 10_000;
  const agent = getAgent("review");
  const msg = { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0", text: "review it" };

  function finishedRun(finishing?: () => Promise<"ok" | "fenced" | "unavailable">) {
    const registry = new RunRegistry({ genId: () => "run-d", genToken: () => "tok" });
    const run = registry.create("review", {
      agent: "review",
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
    });
    registry.finish(run.id, "completed");
    const ending = createRunEnding({ registry });
    ending.finished(run.id);
    const sealed: string[] = [];
    ending.register({
      runId: run.id,
      flipOnPostFinishFailure: true,
      write: (seal) => void sealed.push(`replyOk=${seal.replyOk}`),
    });
    const replies: string[] = [];
    const closes: StatusUpdate[] = [];
    const releases: number[] = [];
    const states: unknown[] = [];
    const ledgerRun = finishing
      ? ({ finishing, setState: (patch: unknown) => void states.push(patch) } as unknown as LedgerRun)
      : undefined;
    const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf("slack:CX"), receivedAt: NOW });
    const shell = createCardShell({ label: "*review* on `m`", startedAt: NOW, now: () => NOW });
    const io: ChannelIO = {
      reply: async (t) => void replies.push(t),
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    const ctx = {
      msg,
      io,
      agent,
      run,
      answer: "the findings",
      liveUrl: "https://sb.example/runs/run-d?t=tok",
      prNote: undefined,
      stopped: undefined,
      ledgerRun,
      ending,
      card: { update: () => {}, done: async (f: StatusUpdate) => void closes.push(f) },
      shell,
      finalDetail: () => "○ step",
      checkedOffDetail: () => "✓ step",
      doneLines: () => ({}),
      runDiagnosis: undefined,
      releaseWorkspace: async () => void releases.push(1),
      root: trace.root,
    };
    return { ctx, replies, closes, releases, sealed, states };
  }

  it("delivered: the card closes ✅ with the checked-off checklist, the reply carries the answer (a review's with its run link), the run is sealed replyOk, the workspace is released after", async () => {
    const s = finishedRun();
    expect(await deliverAnswer(s.ctx)).toBe("delivered");
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("✅");
    expect(JSON.stringify(s.closes[0])).toContain("✓ step");
    expect(s.replies).toEqual(["the findings\n\n[Live run](https://sb.example/runs/run-d?t=tok)"]);
    expect(s.sealed).toEqual(["replyOk=true"]);
    expect(s.releases).toEqual([1]);
  });

  it("a soft stop keeps the honest checklist and the ⏹ icon; a PR note rides after the answer", async () => {
    const s = finishedRun();
    expect(await deliverAnswer({ ...s.ctx, stopped: "soft", prNote: "PR #1 opened", agent: getAgent("coding") })).toBe(
      "delivered",
    );
    expect(JSON.stringify(s.closes[0])).toContain("⏹");
    expect(JSON.stringify(s.closes[0])).toContain("○ step");
    expect(s.replies).toEqual(["the findings\n\nPR #1 opened"]);
  });

  it("fenced: another generation owns the run — nothing reaches the thread, the record is dropped, the workspace is still released", async () => {
    const s = finishedRun(async () => "fenced");
    expect(await deliverAnswer(s.ctx)).toBe("fenced");
    expect(s.replies).toEqual([]);
    expect(s.closes).toEqual([]);
    expect(s.states).toEqual([{ finalStatus: "completed" }]);
    expect(s.releases).toEqual([1]);
    s.ctx.ending.drain(undefined);
    expect(s.sealed).toEqual([]);
  });
});

describe("afterReply — the reflection pass and the review post-step", () => {
  const NOW = 10_000;
  const msg = {
    channelId: "slack:CX",
    userId: "slack:UX",
    threadKey: "slack:CX:1.0",
    text: "review https://github.com/acme/api/pull/41",
  };

  function setup(agentName: string, stopped: StopMode | undefined) {
    const dir = mkdtempSync(join(tmpdir(), "swb-after-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      "organization: acme\nproviders:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/general-model\n    review: anthropic/review-model\n",
    );
    const config = new ConfigStore(path, join(dir, "overrides.json"));
    const posts: Array<{ target: unknown; body: string }> = [];
    const deps: ReplyDeps = {
      config,
      memory: new NullMemoryStore(),
      providers: { get: () => ({}) as never } as never,
      postReviewComment: async (target, body) => void posts.push({ target, body }),
      fetchPrHead: async () => "a".repeat(40),
    };
    const registry = new RunRegistry({ genId: () => "run-a", genToken: () => "tok" });
    const run = registry.create(agentName, {
      agent: agentName,
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
    });
    const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf("slack:CX"), receivedAt: NOW });
    const replies: string[] = [];
    const io: ChannelIO = {
      reply: async (t) => void replies.push(t),
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    const ctx = {
      msg,
      io,
      agent: getAgent(agentName),
      resolved: { agentName, modelRef: `anthropic/${agentName}-model` } as ResolvedRequest,
      directives: { text: msg.text },
      history: [],
      repoCtx: { repo: "acme/api", pr: 41, headSha: "a".repeat(40) },
      run,
      channelVisibility: "unknown" as const,
      stopped,
      answer: "the findings",
      toolCalls: 0,
      reviewHead: "a".repeat(40),
      observedHead: "a".repeat(40),
      verdict: undefined,
      carried: undefined,
      root: trace.root,
    };
    return { deps, ctx, posts, replies };
  }

  it("a review of a resolved PR posts its findings back, pinned to the reviewed head, with the fail-closed verdict line; memory off reflects nothing", async () => {
    const s = setup("review", undefined);
    await afterReply(s.deps, s.ctx);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].target).toMatchObject({ repo: "acme/api", number: 41 });
    expect(s.posts[0].body).toMatch(/^No verdict submitted — not approving\./);
    expect(s.posts[0].body).toContain("the findings");
    expect(pendingReflectionCount()).toBe(0);
  });

  it("a hard-stopped review posts nothing and reflects nothing", async () => {
    const s = setup("review", "hard");
    await afterReply(s.deps, s.ctx);
    expect(s.posts).toEqual([]);
    expect(pendingReflectionCount()).toBe(0);
  });
});
