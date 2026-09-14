import { describe, expect, it } from "vitest";
import { MAX_READ_BYTES } from "../execution/binaryRead.js";
import type { Executor } from "../execution/executor.js";
import { attachFileTool } from "./attach.js";
import { TOOLSETS, type ToolContext } from "./workspace.js";

// Feature: docs/reference/specs/agent-coding.md item 10 — a run's screenshot
// reaches the person: `attach_file` reads the workspace file as bytes off the
// Executor seam and posts it through the channel's file upload; each missing
// half is named, never papered over.

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function executor(files: Record<string, Uint8Array | Error>, opts: { bytes?: false } = {}): Executor {
  const base: Executor = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  if (opts.bytes === false) return base;
  return {
    ...base,
    readBytes: async (path) => {
      const f = files[path];
      if (!f) throw new Error(`read-failed: cat: ${path}: No such file or directory`);
      if (f instanceof Error) throw f;
      return f;
    },
  };
}

function attaching(fail?: Error) {
  const posted: Array<{ name: string; bytes: Uint8Array; lead: string }> = [];
  const attach: ToolContext["attach"] = async (file) => {
    if (fail) throw fail;
    posted.push(file);
  };
  return { posted, attach };
}

describe("attach_file toolset wiring", () => {
  it("is in the coding (full) toolset only — a read-only or workspace-less agent never posts files", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("attach_file");
    for (const key of ["readonly", "web", "assistant", "explore", "conductor", "none"]) {
      expect(names(key), key).not.toContain("attach_file");
    }
    expect(attachFileTool.sideEffectFree).toBeUndefined(); // it posts: strictly in order
    expect(attachFileTool.description).toContain(String(MAX_READ_BYTES));
  });
});

describe("attach_file", () => {
  it("posts the file's bytes under its own name with the comment as the lead", async () => {
    const { posted, attach } = attaching();
    const out = await attachFileTool.run(
      { path: "shots/verdict-dark.png", comment: "PR verdict mock — dark" },
      { executor: executor({ "shots/verdict-dark.png": png }), attach },
    );
    expect(out).toBe("attached verdict-dark.png (7 bytes) to the conversation");
    expect(posted).toEqual([{ name: "verdict-dark.png", bytes: png, lead: "PR verdict mock — dark" }]);
  });

  it("the lead defaults to the file name when no comment is given", async () => {
    const { posted, attach } = attaching();
    await attachFileTool.run({ path: "out.pdf", comment: "  " }, { executor: executor({ "out.pdf": png }), attach });
    expect(posted[0]).toMatchObject({ name: "out.pdf", lead: "out.pdf" });
  });

  it("without the channel's upload it says the conversation takes no files — and reads nothing", async () => {
    let reads = 0;
    const ex: Executor = {
      ...executor({}),
      readBytes: async () => {
        reads++;
        return png;
      },
    };
    const out = await attachFileTool.run({ path: "a.png" }, { executor: ex });
    expect(out).toMatch(/not available here: this conversation's channel takes no file uploads — link to the file/);
    expect(reads).toBe(0);
  });

  it("on an executor without a byte read it says the workspace cannot hand files over — and posts nothing", async () => {
    const { posted, attach } = attaching();
    const out = await attachFileTool.run({ path: "a.png" }, { executor: executor({}, { bytes: false }), attach });
    expect(out).toMatch(/not available here: this workspace cannot hand files over — link to the file/);
    expect(posted).toEqual([]);
  });

  it("a missing file, an over-cap file and an empty file are each named; nothing is posted", async () => {
    const { posted, attach } = attaching();
    const ctx = {
      executor: executor({
        "big.mp4": new Error("big.mp4 is over the 10485760-byte cap of a binary read"),
        "empty.png": new Uint8Array(0),
      }),
      attach,
    };
    expect(await attachFileTool.run({ path: "gone.png" }, ctx)).toBe(
      "error: could not read gone.png: read-failed: cat: gone.png: No such file or directory",
    );
    expect(await attachFileTool.run({ path: "big.mp4" }, ctx)).toMatch(/could not read big.mp4: .*over the .*cap/);
    expect(await attachFileTool.run({ path: "empty.png" }, ctx)).toBe("error: empty.png is empty — nothing to attach");
    expect(await attachFileTool.run({ path: "  " }, ctx)).toBe("error: path is required");
    expect(posted).toEqual([]);
  });

  it("a refused upload (a missing scope, an API error) is reported with the platform's message, never swallowed", async () => {
    const { attach } = attaching(new Error("An API error occurred: missing_scope"));
    const out = await attachFileTool.run({ path: "a.png" }, { executor: executor({ "a.png": png }), attach });
    expect(out).toBe("error: the channel refused the upload of a.png: An API error occurred: missing_scope");
  });
});
