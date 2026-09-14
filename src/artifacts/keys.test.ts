import { describe, expect, it } from "vitest";
import { inboundKey, outboundKey, safeBasename, threadKeySafe } from "./keys.js";

// Feature: docs/reference/specs/execution.md item 20 — artifact keys: a
// per-file leaf under the run (outbound) or the thread and message (inbound),
// and a basename reduced to one character class so a Slack filename is shell-,
// URL- and key-safe by construction.

describe("safeBasename (item 20)", () => {
  it("keeps the last path segment and reduces every other character to `_`, collapsing runs", () => {
    expect(safeBasename("../../etc/passwd")).toBe("passwd");
    expect(safeBasename("shots/verdict-dark.png")).toBe("verdict-dark.png");
    expect(safeBasename("C:\\Users\\me\\clip.mp4")).toBe("clip.mp4");
    expect(safeBasename('clip"; echo pwned; ".mp4')).toBe("clip_echo_pwned_.mp4");
    expect(safeBasename("$(id).mp4")).toBe("_id_.mp4");
    expect(safeBasename("my clip (final).MOV")).toBe("my_clip_final_.MOV");
    expect(safeBasename("résumé.pdf")).toBe("r_sum_.pdf");
  });

  it("never answers empty, a bare `..`, or a run of dots and dashes", () => {
    expect(safeBasename("")).toBe("file");
    expect(safeBasename("..")).toBe("file");
    expect(safeBasename("...")).toBe("file");
    expect(safeBasename("///")).toBe("file");
    expect(safeBasename("---")).toBe("file");
    expect(safeBasename("a..b")).toBe("a_b");
    expect(safeBasename(".env")).toBe(".env");
  });
});

describe("key builders (item 20)", () => {
  it("outbound keys live under the run with a per-file sequence; inbound under the thread and message with the file's index", () => {
    expect(outboundKey("run-1", 1, "screenshot.png")).toBe("runs/run-1/out/1-screenshot.png");
    expect(outboundKey("run-1", 2, "screenshot.png")).toBe("runs/run-1/out/2-screenshot.png");
    expect(inboundKey("slack:CX:1.0", "1789365838.340499", 1, "clip.mp4")).toBe(
      "threads/slack-CX-1.0/in/1789365838.340499/1-clip.mp4",
    );
    expect(inboundKey("slack:CX:1.0", "1789365838.340499", 2, "clip.mp4")).toBe(
      "threads/slack-CX-1.0/in/1789365838.340499/2-clip.mp4",
    );
  });

  it("threadKeySafe turns the platform-namespaced key into one segment", () => {
    expect(threadKeySafe("slack:CX:1.0")).toBe("slack-CX-1.0");
    expect(threadKeySafe("cli:work/child-1")).toBe("cli-work_child-1");
  });
});
