import { describe, expect, it, vi } from "vitest";
import type { ParsedChatCommand } from "../commandChat.js";
import {
  afterReply,
  artifactLink,
  attachmentSuffix,
  cardActivity,
  composeRunLabel,
  deliverAnswer,
  LONG_COMMAND_REPLY_CHARS,
  REFUSAL_SENTENCES,
  renderConfirmationOffer,
  renderRefusal,
  replyCommandOutput,
  runPageLink,
  type ReplyDeps,
} from "./reply.js";
import { refusalOf, REFUSAL_CODES, type RefusalCode } from "../refusal.js";
import { profileRefusalReply } from "./authorize.js";
import { refusalReply } from "../threadAdmission.js";
import { renderOffer } from "../confirmations.js";
import type { ConfirmationOffer } from "../types.js";
import {
  OFFER_CANCELLED_LINE,
  OFFER_EXPIRED_LINE,
  OFFER_FOREIGN_LINE,
  OFFER_UNREADABLE_LINE,
  OFFER_USED_LINE,
} from "./confirm.js";
import { REFERENCE_REFUSAL } from "./references.js";
import type { ChannelIO } from "../types.js";
import { nullChannelIO } from "../nullChannelIo.js";
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
import { activityText, createCardShell } from "../statusCardFrame.js";
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

// agent-coding.md item 10 (record 0033): the link a ticketless channel's lead
// carries — the run page's artifact proxy for ONE key, tokened while the run is live.
describe("artifactLink", () => {
  it("is the run page's artifact proxy for the key, each segment encoded, with `?t=` when a token is given", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example.com/");
    try {
      expect(artifactLink("run-1", "runs/run-1/out/1-page.png", "tok/en")).toBe(
        "https://bot.example.com/runs/run-1/artifacts/runs/run-1/out/1-page.png?t=tok%2Fen",
      );
      expect(artifactLink("run-1", "runs/run-1/out/2-a b#c.png")).toBe(
        "https://bot.example.com/runs/run-1/artifacts/runs/run-1/out/2-a%20b%23c.png",
      );
      expect(runPageLink("run-1")).toBe("https://bot.example.com/runs/run-1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is undefined without a public base URL — the lead then names the key instead", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    try {
      expect(artifactLink("run-1", "runs/run-1/out/1-page.png", "tok")).toBeUndefined();
      expect(runPageLink("run-1")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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
// run-visibility item 2: the card's activity keeps the event's structure — a
// bash call with its command is a `command` part the Slack card draws as a code
// block; everything else is the one-line trace as before.
describe("cardActivity", () => {
  it("a bash tool_call carrying its command becomes a command part with the full command, not the capped summary", () => {
    const command = "python3 - <<'EOF'\nprint(1)\nEOF";
    expect(
      cardActivity({ type: "tool_call", tool: "bash", summary: "$ python3 - <<'EOF' print(1) EOF", command }),
    ).toEqual({
      kind: "command",
      tool: "bash",
      command,
    });
  });

  it("a tool_call without a command (a non-bash tool, or an event from before the field) is the `→ summary` line", () => {
    expect(cardActivity({ type: "tool_call", tool: "read", summary: "read src/a.ts" })).toEqual({
      kind: "line",
      text: "→ read src/a.ts",
    });
    expect(cardActivity({ type: "tool_call", tool: "bash", summary: "$ ls" })).toEqual({
      kind: "line",
      text: "→ $ ls",
    });
  });

  it("every other event is its activityLine as a line part", () => {
    expect(cardActivity({ type: "tool_result", tool: "bash", ok: true, summary: "exit 0" })).toEqual({
      kind: "line",
      text: "✓ bash: exit 0",
    });
    expect(cardActivity({ type: "run_note", kind: "wrap_up", summary: "note" })).toEqual({
      kind: "line",
      text: "⏱ note",
    });
    expect(cardActivity({ type: "pushed_head", ref: "fix/a", sha: "a".repeat(40), by: "salvage" })).toEqual({
      kind: "line",
      text: "⬆ pushed fix/a @ aaaaaaa",
    });
  });

  it("activityText flattens a part for a text-only surface: the command on one line behind the `→ $` prefix, a line verbatim", () => {
    expect(activityText({ kind: "command", tool: "bash", command: "cd a &&\n  make   test" })).toBe(
      "→ $ cd a && make test",
    );
    expect(activityText({ kind: "line", text: "✓ bash: ok" })).toBe("✓ bash: ok");
    expect(activityText(undefined)).toBeUndefined();
  });
});

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

// Feature: record 0054:
// one renderer turns a `Refusal` into what the person reads; the text is the
// producer's sentence, byte-identical to today's, and the renderer adds nothing
// the producer did not put in `text` or `wayForward`. A `system` refusal never
// renders an offer or a Yes.
describe("renderRefusal — the one rendering of a Refusal", () => {
  const capture = () => {
    const replies: string[] = [];
    const offer = vi.fn();
    const io: ChannelIO = {
      ...nullChannelIO("slack:CX:1.0", () => {}),
      reply: async (t: string) => void replies.push(t),
      offer,
    };
    return { io, replies, offer };
  };

  it("renders every gate sentence and all eight reference reasons byte-identical — the producing sites' own builders diffed against the inventory's quotes", async () => {
    // Each entry pairs a code with the SENTENCE ITS PRODUCING SITE BUILDS —
    // `REFUSAL_SENTENCES`, `profileRefusalReply`, `refusalReply`, confirm.ts's
    // lines, the references' one line — and the inventory's quote as a
    // literal, so a drifted builder fails here instead of shipping. Codes
    // whose text another module builds from live data (`pr_head_unknown` from
    // `checkPrHeadPreflight`, `branch_moved` from `guardAttachedHead`,
    // `ship_preflight` from the ship preflight) are proven byte-identical by
    // those modules' own tests; the silent codes (`coordinator_thread_live`,
    // `workspace_lost`, `setup_failed`) and `uncaught` render nothing.
    const adminsHint = "an admin";
    const liveThread = { agent: "coding", startedAt: 0, inbox: [] } as unknown as Parameters<typeof refusalReply>[0];
    const table: ReadonlyArray<{ code: RefusalCode; built: string; quoted: string }> = [
      {
        code: "agent_allowlist",
        built: REFUSAL_SENTENCES.agent_allowlist({ agent: "coding", adminsHint }),
        quoted: "🚫 You're not on the allowlist for the `coding` agent. Ask an admin for access.",
      },
      {
        code: "live_agent_allowlist",
        built: REFUSAL_SENTENCES.live_agent_allowlist({ agent: "coding", adminsHint }),
        quoted:
          "🚫 You're not on the allowlist for the `coding` agent, whose run is in flight in this thread. Ask an admin for access.",
      },
      {
        code: "elsewhere_agent_allowlist",
        built: REFUSAL_SENTENCES.elsewhere_agent_allowlist({ agent: "coding", adminsHint }),
        quoted:
          "🚫 You're not on the allowlist for the `coding` agent, whose run is in flight in this thread. Ask an admin for access.",
      },
      {
        code: "profile_bounded",
        built: profileRefusalReply(
          "coding",
          { axis: "identity", needs: "write", cap: "read", scope: "channel" },
          adminsHint,
        ),
        quoted:
          "🚫 `coding` needs a `write` credential; this channel's boundary caps runs at `read`. Run it in a channel that allows `write`, or ask an admin to raise this channel's boundary.",
      },
      {
        code: "repo_not_visible",
        built: REFUSAL_SENTENCES.repo_not_visible({ slug: "o/r", agent: "coding" }),
        quoted:
          "📦 `o/r` is not a repository this installation can see — GitHub answered 404 — so I did not start a *coding* run for it. " +
          "The repository is outside the Switchboard GitHub App installation (`github_repos` lists the reachable ones), or the name is wrong.",
      },
      {
        code: "repo_unverified",
        built: REFUSAL_SENTENCES.repo_unverified({ slug: "o/r", agent: "coding", via: "github" }),
        quoted:
          "⚠️ I couldn't verify `o/r` against GitHub — it didn't answer — so I did not start a *coding* run rather than guess which repository you meant. Try again in a minute.",
      },
      {
        code: "repo_unverified",
        built: REFUSAL_SENTENCES.repo_unverified({ slug: "o/r", agent: "coding", via: "registry" }),
        quoted:
          "⚠️ I couldn't verify that `o/r` is an onboarded repo — the resident registry didn't answer — so I did not start a *coding* run rather than guess which repo you meant. " +
          "Try again in a minute, or name the repository by URL (https://github.com/o/r) to run in a cold per-thread sandbox.",
      },
      {
        code: "repo_not_onboarded",
        built: REFUSAL_SENTENCES.repo_not_onboarded({
          slug: "o/r",
          agent: "coding",
          onboardHint: "Onboard it (`repo onboard o/r`)",
        }),
        quoted:
          "📦 `o/r` is not onboarded as a resident, so I did not start a *coding* run for it. " +
          "Onboard it (`repo onboard o/r`) for a warm, deps-ready environment, or name the repository by URL " +
          "(https://github.com/o/r) to run in a cold per-thread sandbox.",
      },
      {
        code: "repo_access",
        built: REFUSAL_SENTENCES.repo_access({ repo: "o/r", adminsHint }),
        quoted: "🚫 You're not on the allowlist for the `o/r` repo environment. Ask an admin for access.",
      },
      {
        code: "follow_up_refused",
        built: refusalReply(liveThread, { requestedAgent: "review" }, 120_000),
        quoted:
          "⏳ A *coding* run is already in flight in this thread (120s in).\n" +
          "An `agent:review` request cannot start beside it — one run per thread. Wait for it to finish and re-send, or start a new thread.",
      },
      {
        code: "elsewhere_follow_up_refused",
        built: refusalReply(liveThread, { requestedAgent: "review" }, 120_000),
        quoted:
          "⏳ A *coding* run is already in flight in this thread (120s in).\n" +
          "An `agent:review` request cannot start beside it — one run per thread. Wait for it to finish and re-send, or start a new thread.",
      },
      {
        code: "which_branch",
        built: REFUSAL_SENTENCES.which_branch({ repo: "o/r" }),
        quoted:
          '🌿 Which branch of `o/r` should this thread work on? No branch is bound yet — reply naming one (e.g. "on main" or "on branch fix/login") and I\'ll pick it up from there.',
      },
      {
        code: "ship_budget",
        built: REFUSAL_SENTENCES.ship_budget({ maxMinutes: 10, maxRounds: 1, need: 25, provision: 5, coding: 15 }),
        quoted:
          "🚫 Ship cannot start under a 10-minute budget: the loop it allows (1 review rounds) needs 25 minutes — " +
          "5 to provision, the coding child's 15, and the reserve for the rounds after it at their floors. " +
          "Widen the budget or the boundary that clipped it, or run `agent:coding` for a single pass without the review loop.",
      },
      {
        code: "confirmation_expired",
        built: OFFER_EXPIRED_LINE,
        quoted: "this offer expired; type the line to run it",
      },
      { code: "confirmation_foreign", built: OFFER_FOREIGN_LINE, quoted: "only the requester can confirm this" },
      { code: "confirmation_used", built: OFFER_USED_LINE, quoted: "this offer was already used" },
      {
        code: "confirmation_unreadable",
        built: OFFER_UNREADABLE_LINE,
        quoted: "the confirmation could not be read; type the line to run it",
      },
      // Record 0037: ONE sentence for all eight reference codes.
      ...(
        [
          "reference_over_cap",
          "reference_rate_limited",
          "reference_guest",
          "reference_not_a_member",
          "reference_denied",
          "reference_timed_out",
          "reference_never",
          "reference_fetch_failed",
        ] as const
      ).map((code) => ({ code, built: REFERENCE_REFUSAL, quoted: "I can't read that thread." })),
    ];
    // Every code in the closed table is accounted for: rendered here, built by
    // another module's tested builder, or silent by design.
    const provenElsewhere: RefusalCode[] = ["pr_head_unknown", "branch_moved", "ship_preflight"];
    const silent: RefusalCode[] = ["coordinator_thread_live", "workspace_lost", "setup_failed", "uncaught"];
    const covered = new Set<RefusalCode>([...table.map((r) => r.code), ...provenElsewhere, ...silent]);
    expect([...REFUSAL_CODES].filter((c) => !covered.has(c))).toEqual([]);
    for (const row of table) {
      expect(row.built, row.code).toBe(row.quoted);
      const { io, replies } = capture();
      await renderRefusal(refusalOf(row.code, row.built), io);
      expect(replies).toEqual([row.built]);
    }
  });

  it("the offer goes out through the one renderer: the Block Kit shape rides `io.offer` verbatim, and a channel without `offer` gets the offer's text form", async () => {
    const shown: ConfirmationOffer = {
      id: "c1",
      line: "config set channel --models.coding anthropic/claude-opus-5",
      risk: "changes the scope's settings for everyone in it until reset",
      footer: "confirmation required by the built-in default",
      expiresAt: 1_000,
    };
    const { io, offer, replies } = capture();
    await renderConfirmationOffer(io, shown);
    expect(offer).toHaveBeenCalledExactlyOnceWith(shown);
    expect(replies).toEqual([]);
    const bare = { ...capture().io, offer: undefined } as ChannelIO;
    const bareReplies: string[] = [];
    bare.reply = async (t: string) => void bareReplies.push(t);
    await renderConfirmationOffer(bare, shown);
    expect(bareReplies).toEqual([renderOffer(shown)]);
  });

  it("a `system` refusal renders the text as the error it is and never an offer (no Yes)", async () => {
    const { io, replies, offer } = capture();
    await renderRefusal(refusalOf("uncaught", "⚠️ boom"), io);
    expect(replies).toEqual(["⚠️ boom"]);
    expect(offer).not.toHaveBeenCalled();
  });

  it("a `policy` refusal renders the way forward the producer set, after its text", async () => {
    const { io, replies } = capture();
    await renderRefusal(
      refusalOf("repo_access", "🚫 You're not on the allowlist for the `o/r` repo environment.", {
        wayForward: "Ask an admin for access.",
      }),
      io,
    );
    expect(replies).toEqual([
      "🚫 You're not on the allowlist for the `o/r` repo environment. Ask an admin for access.",
    ]);
  });

  it("a `request` refusal without a guess renders the text — which names what the door needs — and nothing more", async () => {
    const { io, replies, offer } = capture();
    const cancelled = refusalOf("confirmation_expired", OFFER_EXPIRED_LINE);
    await renderRefusal(cancelled, io);
    expect(replies).toEqual([OFFER_EXPIRED_LINE]);
    expect(offer).not.toHaveBeenCalled();
    expect(OFFER_CANCELLED_LINE).toBe("Cancelled; nothing ran"); // the No path's line, unchanged by the seam
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

  it("a direct message reads DM, never a hashed id: a slack:D… id and the web chat's own lane, with the user's name or stripped id beside it; a private channel or group keeps its hash", () => {
    expect(composeRunLabel({ ...base, channelId: "slack:D0DM1", userName: "ivy", text: "what time is it" })).toBe(
      'review · DM · ivy · "what time is it"',
    );
    expect(composeRunLabel({ ...base, channelId: "web:a1b2", text: "hi" })).toBe('review · DM · U123 · "hi"');
    expect(composeRunLabel({ ...base, channelId: "slack:G0PRIV", text: "hi" })).toBe('review · #G0PRIV · U123 · "hi"');
    // A name the adapter did resolve always wins, hash and all.
    expect(composeRunLabel({ ...base, channelId: "slack:D0DM1", channelName: "ivy-dm", text: "" })).toBe(
      "review · #ivy-dm · U123",
    );
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
      write: (seal) =>
        void sealed.push(`replyOk=${seal.replyOk}${seal.replyNote !== undefined ? ` (${seal.replyNote})` : ""}`),
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
      checklistAsLeft: () => "○ step",
      checklistCheckedOff: () => "✓ step",
      doneLines: () => ({}),
      runDiagnosis: undefined,
      releaseWorkspace: async () => void releases.push(1),
      root: trace.root,
    };
    return { ctx, replies, closes, releases, sealed, states };
  }

  it("delivered: the card closes ✅ with the checked-off checklist, the reply carries the answer (a review's with its run link), the run is sealed replyOk, the workspace is released after", async () => {
    const s = finishedRun();
    expect(await deliverAnswer(s.ctx)).toEqual({ kind: "delivered" });
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("✅");
    expect(JSON.stringify(s.closes[0])).toContain("✓ step");
    expect(s.replies).toEqual(["the findings\n\n[Live run](https://sb.example/runs/run-d?t=tok)"]);
    expect(s.sealed).toEqual(["replyOk=true"]);
    expect(s.releases).toEqual([1]);
  });

  // docs/reference/specs/run-history.md item 38: a resumed ingress run's reply
  // has no channel to deliver to — the seal must not claim delivery.
  it("a run replying on a null channel (no channel to deliver to) is sealed replyOk false with the reason, and the record carries it", async () => {
    const s = finishedRun();
    const io = nullChannelIO("slack:CX:1.0", () => {});
    expect(await deliverAnswer({ ...s.ctx, io })).toEqual({ kind: "delivered" });
    expect(s.sealed).toEqual(["replyOk=false (no channel to deliver to)"]);
    expect(s.releases).toEqual([1]);
  });

  it("a soft stop keeps the honest checklist and the ⏹ icon; a PR note rides after the answer", async () => {
    const s = finishedRun();
    expect(
      await deliverAnswer({ ...s.ctx, stopped: "soft", prNote: "PR #1 opened", agent: getAgent("coding") }),
    ).toEqual({
      kind: "delivered",
    });
    expect(JSON.stringify(s.closes[0])).toContain("⏹");
    expect(JSON.stringify(s.closes[0])).toContain("○ step");
    expect(s.replies).toEqual(["the findings\n\nPR #1 opened"]);
  });

  it("fenced: another generation owns the run — nothing reaches the thread, the record is dropped, the workspace is still released", async () => {
    const s = finishedRun(async () => "fenced");
    expect(await deliverAnswer(s.ctx)).toEqual({ kind: "fenced" });
    expect(s.replies).toEqual([]);
    expect(s.closes).toEqual([]);
    expect(s.states).toEqual([{ finalStatus: "completed" }]);
    expect(s.releases).toEqual([1]);
    s.ctx.ending.drain(undefined);
    expect(s.sealed).toEqual([]);
  });
});

describe("afterReply — the reflection pass", () => {
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
    const deps: ReplyDeps = {
      config,
      memory: new NullMemoryStore(),
      completions: { get: () => ({}) as never },
    };
    const registry = new RunRegistry({ genId: () => "run-a", genToken: () => "tok" });
    const run = registry.create(agentName, {
      agent: agentName,
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
    });
    const ctx = {
      msg,
      resolved: { agentName, modelRef: `anthropic/${agentName}-model` } as ResolvedRequest,
      directives: { text: msg.text },
      history: [],
      repoCtx: { repo: "acme/api", pr: 41, headSha: "a".repeat(40) },
      run,
      channelVisibility: "unknown" as const,
      stopped,
      answer: "the findings",
      toolCalls: 0,
    };
    return { deps, ctx };
  }

  // The review post-step no longer runs here: it runs inside the run loop,
  // before the stream finishes, so the record carries its outcome
  // (agent-review.md item 18; proven end-to-end in dispatcher.test.ts).
  it("memory off reflects nothing", () => {
    const s = setup("review", undefined);
    afterReply(s.deps, s.ctx);
    expect(pendingReflectionCount()).toBe(0);
  });

  it("a hard-stopped run reflects nothing", () => {
    const s = setup("review", "hard");
    afterReply(s.deps, s.ctx);
    expect(pendingReflectionCount()).toBe(0);
  });
});
