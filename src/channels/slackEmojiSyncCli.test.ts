import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/slack-emoji-sync.ts", import.meta.url));
const execute = promisify(execFile);

describe("manual emoji export", () => {
  it.each([
    { status: 403, error: "private upstream text", reason: "source_unavailable", slackError: undefined },
    { status: 200, error: "missing_scope", reason: "missing_scope", slackError: "missing_scope" },
  ])("reports HTTP $status and a known Slack code without raw response text", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "emoji-export-cli-"));
    try {
      const stub = join(directory, "fetch.mjs");
      await writeFile(
        stub,
        "globalThis.fetch = async () => new Response(process.env.EMOJI_TEST_RESPONSE, { status: Number(process.env.EMOJI_TEST_STATUS) });",
      );
      const result = await execute(
        process.execPath,
        ["--import", stub, "--import", "tsx", script, "--directory", directory],
        {
          env: {
            ...process.env,
            SLACK_EMOJI_TOKEN: "xoxb-fixture",
            EMOJI_TEST_RESPONSE: JSON.stringify({ ok: false, error: failure.error }),
            EMOJI_TEST_STATUS: String(failure.status),
          },
        },
      ).then(
        (value) => ({ code: 0, ...value }),
        (error) => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }),
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        status: "unavailable",
        total: null,
        available: 0,
        downloaded: 0,
        failed: 0,
        reason: failure.reason,
        stage: "slack_catalog",
        httpStatus: failure.status,
        ...(failure.slackError ? { slackError: failure.slackError } : {}),
        directory,
      });
      expect(result.stdout + result.stderr).not.toContain("private upstream text");
      expect(result.stdout + result.stderr).not.toContain("xoxb-fixture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows its usage and refuses non-token file contents before a request", async () => {
    const help = await execute(process.execPath, ["--import", "tsx", script, "--help"]);
    expect(help.stdout).toContain("Usage: npm run emoji:sync");
    const directory = await mkdtemp(join(tmpdir(), "emoji-export-cli-"));
    try {
      const file = join(directory, "not-a-token");
      await writeFile(file, "fixture private file contents", { mode: 0o600 });
      const result = await execute(process.execPath, [
        "--import",
        "tsx",
        script,
        "--directory",
        directory,
        "--token-file",
        file,
      ]).then(
        (value) => ({ code: 0, ...value }),
        (error) => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }),
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr.trim())).toEqual({
        event: "emoji.sync.failed",
        stage: "token",
        reason: "invalid_token_format",
      });
      expect(result.stdout + result.stderr).not.toContain("fixture private file contents");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("reports a missing token file by stage and fixed code without its contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emoji-export-cli-"));
    try {
      const result = await execute(process.execPath, [
        "--import",
        "tsx",
        script,
        "--directory",
        directory,
        "--token-file",
        join(directory, "missing"),
      ]).then(
        (value) => ({ code: 0, ...value }),
        (error) => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }),
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr.split("\n")[0])).toEqual({
        event: "emoji.sync.failed",
        stage: "token_file",
        errorCode: "ENOENT",
        reason: "operation_failed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
