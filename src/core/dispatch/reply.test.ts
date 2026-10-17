import type { AudienceTrace } from "../audienceDecision.js";
import { ToolRecoveryStoppedError } from "../harness/toolRecovery.js";
import { createSpanLog } from "../trace/spanLog.js";
import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { describe, expect, it, vi } from "vitest";
import { withResidentTrace } from "../../execution/residentTrace.js";
import type { ParsedChatCommand } from "../commandChat.js";
import {
  afterReply,
  artifactLink,
  attachmentSuffix,
  cardActivity,
  composeRunLabel,
  deliverAnswer,
  errorReply,
  LONG_COMMAND_REPLY_CHARS,
  REFUSAL_SENTENCES,
  renderConfirmationOffer,
  renderRefusal,
  replyCommandOutput,
  runPageLink,
  threadPageLink,
  type ReplyDeps,
} from "./reply.js";

describe("thread failure messages", () => {
  it("explains a preserved workspace and the operator action without exposing the internal refusal", async () => {
    const text = "resident attach failed for repo:acme/widgets: workspace-preserved: live owner advance unverified";
    const replies: string[] = [];
    const channel = {
      ...nullChannelIO("slack:CX:1.0", () => {}),
      reply: async (line: string) => void replies.push(line),
    };
    await renderRefusal(refusalOf("resident_attach_failed", text), channel);
    expect(replies).toEqual([
      "I couldn't verify that updating this workspace was safe, so I stopped and kept it unchanged. A Switchboard operator needs to check the workspace before work can continue.",
    ]);
    expect(errorReply(new Error(text))).toBe(
      "⚠️ I couldn't verify that updating this workspace was safe, so I stopped and kept it unchanged. A Switchboard operator needs to check the workspace before work can continue.",
    );
  });

  it("keeps unexpected service output out of the thread and names the investigation owner", () => {
    expect(
      errorReply(new Error("HTTP 500: upstream stack trace with private request data and workspace-preserved: text")),
    ).toBe(
      "⚠️ This is a bug: I couldn't finish this request. A Switchboard operator can investigate the error in the run details.",
    );
    expect(
      errorReply(new RefusalError(refusalOf("command_invalid_input", "Which pull request should I review?"))),
    ).toBe("⚠️ Which pull request should I review?");
  });

  it("names the process check when the workspace failure carries its recorded step", () => {
    const error = withResidentTrace(
      new Error("resident attach failed for repo:acme/widgets: workspace-preserved: live owner advance unverified"),
      { steps: [{ name: "advance-process-check", startMs: 0, durationMs: 1, status: "error" }] },
    );
    expect(errorReply(error)).toBe(
      "⚠️ I couldn't confirm that earlier workspace commands had stopped, so I stopped and kept the workspace unchanged. A Switchboard operator can check the remaining activity in the run details.",
    );
  });
});

describe("threadPageLink — tokenless request provenance", () => {
  it("links full Slack and web thread keys without a capability token or viewer-relative lane", () => {
    expect(threadPageLink("slack:C1:1.0", "https://bot.example/")).toBe("https://bot.example/threads/slack%3AC1%3A1.0");
    expect(threadPageLink("web:person:conv-1", "https://bot.example/?t=secret#hash")).toBe(
      "https://bot.example/threads/web%3Aperson%3Aconv-1",
    );
    expect(threadPageLink("slack:C1:1.0)", "https://bot.example")).toBe(
      "https://bot.example/threads/slack%3AC1%3A1.0%29",
    );
  });
  it("omits the link for a missing or invalid public base rather than inventing a destination", () => {
    for (const base of ["", "   ", "not a url", "javascript:alert(1)", "https://user:secret@bot.example"])
      expect(threadPageLink("slack:C1:1.0", base)).toBeUndefined();
  });
});

describe("unit thread destinations in refusal replies", () => {
  it("links the actual unit thread when the public base is configured", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example/");
    try {
      expect(
        REFUSAL_SENTENCES.pipeline_thread_owned({
          agent: "ship",
          units: [{ unit: "U12", threadKey: "slack:CX:99.0" }],
        }),
      ).toBe(
        "🚦 *ship* is coordinating work in this thread, so no separate task started here. Each task accepts updates in its own thread: [U12](https://bot.example/threads/slack%3ACX%3A99.0).",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(["", "not a URL", "https://user:secret@bot.example"])(
    "keeps the known destination when a link is unavailable: %s",
    (base) => {
      vi.stubEnv("PUBLIC_BASE_URL", base);
      try {
        expect(
          REFUSAL_SENTENCES.pipeline_thread_owned({
            agent: "ship",
            units: [{ unit: "U12", threadKey: "slack:CX:99.0" }],
          }),
        ).toBe(
          "🚦 *ship* is coordinating work in this thread, so no separate task started here. Each task accepts updates in its own thread: U12 (thread `slack:CX:99.0`; link unavailable).",
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
import { refusalOf, RefusalError, REFUSAL_CODES, type RefusalCode } from "../refusal.js";
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
import { FOLLOW_UP_DROPPED_BY_STOP } from "./settle.js";
import type { ChannelIO } from "../types.js";
import { compactActivity, replyAck } from "./reply.js";

// Feature: docs/reference/specs/routing-and-config.md item 28 — an acknowledgement
// is `verbose` material: the seam every ack goes through sends it at verbose
// and debug and swallows it at quiet, so the person on the default hears the
// result and nothing before it.
describe("compactActivity — the card's activity at verbose (routing-and-config item 28)", () => {
  it("a command becomes the caption naming the tool; a line and nothing stay as they are", () => {
    expect(compactActivity({ kind: "command", tool: "bash", command: "npm test\nnpm run lint" })).toEqual({
      kind: "line",
      text: "→ bash",
    });
    expect(compactActivity({ kind: "line", text: "✓ read_file: ok" })).toEqual({
      kind: "line",
      text: "✓ read_file: ok",
    });
    expect(compactActivity(undefined)).toBeUndefined();
  });
});

describe("replyAck — acknowledgements speak at verbose and above", () => {
  const capture = () => {
    const replies: string[] = [];
    const io: ChannelIO = {
      ...nullChannelIO("slack:CX:1.0", () => {}),
      reply: async (t: string) => void replies.push(t),
    };
    return { io, replies };
  };

  it("quiet: nothing is sent; verbose and debug: the ack goes out as given", async () => {
    const quiet = capture();
    await replyAck(quiet.io, "quiet", "↪ Added your message to the run");
    expect(quiet.replies).toEqual([]);
    const verbose = capture();
    await replyAck(verbose.io, "verbose", "↪ Added your message to the run");
    expect(verbose.replies).toEqual(["↪ Added your message to the run"]);
    const debug = capture();
    await replyAck(debug.io, "debug", "🧭 Handed to the plan runner.");
    expect(debug.replies).toEqual(["🧭 Handed to the plan runner."]);
  });
});
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

  it("a successful steer receipt is verbose narration, while verbose and debug keep it and every failed steer remains visible", async () => {
    const steer: ParsedChatCommand = {
      kind: "invoke",
      id: "steer.run",
      input: { args: ["run-1", "continue"], options: {} },
    };
    const quiet = io(false);
    await replyCommandOutput(quiet.io, steer, "↪ Added your message to the run", {
      verbosity: "quiet",
      ok: true,
      quietText: "",
    });
    expect(quiet.reply).not.toHaveBeenCalled();
    for (const verbosity of ["verbose", "debug"] as const) {
      const visible = io(false);
      await replyCommandOutput(visible.io, steer, "↪ Added your message to the run", { verbosity, ok: true });
      expect(visible.reply).toHaveBeenCalledWith("↪ Added your message to the run");
    }
    const failed = io(false);
    await replyCommandOutput(failed.io, steer, "the run ended; nothing to steer", { verbosity: "quiet", ok: false });
    expect(failed.reply).toHaveBeenCalledWith("the run ended; nothing to steer");
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
  it("shows an input update without exposing its retained arguments", () => {
    expect(cardActivity({ type: "tool_input", callId: "c1", input: '{"content":"private source"}' })).toEqual({
      kind: "line",
      text: "tool arguments recorded",
    });
  });
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
    expect(
      cardActivity({
        type: "publication_push_authorized",
        callId: "push",
        ref: "fix/a",
        expectedHeadSha: "a".repeat(40),
      }),
    ).toEqual({ kind: "line", text: "push authorized" });
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
    // `checkPrHeadPreflight`, `workspace_head_mismatch` from `guardAttachedHead`,
    // `ship_preflight` from the ship preflight) are proven byte-identical by
    // those modules' own tests; the silent codes (`coordinator_thread_live`,
    // `workspace_lost`, `setup_failed`) and `uncaught` render nothing.
    const adminsHint = "an admin";
    const liveThread = { agent: "coding", startedAt: 0, inbox: [] } as unknown as Parameters<typeof refusalReply>[0];
    const table: ReadonlyArray<{ code: RefusalCode; built: string; quoted: string }> = [
      {
        code: "tool_recovery_exhausted",
        built: new ToolRecoveryStoppedError({ tool: "bash", attempts: 2, reason: "repeated_failure" }).message,
        quoted:
          "Stopped after 2 failed tool attempts (bash). Further model calls were blocked; the task remains incomplete.",
      },
      {
        code: "agent_allowlist",
        built: REFUSAL_SENTENCES.agent_allowlist({ agent: "coding", adminsHint }),
        quoted:
          "🚫 You don't have permission to use the `coding` agent. For access, an admin can approve your request.",
      },
      {
        code: "live_agent_allowlist",
        built: REFUSAL_SENTENCES.live_agent_allowlist({ agent: "coding", adminsHint }),
        quoted:
          "🚫 You don't have permission to direct the `coding` agent working in this thread. For access, an admin can approve your request.",
      },
      {
        code: "elsewhere_agent_allowlist",
        built: REFUSAL_SENTENCES.elsewhere_agent_allowlist({ agent: "coding", adminsHint }),
        quoted:
          "🚫 You don't have permission to direct the `coding` agent working in this thread. For access, an admin can approve your request.",
      },
      {
        code: "profile_bounded",
        built: profileRefusalReply(
          "coding",
          { axis: "identity", needs: "write", cap: "read", scope: "channel" },
          adminsHint,
        ),
        quoted:
          "🚫 `coding` needs write access, but this channel's limits allow read access. No work started. For access, an admin can check these limits.",
      },
      {
        code: "repo_not_visible",
        built: REFUSAL_SENTENCES.repo_not_visible({ slug: "o/r", agent: "coding" }),
        quoted:
          "📦 I couldn't access `o/r`, so I did not start a *coding* run. " +
          "The repository name may be wrong, or the Switchboard GitHub App may need access. A repository admin can check the app's access.",
      },
      {
        code: "repo_unverified",
        built: REFUSAL_SENTENCES.repo_unverified({ slug: "o/r", agent: "coding", via: "github" }),
        quoted:
          "⚠️ I couldn't check `o/r` because GitHub did not respond. No coding work started. A Switchboard operator can check the GitHub connection.",
      },
      {
        code: "repo_unverified",
        built: REFUSAL_SENTENCES.repo_unverified({ slug: "o/r", agent: "coding", via: "registry" }),
        quoted:
          "⚠️ I couldn't check whether `o/r` has a prepared workspace because the workspace service did not respond. No coding work started. A Switchboard operator can check the service.",
      },
      {
        code: "repo_not_onboarded",
        built: REFUSAL_SENTENCES.repo_not_onboarded({
          slug: "o/r",
          agent: "coding",
          onboardHint: "Onboard it (`repo onboard o/r`)",
        }),
        quoted:
          "📦 `o/r` has no prepared workspace, so I did not start coding work. " +
          "An admin can register it with `repo onboard o/r`. Naming " +
          "https://github.com/o/r in a request uses a separate workspace.",
      },
      {
        code: "repo_access",
        built: REFUSAL_SENTENCES.repo_access({ repo: "o/r", adminsHint }),
        quoted:
          "🚫 You don't have permission to use the `o/r` workspace. For access, an admin can approve your request.",
      },
      {
        code: "pr_target_conflict",
        built: REFUSAL_SENTENCES.pr_target_conflict({ target: "o/r#8", cited: "o/r#7" }),
        quoted: "⚠️ You named both `o/r#8` and `o/r#7`. Which pull request should I work on? No work started.",
      },
      {
        code: "follow_up_refused",
        built: refusalReply(liveThread, { requestedAgent: "review" }, 120_000),
        quoted:
          "⏳ *coding* is already working in this thread (120s elapsed).\n" +
          "No review work started. A separate thread can run a separate task.",
      },
      {
        code: "elsewhere_follow_up_refused",
        built: refusalReply(liveThread, { requestedAgent: "review" }, 120_000),
        quoted:
          "⏳ *coding* is already working in this thread (120s elapsed).\n" +
          "No review work started. A separate thread can run a separate task.",
      },
      {
        code: "ship_thread_live",
        built: REFUSAL_SENTENCES.ship_thread_live(),
        quoted:
          "🚫 Ship is already working in this thread, so no second task started. A separate thread can run a separate task.",
      },
      {
        code: "pipeline_thread_owned",
        built: REFUSAL_SENTENCES.pipeline_thread_owned({
          agent: "ship",
          units: [{ unit: "U12", threadKey: "slack:CX:99.0" }],
        }),
        quoted:
          "🚦 *ship* is coordinating work in this thread, so no separate task started here. Each task accepts updates in its own thread: U12 (thread `slack:CX:99.0`; link unavailable).",
      },
      {
        code: "which_branch",
        built: REFUSAL_SENTENCES.which_branch({ repo: "o/r" }),
        quoted:
          "🌿 Which branch of `o/r` should this thread work on? No work started. You can name a branch, for example `branch:main`.",
      },
      {
        code: "ship_budget",
        built: REFUSAL_SENTENCES.ship_budget({ maxMinutes: 10, maxRounds: 1, need: 25, provision: 5, coding: 15 }),
        quoted:
          "🚫 Ship needs at least 25 minutes to set up, code and review this task; this request allows 10 minutes. No work started. An admin can check the time limit for this request.",
      },
      {
        code: "confirmation_expired",
        built: OFFER_EXPIRED_LINE,
        quoted:
          "This approval expired after ten minutes. Nothing ran. A new request can receive a new approval button.",
      },
      {
        code: "confirmation_foreign",
        built: OFFER_FOREIGN_LINE,
        quoted: "Only the person who requested this action can approve it. Nothing ran from your click.",
      },
      {
        code: "confirmation_used",
        built: OFFER_USED_LINE,
        quoted: "This approval was already used. This click did not run the action again.",
      },
      {
        code: "confirmation_unreadable",
        built: OFFER_UNREADABLE_LINE,
        quoted:
          "I couldn't read the saved approval, so nothing ran. A Switchboard operator can check the approval service.",
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
      {
        code: "follow_up_dropped",
        built: FOLLOW_UP_DROPPED_BY_STOP,
        quoted: "⛔ The run was stopped before it read your follow-up. I did not start another task from that message.",
      },
    ];
    // Every code in the closed table is accounted for: rendered here, built by
    // another module's tested builder, or silent by design.
    const provenElsewhere: RefusalCode[] = [
      "pr_head_unknown",
      "workspace_head_mismatch",
      // dispatcher.test.ts proves the legacy continuation's named transient
      // sentence when the publication fence is rebuilding.
      "publication_ownership_unknown",
      // (record 0054): each producer's own test proves its sentences
      // byte-identical — the ship preflight's eleven (preflight.test.ts), the
      // plan hand-off's fifteen (handOff.test.ts), the resolve parser
      // (resolve's dispatcher coverage), the typed commands' `chatErrorLine`
      // (commandChat.test.ts), and the resident attach errors
      // (resident.test.ts).
      "ship_preflight_channel",
      "ship_preflight_permission",
      "ship_preflight_no_repo",
      "ship_preflight_pr_unreachable",
      "ship_preflight_pr_facts",
      "ship_preflight_fork_head",
      "ship_preflight_head_unknown",
      "ship_preflight_closed_resume",
      "ship_preflight_no_task",
      "ship_preflight_pr_work_question",
      "ship_preflight_base_missing",
      "plan_base_unknown",
      "plan_routed_seed",
      "plan_id_invalid",
      "plan_unreadable",
      "plan_no_units",
      "plan_units_unknown",
      "plan_runner_state_unknown",
      "plan_runner_live",
      "plan_runner_state_unread",
      "plan_units_merged",
      "plan_history_unavailable",
      // decisionRecordReservation.test.ts and both admission tests prove the
      // shared durable-store refusal's sentence and typed code.
      "decision_record_store_unavailable",
      "plan_runner_conflict",
      "plan_instance_orphaned",
      "plan_start_failed",
      "provider_unknown",
      // resolve.test.ts proves the card's refusal sentence — the model, the
      // refused control and the card's why (record 0052).
      "model_card_refused",
      "command_unauthorized",
      "command_invalid_input",
      "command_not_found",
      "command_conflict",
      "command_unavailable",
      "command_busy",
      "command_internal",
      "resident_attach_rejected",
      "resident_attach_failed",
      // dispatcher.test.ts's coordinator producer identity cases prove the
      // pre-ack failure sentence and typed response, without a child id.
      "child_reservation_failed",
      // dispatcher.test.ts quotes the typed budget outcome and its reply at
      // every expired setup boundary; this refusal is not silent.
      "run_budget_exhausted",
      // Model-call exhaustion keeps its limit text and checkpoints WIP.
      "model_call_budget_exhausted",
      // dispatcher.test.ts proves this DM refusal runs before history and
      // session reads and names the verification remedy.
      "slack_direct_audience_unverified",
      // dispatcher.test.ts proves the system outcome and exact reply for
      // rejected appends and a saved event whose acknowledgment was lost.
      "unit_delivery_unconfirmed",
    ];
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
      risk: "changes the release-planning channel's settings for everyone who asks there until reset",
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
    expect(replies).toEqual([
      "This is a bug: I couldn't finish this request. A Switchboard operator can investigate the error in the run details.",
    ]);
    expect(offer).not.toHaveBeenCalled();
  });

  it("a `policy` refusal renders the way forward the producer set, after its text", async () => {
    const { io, replies } = capture();
    await renderRefusal(
      refusalOf("repo_access", "🚫 You don't have permission to use the `o/r` repo environment.", {
        wayForward: "Ask an admin for access.",
      }),
      io,
    );
    expect(replies).toEqual([
      "🚫 You don't have permission to use the `o/r` repo environment. Ask an admin for access.",
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

  it("a `request` refusal with a guess is one question: the sentence, the marker, the corrected line as one code span, and the evidence — and it is the line to type on a channel with no offer", async () => {
    const { io, replies, offer } = capture();
    const proposal = {
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
      text: "agent:ship in acme/infrastructure: change the onboarding link",
    };
    const guess = {
      proposal,
      line: proposal.text,
      evidence: "one edit from `acme/infrastructure`, which is onboarded",
    };
    await renderRefusal(
      refusalOf("repo_not_onboarded", "📦 `acme/infra` is not onboarded as a resident.", { guess }),
      io,
    );
    expect(replies).toEqual([
      "📦 `acme/infra` is not onboarded as a resident.\n" +
        "Did you mean:\n" +
        "`agent:ship in acme/infrastructure: change the onboarding link`\n\n" +
        "one edit from `acme/infrastructure`, which is onboarded",
    ]);
    expect(offer).not.toHaveBeenCalled();
  });

  it("a PR-work confirmation cannot be bypassed by retyping its line where no button is available", async () => {
    const { io, replies } = capture();
    const proposal = {
      channelId: "slack:CX",
      userId: "slack:UX",
      threadKey: "slack:CX:1.0",
      text: "agent:ship fix it on PR #7",
    };
    await renderRefusal(
      refusalOf("ship_preflight_pr_work_question", "Confirm separate coding work?", {
        guess: { proposal, line: proposal.text, evidence: "The cited PR is context." },
      }),
      io,
    );
    expect(replies).toEqual(["Confirm separate coding work? Confirmation is unavailable right now; nothing started."]);
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

  it.each(["public", "private"])(
    "traces the failed context check first seen during %s delivery",
    async (visibility) => {
      const githubAccess = {
        tool: "github_file",
        stage: "tool-read",
        operation: "readFile",
        route: "contents",
        reason: "http",
        httpStatus: 404,
        sourceCallHash: "b".repeat(64),
      } as const;
      const s = finishedRun();
      const log = createSpanLog();
      const trace = startRequestRoot({ clock: () => NOW, spanLog: log }, { channel: "slack", receivedAt: NOW });
      const audience: AudienceTrace = {};
      let readable = true;
      const check = async () =>
        readable
          ? { ok: true as const }
          : {
              ok: false as const,
              code: "saved-context-unproved" as const,
              check: "execution_github_access_unproved" as const,
              githubAccess,
            };
      await deliverAnswer({
        ...s.ctx,
        root: trace.root,
        audience,
        ...(visibility === "public"
          ? { publicationCheck: check }
          : {
              privateAudienceLatch: { revoked: false, revalidateSources: check },
              slackContext: { destinationStillPrivate: async () => true } as never,
            }),
        card: {
          ...s.ctx.card,
          done: async () => {
            readable = false;
          },
        },
      });
      expect(audience.refusal).toEqual({
        version: 1,
        code: "saved-context-unproved",
        causeAt: "reply",
        withheldAt: "reply",
        check: "execution_github_access_unproved",
        githubAccess,
      });
      expect(
        log
          .read()
          .lines.filter((line) => line.span === "run.publication_context_check")
          .map((line) => line.attrs.outcome),
      ).toEqual(
        visibility === "public"
          ? ["execution_github_access_unproved"]
          : ["allowed", "execution_github_access_unproved"],
      );
      expect(
        log
          .read()
          .lines.filter((line) => line.span === "run.publication_context_check")
          .at(-1)?.attrs,
      ).toEqual({
        outcome: "execution_github_access_unproved",
        githubStage: "tool-read",
        githubReason: "http",
        githubTool: "github_file",
        githubOperation: "readFile",
        route: "contents",
        httpStatus: 404,
        sourceCallHash: "b".repeat(64),
      });
      expect(s.replies).toEqual([
        "I couldn't verify that the earlier source details are still safe to share here, so I withheld them. A Switchboard operator can check the source and conversation access.",
      ]);
    },
  );

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
      hasIncompleteToolEffects: () => false,
      doneLines: () => ({}),
      runDiagnosis: undefined,
      releaseWorkspace: async () => void releases.push(1),
      root: trace.root,
    };
    return { ctx, replies, closes, releases, sealed, states };
  }

  it.each(["ok", "fenced", "unavailable"] as const)(
    "commits output facts before delivery and respects a %s settlement",
    async (gate) => {
      const order: string[] = [];
      const answerOutcome = { version: 1 as const, ending: "time_budget" as const, output: "absent" as const };
      const s = finishedRun(async () => {
        order.push("finishing");
        return "ok";
      });
      const ledgerRun = {
        ...s.ctx.ledgerRun!,
        tracked: () => true,
        commitState: async (patch: unknown) => {
          order.push("state");
          expect(patch).toEqual({ finalStatus: "completed", answerOutcome });
          return gate;
        },
      } as LedgerRun;
      const deliver = deliverAnswer({
        ...s.ctx,
        ledgerRun,
        answerOutcome,
        card: {
          ...s.ctx.card,
          done: async (frame) => {
            order.push("card");
            await s.ctx.card.done(frame);
          },
        },
      });
      if (gate === "unavailable") await expect(deliver).rejects.toThrow("could not be saved");
      else expect(await deliver).toEqual({ kind: gate === "fenced" ? "fenced" : "delivered" });
      expect(order).toEqual(gate === "ok" ? ["state", "finishing", "card"] : ["state"]);
      expect(s.replies).toHaveLength(gate === "ok" ? 1 : 0);
    },
  );

  it.each(["failed", "withheld"] as const)("keeps authored output distinct from a %s delivery", async (result) => {
    const s = finishedRun();
    const answerOutcome = { version: 1 as const, ending: "time_budget" as const, output: "present" as const };
    const deliver = deliverAnswer({
      ...s.ctx,
      answerOutcome,
      ...(result === "failed"
        ? {
            io: {
              ...s.ctx.io,
              reply: async () => {
                throw new Error("channel offline");
              },
            },
          }
        : { publicationCheck: async () => ({ ok: false as const, code: "github-access-lost" as const }) }),
    });
    if (result === "failed") await expect(deliver).rejects.toThrow("channel offline");
    else await deliver;
    expect(answerOutcome).toEqual({ version: 1, ending: "time_budget", output: "present" });
    expect(s.sealed).toEqual([`replyOk=${result === "withheld"}`]);
    if (result === "withheld") expect(s.replies.join(" ")).not.toContain("the findings");
  });

  it("delivered: the card keeps an open step amber, replies, seals the run and releases the workspace", async () => {
    const s = finishedRun();
    expect(await deliverAnswer(s.ctx)).toEqual({ kind: "delivered" });
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("⚠️");
    expect(JSON.stringify(s.closes[0])).toContain("○ step");
    expect(s.replies).toEqual(["the findings\n\n[Live run](https://sb.example/runs/run-d?t=tok)"]);
    expect(s.sealed).toEqual(["replyOk=true"]);
    expect(s.releases).toEqual([1]);
  });

  it("keeps the checklist and diagnostics on a non-private main run's completed card", async () => {
    const s = finishedRun();
    await deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      shell: createCardShell({ label: "*main*", startedAt: NOW, now: () => NOW, verbosity: "debug" }),
      doneLines: () => ({ shape: "3 steps · 2 calls", queued: "queued 1m" }),
    });
    expect(s.closes[0].detail).toContain("○ step");
    expect(s.closes[0].detail).toContain("3 steps · 2 calls");
    expect(s.closes[0].detail).toContain("queued 1m");
  });

  it("rechecks a Slack read destination immediately before the channel reply", async () => {
    const s = finishedRun();
    await deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      answer: "private fact",
      slackContext: {
        initialize: async () => true,
        revalidate: async () => true,
        sourcesStillValid: async () => ({ ok: true }),
        capability: { read: async () => "private fact" },
        destinationStillPrivate: async () => false,
        revoke: () => {},
      },
    });
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).not.toContain("private fact");
  });

  it("drops the private answer if the DM becomes shared while the card closes", async () => {
    const s = finishedRun();
    let checks = 0;
    await deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      answer: "private fact",
      slackContext: {
        initialize: async () => true,
        revalidate: async () => true,
        sourcesStillValid: async () => ({ ok: true }),
        capability: { read: async () => "private fact" },
        destinationStillPrivate: async () => ++checks === 1,
        revoke: () => {},
      },
    });
    expect(checks).toBe(2);
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).not.toContain("private fact");
  });

  it.each([
    ["coding", true],
    ["coding", false],
    ["orchestrator", true],
    ["orchestrator", false],
  ] as const)(
    "latches the first private check before card close for %s (membership recovers=%s)",
    async (agentName, recovers) => {
      const s = finishedRun(async () => "ok");
      const audience: AudienceTrace = {};
      const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
      let privateNow = false;
      let atCardClose: unknown;
      let statesAtCardClose: unknown[] = [];
      const receipt = { version: 1, causeAt: "reply", withheldAt: "reply", code: "direct-audience-denied" };
      await deliverAnswer({
        ...s.ctx,
        agent: getAgent(agentName),
        audience,
        msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
        io: {
          ...s.ctx.io,
          directAudience: () => dm,
          verifyDirectAudience: async () => (privateNow ? { ok: true } : { ok: false, code: "direct-audience-denied" }),
        },
        ledgerRun: {
          ...s.ctx.ledgerRun!,
          commitState: async (patch) => {
            s.states.push(patch);
            return "ok";
          },
        } as LedgerRun,
        card: {
          ...s.ctx.card,
          done: async (frame) => {
            atCardClose = audience.refusal;
            statesAtCardClose = [...s.states];
            privateNow = recovers;
            s.closes.push(frame);
          },
        },
        publicationCheck: async () => ({ ok: true }),
        answer: "private source fact",
        prNote: "private PR details",
      });
      expect(s.replies).toHaveLength(1);
      expect(s.replies[0]).toContain("withheld the answer");
      expect(s.replies.join("\n")).not.toContain("private source fact");
      expect(s.replies.join("\n")).not.toContain("private PR details");
      expect(audience.refusal).toEqual(receipt);
      expect(atCardClose).toEqual(receipt);
      expect(statesAtCardClose).toContainEqual({ audienceRefusal: receipt });
      expect(s.sealed).toEqual(["replyOk=true"]);
    },
  );

  it.each(["fenced", "unavailable"] as const)(
    "checks ownership before closing a withheld card when the receipt write is %s",
    async (result) => {
      const s = finishedRun(async () => "ok");
      const audience: AudienceTrace = {};
      const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
      const delivery = await deliverAnswer({
        ...s.ctx,
        audience,
        msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
        io: {
          ...s.ctx.io,
          directAudience: () => dm,
          verifyDirectAudience: async () => ({ ok: false, code: "direct-audience-denied" }),
        },
        ledgerRun: { ...s.ctx.ledgerRun!, commitState: async () => result } as LedgerRun,
        answer: "private answer",
        prNote: "private PR details",
      });
      expect(s.replies.join("\n")).not.toContain("private answer");
      expect(s.replies.join("\n")).not.toContain("private PR details");
      if (result === "fenced") {
        expect(delivery).toEqual({ kind: "fenced" });
        expect(s.closes).toEqual([]);
        expect(s.replies).toEqual([]);
        expect(s.sealed).toEqual([]);
      } else {
        expect(delivery).toEqual({ kind: "delivered" });
        expect(s.closes).toHaveLength(1);
        expect(s.replies[0]).toContain("withheld the answer");
        expect(s.sealed).toEqual(["replyOk=true"]);
      }
      expect(audience.refusal?.code).toBe("direct-audience-denied");
      expect(s.releases).toEqual([1]);
    },
  );

  it("retains the first private refusal when card close throws before the reply", async () => {
    const s = finishedRun();
    const audience: AudienceTrace = {};
    const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
    await expect(
      deliverAnswer({
        ...s.ctx,
        audience,
        agent: getAgent("coding"),
        msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
        io: {
          ...s.ctx.io,
          directAudience: () => dm,
          verifyDirectAudience: async () => ({ ok: false, code: "direct-audience-unavailable" }),
        },
        card: {
          ...s.ctx.card,
          done: async () => {
            throw new Error("card unavailable");
          },
        },
        answer: "private answer",
        prNote: "private PR details",
      }),
    ).rejects.toThrow("card unavailable");
    expect(s.replies).toEqual([]);
    expect(audience.refusal).toEqual({
      version: 1,
      causeAt: "reply",
      withheldAt: "reply",
      code: "direct-audience-unavailable",
    });
    expect(s.sealed).toEqual(["replyOk=undefined"]);
  });

  it("records the typed source refusal after the card closes without publishing model content", async () => {
    const s = finishedRun(async () => "ok");
    const audience = {};
    const writes: unknown[] = [];
    const ledgerRun = {
      ...s.ctx.ledgerRun!,
      commitState: async (patch: unknown) => {
        writes.push(patch);
        return "ok" as const;
      },
    } as LedgerRun;
    await deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      answer: "private source fact",
      ledgerRun,
      audience,
      publicationCheck: async () => ({ ok: false, code: "github-access-lost" }),
    });
    expect(s.replies.join("\n")).not.toContain("private source fact");
    expect(writes).toContainEqual({
      audienceRefusal: {
        version: 1,
        causeAt: "reply",
        withheldAt: "reply",
        code: "github-access-lost",
      },
    });
    expect(s.sealed).toEqual(["replyOk=true"]);
  });

  it.each(["fenced", "unavailable"] as const)(
    "keeps diagnostic storage %s distinct from audience permission",
    async (result) => {
      const s = finishedRun(async () => "ok");
      const ledgerRun = { ...s.ctx.ledgerRun!, commitState: async () => result } as LedgerRun;
      const delivery = await deliverAnswer({
        ...s.ctx,
        ledgerRun,
        publicationCheck: async () => ({ ok: false, code: "github-access-lost" }),
        answer: "private source fact",
      });
      expect(s.replies.join("\n")).not.toContain("private source fact");
      if (result === "fenced") {
        expect(delivery).toEqual({ kind: "fenced" });
        expect(s.replies).toEqual([]);
        expect(s.sealed).toEqual([]);
      } else {
        expect(delivery).toEqual({ kind: "delivered" });
        expect(s.replies[0]).toContain("check the source and conversation access");
        expect(s.sealed).toEqual(["replyOk=true"]);
      }
    },
  );

  it.each([
    ["direct", true, "ok", false],
    ["direct", true, "ok", true],
    ["slack-context", true, "ok", false],
    ["direct", true, "fenced", false],
    ["direct", true, "unavailable", false],
    ["direct", false, "fenced", false],
    ["direct", false, "unavailable", false],
  ] as const)(
    "awaits the answer-event refusal before card close (%s, recovers=%s, write=%s, card throws=%s)",
    async (source, recovers, writeResult, cardThrows) => {
      const s = finishedRun(async () => "ok");
      const receipt = {
        version: 1 as const,
        causeAt: "answer-event" as const,
        withheldAt: "answer-event" as const,
        code: "direct-audience-unavailable" as const,
      };
      const audience: AudienceTrace = { refusal: receipt };
      const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
      const events: string[] = [];
      const committed: unknown[] = [];
      let releaseWrite!: () => void;
      const writeReady = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let reachedBoundary!: () => void;
      const boundary = new Promise<void>((resolve) => {
        reachedBoundary = resolve;
      });
      const delivery = deliverAnswer({
        ...s.ctx,
        agent: getAgent("orchestrator"),
        audience,
        msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
        io: {
          ...s.ctx.io,
          directAudience: () => dm,
          verifyDirectAudience: async () => (recovers ? { ok: true } : { ok: false, code: "direct-audience-denied" }),
        },
        ...(source === "slack-context"
          ? {
              slackContext: {
                initialize: async () => true,
                revalidate: async () => true,
                sourcesStillValid: async () => ({ ok: true as const }),
                capability: { read: async () => "private source fact" },
                destinationStillPrivate: async () => recovers,
                revoke: () => {},
              },
            }
          : {}),
        ledgerRun: {
          ...s.ctx.ledgerRun!,
          commitState: async (patch) => {
            events.push("write started");
            reachedBoundary();
            await writeReady;
            committed.push(patch);
            events.push(`write ${writeResult}`);
            return writeResult;
          },
        } as LedgerRun,
        card: {
          ...s.ctx.card,
          done: async (frame) => {
            events.push("card close");
            reachedBoundary();
            s.closes.push(frame);
            if (cardThrows) throw new Error("card unavailable");
          },
        },
        publicationCheck: async () => ({ ok: true }),
        answer: "private source fact",
        prNote: "private PR details",
      }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await boundary;
      const beforeWriteSettles = [...events];
      releaseWrite();
      const result = await delivery;
      expect(beforeWriteSettles).toEqual(["write started"]);
      expect(committed[0]).toEqual({ audienceRefusal: receipt });
      expect(audience.refusal).toEqual(receipt);
      expect(s.replies.join("\n")).not.toContain("private source fact");
      expect(s.replies.join("\n")).not.toContain("private PR details");
      if (writeResult === "fenced") {
        expect(result.value).toEqual({ kind: "fenced" });
        expect(s.closes).toEqual([]);
        expect(s.replies).toEqual([]);
        expect(s.sealed).toEqual([]);
      } else {
        expect(events.indexOf(`write ${writeResult}`)).toBeLessThan(events.indexOf("card close"));
        if (cardThrows) {
          expect(result.error).toEqual(new Error("card unavailable"));
          expect(s.replies).toEqual([]);
          expect(s.sealed).toEqual(["replyOk=undefined"]);
        } else {
          expect(result.value).toEqual({ kind: "delivered" });
          expect(s.replies[0]).toContain("withheld the answer");
          expect(s.sealed).toEqual(["replyOk=true"]);
        }
      }
      expect(s.releases).toEqual([1]);
    },
  );

  it("retains earlier answer withholding when the last check passes and omits the PR note", async () => {
    const s = finishedRun();
    const audience = {
      refusal: {
        version: 1 as const,
        causeAt: "answer-event" as const,
        withheldAt: "answer-event" as const,
        code: "direct-audience-unavailable" as const,
      },
    };
    await deliverAnswer({
      ...s.ctx,
      audience,
      answer: "private fact",
      prNote: "private PR details",
      publicationCheck: async () => ({ ok: true }),
    });
    expect(s.replies[0]).toContain("withheld the answer");
    expect(s.replies.join("\n")).not.toContain("private fact");
    expect(s.replies.join("\n")).not.toContain("private PR details");
    expect(audience.refusal.withheldAt).toBe("answer-event");
  });

  it("rechecks work state after the card closes without treating change as an audience refusal", async () => {
    const s = finishedRun();
    let changed = false;
    const audience = {};
    await deliverAnswer({
      ...s.ctx,
      audience,
      answer: "The work is running.",
      prNote: "Old work details",
      card: {
        ...s.ctx.card,
        done: async (frame) => {
          changed = true;
          s.closes.push(frame);
        },
      },
      publicationCheck: async () => ({ ok: true }),
      currentWorkCheck: async () => (changed ? "The work's current state remains unconfirmed." : undefined),
    });
    expect(s.replies).toEqual(["The work's current state remains unconfirmed."]);
    expect(audience).not.toHaveProperty("refusal");
  });

  it("rechecks source access after the card closes and before the channel reply", async () => {
    const s = finishedRun();
    let sourceReadable = true;
    let checks = 0;
    await deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      answer: "private source fact",
      card: {
        ...s.ctx.card,
        done: async (frame) => {
          sourceReadable = false;
          s.closes.push(frame);
        },
      },
      publicationCheck: async () => {
        checks++;
        return sourceReadable ? { ok: true } : { ok: false, code: "github-access-lost" };
      },
    });
    expect(checks).toBe(1);
    expect(s.replies[0]).toContain("A Switchboard operator can check the source and conversation access.");
    expect(JSON.stringify(s.closes)).not.toContain("private source fact");
  });

  it("rechecks a stamped private run without a Slack context binding before its reply", async () => {
    const s = finishedRun();
    const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
    let checks = 0;
    await deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
      io: {
        ...s.ctx.io,
        directAudience: () => dm,
        verifyDirectAudience: booleanAudienceVerifier(async () => ++checks === 1),
      },
      answer: "private worker fact",
      prNote: "private worker detail",
      shell: createCardShell({ label: "*main*", startedAt: NOW, now: () => NOW, verbosity: "debug" }),
      doneLines: () => ({ shape: "private timing", queued: "private queue" }),
    });
    expect(checks).toBe(2);
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).not.toContain("private worker");
    expect(JSON.stringify(s.closes)).not.toContain("step");
    expect(JSON.stringify(s.closes)).not.toContain("private timing");
  });

  it("seals the card and reply if source trust is revoked during audience verification", async () => {
    const s = finishedRun();
    const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
    const privateAudienceLatch = { revoked: false };
    let verifierStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verifierStarted = resolve;
    });
    let finishVerification!: (value: boolean) => void;
    const verifying = new Promise<boolean>((resolve) => {
      finishVerification = resolve;
    });
    const delivering = deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
      io: {
        ...s.ctx.io,
        directAudience: () => dm,
        verifyDirectAudience: booleanAudienceVerifier(() => {
          verifierStarted();
          return verifying;
        }),
      },
      privateAudienceLatch,
      answer: "private worker fact",
      prNote: "private worker detail",
    });
    await started;
    privateAudienceLatch.revoked = true;
    finishVerification(true);
    await delivering;
    expect(JSON.stringify({ replies: s.replies, closes: s.closes })).not.toContain("private worker");
  });

  it("seals the final reply if source trust is revoked during its last audience verification", async () => {
    const s = finishedRun();
    const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
    const privateAudienceLatch = { revoked: false };
    let verifierStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verifierStarted = resolve;
    });
    let finishVerification!: (value: boolean) => void;
    const verifying = new Promise<boolean>((resolve) => {
      finishVerification = resolve;
    });
    let checks = 0;
    const delivering = deliverAnswer({
      ...s.ctx,
      agent: getAgent("orchestrator"),
      msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
      io: {
        ...s.ctx.io,
        directAudience: () => dm,
        verifyDirectAudience: booleanAudienceVerifier(() =>
          ++checks === 1 ? Promise.resolve(true) : (verifierStarted(), verifying),
        ),
      },
      privateAudienceLatch,
      answer: "private worker fact",
      prNote: "private worker detail",
    });
    await started;
    privateAudienceLatch.revoked = true;
    finishVerification(true);
    await delivering;
    expect(checks).toBe(2);
    expect(JSON.stringify(s.replies)).not.toContain("private worker");
  });

  it("keeps a revoked private run sealed even if the DM verifier later answers true", async () => {
    const s = finishedRun();
    const dm = { channelId: "slack:DMAIN", userId: "slack:WALICE", threadKey: "slack:DMAIN:1.0" };
    let checks = 0;
    await deliverAnswer({
      ...s.ctx,
      msg: { ...s.ctx.msg, ...dm, directAudience: { kind: "slack-unshared-im", ...dm } },
      io: {
        ...s.ctx.io,
        directAudience: () => dm,
        verifyDirectAudience: booleanAudienceVerifier(async () => ++checks > 1),
      },
      answer: "private finding",
      prNote: "private PR note",
      verdict: { verdict: "request_changes", summary: "private review summary" },
    });
    expect(checks).toBe(1);
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).not.toContain("private finding");
    expect(s.replies[0]).not.toContain("private PR note");
    expect(s.replies[0]).not.toContain("private review summary");
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

  it("a confirmed user stop posts its terminal notice after cancellation sealed the record", async () => {
    const s = finishedRun(async () => "fenced");
    s.ctx.run.control.requestStop("hard");
    s.ctx.run.control.confirmCancellation();
    expect(await deliverAnswer({ ...s.ctx, stopped: "hard" })).toEqual({ kind: "delivered" });
    expect(s.replies).toEqual(["⏹ Stopped by user."]);
    expect(s.releases).toEqual([1]);
  });

  it.each(["card", "publication", "current-work", "refusal"] as const)(
    "Kill suppresses a reply after the pending %s wait",
    async (boundary) => {
      const s = finishedRun();
      const kill = async () => {
        s.ctx.run.control.requestKill();
      };
      const ctx = {
        ...s.ctx,
        ...(boundary === "card" ? { card: { ...s.ctx.card, done: kill } } : {}),
        ...(boundary === "publication"
          ? {
              publicationCheck: async () => {
                await kill();
                return { ok: true as const };
              },
            }
          : {}),
        ...(boundary === "current-work"
          ? {
              currentWorkCheck: async () => {
                await kill();
                return "new work";
              },
            }
          : {}),
        ...(boundary === "refusal"
          ? {
              publicationCheck: async () => ({ ok: false as const, code: "saved-context-unproved" as const }),
              ledgerRun: {
                finishing: async () => "ok",
                setState: () => {},
                commitState: async () => {
                  await kill();
                  return "ok";
                },
              } as unknown as LedgerRun,
            }
          : {}),
      };
      const delivery = await deliverAnswer(ctx);
      expect({ delivery, replies: s.replies, releases: s.releases }).toEqual({
        delivery: { kind: "fenced" },
        replies: [],
        releases: [1],
      });
    },
  );

  it("Kill suppresses a confirmed Stop notice pending card close", async () => {
    const s = finishedRun(async () => "fenced");
    s.ctx.run.control.requestStop("hard");
    s.ctx.run.control.confirmCancellation();
    await deliverAnswer({
      ...s.ctx,
      stopped: "hard",
      card: {
        ...s.ctx.card,
        done: async () => {
          s.ctx.run.control.requestKill();
        },
      },
    });
    expect({ replies: s.replies, releases: s.releases }).toEqual({ replies: [], releases: [1] });
  });

  it.each([true, false])(
    "Stop waits for the cancellation result before its notice: confirmed=%s",
    async (confirmed) => {
      const s = finishedRun(async () => "fenced");
      s.ctx.run.control.requestStop("hard");
      s.ctx.run.control.beginCancellation();
      const delivering = deliverAnswer({ ...s.ctx, stopped: "hard" });
      // Let delivery reach the pending cancellation before its result arrives.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (confirmed) s.ctx.run.control.confirmCancellation();
      else s.ctx.run.control.endCancellation();
      await delivering;
      expect({ replies: s.replies, releases: s.releases }).toEqual({
        replies: confirmed ? ["⏹ Stopped by user."] : [],
        releases: [1],
      });
    },
  );

  it("Stop waits for the remaining cancellation attempt after another returns unknown", async () => {
    const s = finishedRun(async () => "fenced");
    s.ctx.run.control.requestStop("hard");
    s.ctx.run.control.beginCancellation();
    s.ctx.run.control.beginCancellation();
    const delivering = deliverAnswer({ ...s.ctx, stopped: "hard" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.ctx.run.control.endCancellation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.ctx.run.control.confirmCancellation();
    s.ctx.run.control.endCancellation();
    await delivering;
    expect({ replies: s.replies, releases: s.releases }).toEqual({ replies: ["⏹ Stopped by user."], releases: [1] });
  });

  it.each(["card", "publication", "current-work"] as const)(
    "a late Stop replaces the pending %s answer with its terminal notice",
    async (boundary) => {
      const s = finishedRun();
      const stop = async () => {
        s.ctx.run.control.beginCancellation();
        await new Promise<void>((resolve) => setImmediate(resolve));
        s.ctx.run.control.confirmCancellation();
        s.ctx.run.control.endCancellation();
      };
      let firstClose = true;
      const card = {
        ...s.ctx.card,
        done: async () => {
          if (boundary === "card" && firstClose) {
            firstClose = false;
            await stop();
          }
        },
      };
      const delivery = await deliverAnswer({
        ...s.ctx,
        card,
        ...(boundary === "publication"
          ? {
              publicationCheck: async () => {
                await stop();
                return { ok: true as const };
              },
            }
          : {}),
        ...(boundary === "current-work"
          ? {
              currentWorkCheck: async () => {
                await stop();
                return "pending work";
              },
            }
          : {}),
      });
      expect({ delivery, replies: s.replies, releases: s.releases }).toEqual({
        delivery: { kind: "fenced" },
        replies: ["⏹ Stopped by user."],
        releases: [1],
      });
    },
  );

  it("an unconfirmed late Stop suppresses the pending answer", async () => {
    const s = finishedRun();
    await deliverAnswer({
      ...s.ctx,
      publicationCheck: async () => {
        s.ctx.run.control.beginCancellation();
        s.ctx.run.control.endCancellation();
        return { ok: true as const };
      },
    });
    expect({ replies: s.replies, releases: s.releases }).toEqual({ replies: [], releases: [1] });
  });

  it("kill sends no final answer and still releases the workspace", async () => {
    const s = finishedRun();
    s.ctx.run.control.requestKill();
    expect(await deliverAnswer({ ...s.ctx, stopped: "hard" })).toEqual({ kind: "fenced" });
    expect(s.releases).toEqual([1]);
    expect(s.replies).toEqual([]);
    expect(s.closes).toEqual([]);
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
