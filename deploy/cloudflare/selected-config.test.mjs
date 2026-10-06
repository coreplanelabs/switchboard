import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as ensureBuckets } from "./ensure-bucket.mjs";
import { main as preflight, APP_NAME } from "./preflight.mjs";

const processCalls = vi.hoisted(() => []);
vi.mock("node:child_process", () => ({
  execFile(command, args, options, callback) {
    processCalls.push({ command, args, options });
    const output = args.includes("containers") ? JSON.stringify([{ name: APP_NAME, state: "active" }]) : "created";
    callback(null, output, "");
  },
}));
const directories = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  processCalls.splice(0);
  vi.unstubAllGlobals();
});

describe("selected deployment config", () => {
  it("bucket creation reads and passes the selected config while the shared config names another account and bucket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "selected-worker-config-"));
    directories.push(directory);
    const selected = join(directory, "selected.jsonc");
    writeFileSync(selected, JSON.stringify({ account_id: "account-a", r2_buckets: [{ bucket_name: "bucket-a" }] }));
    writeFileSync(
      join(directory, "wrangler.jsonc"),
      JSON.stringify({ account_id: "account-b", r2_buckets: [{ bucket_name: "bucket-b" }] }),
    );
    expect(await ensureBuckets(directory, selected)).toBe(0);
    expect(processCalls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "npx", args: ["wrangler", "r2", "bucket", "create", "bucket-a", "--config", selected] },
    ]);
  });

  it("Bot preflight passes the operation's selected config to the native application listing", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ inFlight: 0, draining: false }));
    const selected = "/selected/account-a/wrangler.jsonc";
    expect(
      await preflight([], { SWITCHBOARD_BASE_URL: "https://bot-a.example.test", SWITCHBOARD_DEPLOY_CONFIG: selected }),
    ).toBe(0);
    expect(processCalls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "npx", args: ["wrangler", "containers", "list", "--json", "--config", selected] },
    ]);
  });
});
