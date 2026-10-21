import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const commit = "a".repeat(40);
const checks = [
  ...["change plan", "bot", "web", "docs", "workers", "image", "package"].map((name, index) => ({
    id: index + 1,
    name: `ci / ${name}`,
    status: "completed",
    conclusion: "success",
    app: { slug: "depot-code-access" },
  })),
  { id: 10, name: "pr-title / title", status: "completed", conclusion: "success", app: { slug: "depot-code-access" } },
  { id: 11, name: "CodeQL", status: "completed", conclusion: "success", app: { slug: "github-advanced-security" } },
  { id: 12, name: "zizmor", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
];

function runValidation(mode: "transient" | "unavailable" | "denied" | "deferred" | "limited") {
  const directory = mkdtempSync(join(tmpdir(), "staging-github-read-"));
  try {
    const preload = join(directory, "fetch.mjs");
    const output = join(directory, "output");
    const calls = join(directory, "calls");
    writeFileSync(
      preload,
      `import { appendFileSync } from "node:fs";
let pullReads = 0;
globalThis.fetch = async (url, init) => {
  const request = new URL(String(url));
  const path = request.pathname.replace("/repos/acme/api/", "") + request.search;
  appendFileSync(process.env.STAGING_TEST_CALLS, JSON.stringify({path, method: init?.method ?? "GET"}) + "\\n");
  if (path === "pulls/7") {
    pullReads++;
    if (process.env.STAGING_TEST_MODE === "unavailable" || (process.env.STAGING_TEST_MODE === "transient" && pullReads === 1))
      return Response.json({message:"temporary GitHub error"}, {status:503});
    if (process.env.STAGING_TEST_MODE === "deferred")
      return Response.json({message:"temporary GitHub error"}, {status:503,headers:{"retry-after":"60"}});
    if (process.env.STAGING_TEST_MODE === "limited")
      return Response.json({message:"temporary GitHub error"}, {status:503,headers:{"x-ratelimit-remaining":"0"}});
    if (process.env.STAGING_TEST_MODE === "denied") return Response.json({message:"forbidden"}, {status:403});
    return Response.json({number:7,state:"open",user:{login:"maintainer"},head:{ref:"release-please--branches--main--components--switchboard",sha:"${commit}",repo:{full_name:"acme/api"}},labels:[]});
  }
  if (path === "commits/${commit}/check-runs?per_page=100&page=1") return Response.json({check_runs:${JSON.stringify(checks)}});
  throw new Error("unexpected GitHub read: " + path);
};`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", preload, "scripts/staging-validate.ts"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "acme/api",
          STAGING_COMMIT: commit,
          STAGING_PR_NUMBER: "7",
          STAGING_AUTOMATIC: "true",
          STAGING_VALIDATE_MODE: "recheck",
          STAGING_REQUIRE_LABEL: "false",
          GH_TOKEN: "fixture-only",
          GITHUB_OUTPUT: output,
          STAGING_TEST_CALLS: calls,
          STAGING_TEST_MODE: mode,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(output, "utf8"),
      calls: readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("staging validation GitHub reads", () => {
  it("admits the exact release head after one transient GitHub 503", () => {
    const result = runValidation("transient");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Staging validation: GitHub pull returned HTTP 503; retrying the same GET once.");
    expect(result.output).toBe(`eligible=false\ncommit=${commit}\npr=7\neligible=true\ncommit=${commit}\npr=7\n`);
    expect(result.calls).toEqual([
      { path: "pulls/7", method: "GET" },
      { path: "pulls/7", method: "GET" },
      { path: `commits/${commit}/check-runs?per_page=100&page=1`, method: "GET" },
    ]);
  });

  it.each([
    { mode: "unavailable", status: 503, reads: 2 },
    { mode: "denied", status: 403, reads: 1 },
    { mode: "deferred", status: 503, reads: 1 },
    { mode: "limited", status: 503, reads: 1 },
  ] as const)("keeps a $status response terminal after at most $reads read(s)", ({ mode, status, reads }) => {
    const result = runValidation(mode);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Staging validation cannot read GitHub pull (HTTP ${status})`);
    expect(result.output).toBe(`eligible=false\ncommit=${commit}\npr=7\n`);
    expect(result.calls).toEqual(Array.from({ length: reads }, () => ({ path: "pulls/7", method: "GET" })));
  });
});
