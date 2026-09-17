import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isBackupMissing,
  parseSeed,
  SEED_BUDGET_MS,
  SEED_CHECKOUT_DIR,
  SEED_DEPS_STAGING_DIR,
  SEED_FIXUP_TIMEOUT_MS,
  SEED_MARKER,
  SEED_REASONS,
  SEED_RESTORE_MAX_MS,
  SEED_ABANDONED_RESTORE_WAIT_MS,
  seedFixupScript,
  seedForThread,
  seedMarkerText,
  seedRetryDecision,
  seededSandboxNote,
  type SandboxSeed,
} from "./seedPlan.js";

// The seeded sandbox (docs/reference/specs/execution.md item 25): a cold
// sandbox restores the resident's checkout snapshot — and the deps-store
// entry for its lockfile key — before its first command, then fixes ownership
// and origin and checks the thread's ref out. This module is the plan's pure
// half: the handle's shape, the fix-up script, the classification of a
// restore whose objects are gone. The Worker runs it; the bot forwards it.

const seed: SandboxSeed = {
  slug: "acme/widgets",
  checkoutBackupId: "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
  depsBackupId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
  ref: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

describe("parseSeed", () => {
  it("accepts the resident's handle with the thread's ref and head riding along", () => {
    const parsed = parseSeed({ ...seed, fetchRef: "feat/x", fetchSha: "89abcdef0123456789abcdef0123456789abcdef" });
    expect(parsed).toEqual({
      ok: true,
      seed: { ...seed, fetchRef: "feat/x", fetchSha: "89abcdef0123456789abcdef0123456789abcdef" },
    });
  });

  it("accepts a handle without a deps entry or a thread ref: the checkout alone, on the snapshot's branch", () => {
    const { depsBackupId: _omitted, ...bare } = seed;
    expect(parseSeed(bare)).toEqual({ ok: true, seed: bare });
  });

  it("names what is wrong: a missing or malformed id, slug, ref or sha, or no object at all", () => {
    const bad = (v: unknown) => {
      const r = parseSeed(v);
      return r.ok ? "accepted" : r.error;
    };
    expect(bad(undefined)).toBe("seed: not an object");
    expect(bad({ ...seed, checkoutBackupId: "../etc" })).toBe("seed: checkoutBackupId is not a backup id");
    expect(bad({ ...seed, depsBackupId: "" })).toBe("seed: depsBackupId is not a backup id");
    expect(bad({ ...seed, slug: "acme" })).toBe("seed: slug is not owner/name");
    expect(bad({ ...seed, ref: "-rf" })).toBe("seed: ref is not a branch name");
    expect(bad({ ...seed, fetchRef: "a..b" })).toBe("seed: fetchRef is not a branch name");
    expect(bad({ ...seed, sha: "abc" })).toBe("seed: sha is not a commit sha");
    expect(bad({ ...seed, fetchSha: "ABC" })).toBe("seed: fetchSha is not a commit sha");
  });
});

describe("seedFixupScript", () => {
  it("runs as one failing-fast script: ownership, origin, the deps view moved in, the thread's ref fetched and checked out, the head printed last", () => {
    const script = seedFixupScript({
      ...seed,
      fetchRef: "feat/x",
      fetchSha: "89abcdef0123456789abcdef0123456789abcdef",
      checkoutDir: SEED_CHECKOUT_DIR,
      depsDir: SEED_DEPS_STAGING_DIR,
    });
    expect(script.split("\n")).toEqual([
      "set -e",
      "cd '/workspace/checkout'",
      "chown -R 0:0 .",
      "git remote set-url origin 'https://github.com/acme/widgets.git'",
      "rm -rf node_modules",
      "mv '/workspace/.seed-deps' node_modules",
      "git fetch --no-tags origin '+refs/heads/feat/x:refs/remotes/origin/feat/x'",
      "if git cat-file -e '89abcdef0123456789abcdef0123456789abcdef''^{commit}' 2>/dev/null; then git checkout -q -B 'feat/x' '89abcdef0123456789abcdef0123456789abcdef'; else git checkout -q -B 'feat/x' 'origin/feat/x'; fi",
      "git rev-parse HEAD",
    ]);
  });

  it("without a thread ref the checkout stays on the snapshot's branch; without a deps entry nothing is moved", () => {
    const script = seedFixupScript({ ...seed, checkoutDir: SEED_CHECKOUT_DIR });
    expect(script).not.toContain("git fetch");
    expect(script).not.toContain("node_modules");
    expect(script).toContain("git checkout -q -B 'main'");
    expect(script.split("\n").at(-1)).toBe("git rev-parse HEAD");
  });

  it("quotes the values it interpolates: a ref with shell metacharacters never reaches the shell bare", () => {
    const script = seedFixupScript({ ...seed, fetchRef: "feat/$x", checkoutDir: SEED_CHECKOUT_DIR });
    expect(script).toContain("'feat/$x'");
    expect(script).not.toMatch(/(^|\s)feat\/\$x(\s|$)/m);
  });

  it("carries no credential: the fetch authenticates through the image's credential helper and the exec env", () => {
    const script = seedFixupScript({ ...seed, fetchRef: "feat/x", checkoutDir: SEED_CHECKOUT_DIR });
    expect(script).not.toMatch(/GH_TOKEN|x-access-token|ghs_/);
  });
});

describe("the seed's constants", () => {
  it("everything the seed writes lives under /workspace, where the SDK allows a restore's dir", () => {
    for (const p of [SEED_CHECKOUT_DIR, SEED_DEPS_STAGING_DIR, SEED_MARKER])
      expect(p.startsWith("/workspace/")).toBe(true);
    expect(new Set([SEED_CHECKOUT_DIR, SEED_DEPS_STAGING_DIR, SEED_MARKER]).size).toBe(3);
  });

  it("the client's budget covers both restores' shared cap and the fix-up, with room for the answer", () => {
    expect(SEED_BUDGET_MS).toBeGreaterThan(SEED_RESTORE_MAX_MS + SEED_FIXUP_TIMEOUT_MS);
    // the wait for an abandoned restore fits inside the seed's own caps, so a failed seed still answers in budget
    expect(SEED_ABANDONED_RESTORE_WAIT_MS).toBeLessThan(SEED_RESTORE_MAX_MS);
    expect(SEED_REASONS).toEqual(["seed-missing", "seed-failed", "seed-unconfigured"]);
  });
});

describe("isBackupMissing", () => {
  it("recognizes the SDK's missing-backup error by name across the RPC boundary, and by its two texts", () => {
    expect(isBackupMissing({ name: "BackupNotFoundError", message: "" })).toBe(true);
    expect(isBackupMissing({ message: "Backup not found: 3f2a. Verify the backup ID is correct" })).toBe(true);
    expect(
      isBackupMissing({ message: "Backup archive not found in R2: 3f2a. The archive may have been deleted" }),
    ).toBe(true);
    expect(isBackupMissing({ name: "TimeoutError", message: "restore timed out" })).toBe(false);
    expect(isBackupMissing({ message: "" })).toBe(false);
  });
});

// The sandbox Worker cannot run under vitest (a Durable Object and a
// container); its use of the plan is held statically, as sandboxLifecycle's
// wiring is, together with the image, the template and the secrets manifest.
describe("the seeded sandbox wiring (static)", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const worker = read("deploy/cloudflare-sandbox/worker.ts");

  it("POST /seed parses the handle by field, then runs the seed inside the idle ledger and behind the start gate, streamed", () => {
    expect(worker).toMatch(
      /case "\/seed": \{[\s\S]*?parseSeed\(body\.seed\)[\s\S]*?streamSeed\(\(\) => sandbox\.seed\(/,
    );
    expect(worker).toMatch(
      /async seed\([\s\S]*?this\.idle\.served\(\(\) =>\s*this\.gate\.through\(\s*\(\) => this\.seedNow\(/,
    );
  });

  it("presigned only: the transfer mode is read first and a local-mode Worker answers seed-unconfigured", () => {
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow.indexOf("backupTransferMode(")).toBeLessThan(seedNow.indexOf("SEED_MARKER"));
    expect(seedNow).toContain('reason: "seed-unconfigured"');
  });

  it("the marker is read before any restore and written after the fix-up; the same handle answers cached", () => {
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow.indexOf('["cat", SEED_MARKER]')).toBeLessThan(seedNow.indexOf("restoreSeedInto("));
    expect(seedNow).toContain("marker.stdout.trim() === seedMarkerText(seed)");
    expect(seedNow).toContain("cached: true");
    expect(seedNow.indexOf("printf %s ${shellQuote(seedMarkerText(seed))}")).toBeGreaterThan(
      seedNow.indexOf("seedFixupScript("),
    );
  });

  it("every restore answers its two phases — the download judged by bytes, then the extraction — and the seed carries them as `phases` in its answer and its log line", () => {
    const restore = worker.slice(
      worker.indexOf("private async restoreSeedInto("),
      worker.indexOf("private readonly pendingRestores"),
    );
    expect(restore).toContain("): Promise<RestorePhases> {");
    expect(restore.indexOf("const download = systemClock() - startedMs;")).toBeLessThan(
      restore.indexOf("extractRestoreScript({"),
    );
    expect(restore).toContain("const extract = systemClock() - extractStartedMs;");
    expect(restore).toContain('event: "sandbox.seed-restore"');
    expect(restore).toContain("return { download, extract };");
    const seedNow = worker.slice(worker.indexOf("private async seedNow("), worker.indexOf("private seedSweep("));
    expect(seedNow).toContain("const phases: SeedPhases = { checkout, deps: null };");
    expect(seedNow).toMatch(/event: "sandbox\.seeded",[\s\S]*?phases,/);
    expect(seedNow).toMatch(/return \{\s*seeded: true,\s*cached: false,[\s\S]*?phases,[\s\S]*?\};/);
  });

  it("every restore is judged by bytes against the seed's one deadline and extracted onto the disk; a failure sweeps mounts, tree and marker and is classified missing or failed", () => {
    expect(worker).toMatch(/judgeRestoreProgress\(\{ startedMs, nowMs: systemClock\(\), samples, deadlineMs \}\)/);
    expect(worker).toMatch(
      /extractRestoreScript\(\{ mountDir, backupId: id, archivePath: restoreArchivePath\(id\), targetDir \}\)/,
    );
    expect((worker.match(/unmountAllRestoresScript\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(worker).toContain('isBackupMissing(shape) ? "seed-missing" : "seed-failed"');
  });

  it("the streamed /seed answer has its own root, keeps a start or a full fleet's wait token, and never answers a throw as anything but seed-failed", () => {
    const streamSeed = worker.slice(worker.indexOf("function streamSeed("), worker.indexOf("type WaitAnswer ="));
    expect(streamSeed).toContain('"sandbox.seed"');
    expect(streamSeed).toContain("fleetBusyAnswer(raw)");
    expect(streamSeed).toContain("runtimeUnreachableAnswer(raw)");
    expect(streamSeed).toContain('reason: "seed-failed"');
  });

  it("a restore-progress sample the container could not take is no evidence — never the seed's failure", () => {
    const du = worker.slice(worker.indexOf("private async duKiB("), worker.indexOf("private async runRoot("));
    expect(du).toMatch(
      /try \{\s*r = await this\.runRoot\(\["du", "-sk", \.\.\.paths\], 30_000\);\s*\} catch \{\s*return null;/,
    );
    expect(du).toContain("if (r.exitCode === 124) return null;");
  });

  it("/healthz says which transfer mode is live, so a receipt can tell a seedable Worker from one that is not", () => {
    expect(worker).toMatch(/\/healthz[\s\S]*?backupTransfer: backupTransferMode\(/);
  });

  it("the image carries squashfs-tools and proves unsquashfs at build time, as the resident's does", () => {
    const dockerfile = read("deploy/cloudflare-sandbox/Dockerfile");
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends [^\n]*squashfs-tools/);
    expect(dockerfile).toContain("command -v unsquashfs >/dev/null");
  });

  it("the template binds the resident's cache bucket and names it, inside a block a profile without a resident drops", () => {
    const template = read("deploy/cloudflare-sandbox/wrangler.template.jsonc");
    const block = template.slice(template.indexOf("// {{#if resident}}"), template.indexOf("// {{/if}}"));
    expect(block).toContain('"BACKUP_BUCKET_NAME": "{{resident.script}}-cache"');
    expect(block).toContain(
      '"r2_buckets": [{ "binding": "BACKUP_BUCKET", "bucket_name": "{{resident.script}}-cache" }]',
    );
    expect(block).toContain('"CLOUDFLARE_ACCOUNT_ID": "{{account}}"');
  });

  it("the R2 token reaches the sandbox Worker too, optional on both", () => {
    const manifest = JSON.parse(read("deploy/secrets.manifest.json")) as {
      secrets: Array<{ name: string; workers: string[]; optional?: unknown }>;
    };
    for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
      const entry = manifest.secrets.find((s) => s.name === name);
      expect(entry?.workers).toEqual(["resident", "sandbox"]);
      expect(entry?.optional).toBe(true);
    }
  });

  it("the resident publishes the snapshot handle — the checkout's id and the deps entry's — on /status, the route the bot probes", () => {
    const resident = read("deploy/cloudflare-resident/worker.ts");
    const handle = resident.slice(
      resident.indexOf("async snapshotHandle("),
      resident.indexOf("async getResidentInfo("),
    );
    expect(handle).toContain("checkoutBackupId: record.checkout.id");
    expect(handle).toContain("depsBackupId: (await this.depsBackupRecord(record.lockfileHash))?.backup.id ?? null");
    const status = resident.slice(resident.indexOf("async function handleStatus("));
    const body = status.slice(0, status.indexOf("\n}\n"));
    expect(body).toContain("stub.snapshotHandle()");
    expect(body).toMatch(/return json\(\{[\s\S]*?\bsnapshot,[\s\S]*?\}\);/);
  });
});

describe("the seeded sandbox wiring (static) — a restore the judge gave up on", () => {
  const worker = readFileSync(new URL("../../deploy/cloudflare-sandbox/worker.ts", import.meta.url), "utf8");
  it("is remembered until it settles, never rejects unhandled, and is waited for (bounded) before the failure sweep", () => {
    expect(worker).toMatch(/this\.pendingRestores\.add\(restore\);\s*restore\.then\(/);
    const catchBlock = worker.slice(worker.indexOf("    } catch (err) {", worker.indexOf("private async seedNow(")));
    expect(catchBlock.indexOf("settlePendingRestores(SEED_ABANDONED_RESTORE_WAIT_MS)")).toBeGreaterThan(-1);
    expect(catchBlock.indexOf("settlePendingRestores(")).toBeLessThan(catchBlock.indexOf("unmountAllRestoresScript()"));
  });
});

describe("seedMarkerText", () => {
  it("names the handle, the ref the tree is on and the head asked for, so a seed on another ref is a new seed", () => {
    expect(seedMarkerText(seed)).toBe(`${seed.checkoutBackupId} main -`);
    expect(seedMarkerText({ ...seed, fetchRef: "feat/x" })).toBe(`${seed.checkoutBackupId} feat/x -`);
    expect(seedMarkerText({ ...seed, fetchRef: "feat/x", fetchSha: "89abcdef0123456789abcdef0123456789abcdef" })).toBe(
      `${seed.checkoutBackupId} feat/x 89abcdef0123456789abcdef0123456789abcdef`,
    );
    expect(seedMarkerText({ ...seed, fetchRef: "feat/y" })).not.toBe(seedMarkerText({ ...seed, fetchRef: "feat/x" }));
  });
});

// The bot's half of the plan (docs/reference/specs/execution.md item 26): the
// thread's seed from the resident's handle, the retry-then-cold decision after
// a refusal, the card's line.
describe("seedForThread", () => {
  const handle = {
    checkoutBackupId: seed.checkoutBackupId,
    depsBackupId: seed.depsBackupId!,
    ref: "main",
    sha: seed.sha,
  };
  it("carries the handle and the thread's ref and head; a thread without a ref stays on the snapshot's branch", () => {
    expect(
      seedForThread(handle, {
        slug: "acme/widgets",
        ref: "feat/x",
        headSha: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    ).toEqual({
      ...seed,
      fetchRef: "feat/x",
      fetchSha: "89abcdef0123456789abcdef0123456789abcdef",
    });
    expect(seedForThread(handle, { slug: "acme/widgets" })).toEqual(seed);
    // a head without a ref is nothing to check out
    expect(
      seedForThread(handle, { slug: "acme/widgets", headSha: "89abcdef0123456789abcdef0123456789abcdef" }),
    ).toEqual(seed);
  });
  it("a handle without a deps entry seeds the checkout alone", () => {
    const { depsBackupId: _d, ...bare } = handle;
    expect(seedForThread(bare, { slug: "acme/widgets" })).not.toHaveProperty("depsBackupId");
  });
});

describe("seedRetryDecision", () => {
  const attempted = { ...seed, fetchRef: "feat/x" };
  const missing = {
    seeded: false as const,
    reason: "seed-missing" as const,
    detail: "restore: Backup not found: 3f2a",
  };
  it("the handle's objects gone and a newer handle published → retry once with it, on the same thread ref", () => {
    const fresh = {
      checkoutBackupId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000",
      ref: "main",
      sha: "89abcdef0123456789abcdef0123456789abcdef",
    };
    expect(seedRetryDecision({ answer: missing, attempted, fresh, alreadyRetried: false })).toEqual({
      action: "retry",
      seed: {
        slug: seed.slug,
        checkoutBackupId: fresh.checkoutBackupId,
        ref: "main",
        sha: fresh.sha,
        fetchRef: "feat/x",
      },
    });
  });
  it("the same handle again, or none, or a second miss → cold, saying why", () => {
    const same = { checkoutBackupId: seed.checkoutBackupId, ref: "main", sha: seed.sha };
    expect(seedRetryDecision({ answer: missing, attempted, fresh: same, alreadyRetried: false })).toEqual({
      action: "cold",
      why: "seed missing (restore: Backup not found: 3f2a) and the resident published no newer handle",
    });
    expect(seedRetryDecision({ answer: missing, attempted, fresh: undefined, alreadyRetried: false }).action).toBe(
      "cold",
    );
    expect(
      seedRetryDecision({
        answer: missing,
        attempted,
        fresh: { ...same, checkoutBackupId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000" },
        alreadyRetried: true,
      }).action,
    ).toBe("cold");
  });
  it("a failed or unconfigured seed is never retried", () => {
    expect(
      seedRetryDecision({
        answer: { seeded: false, reason: "seed-failed", detail: "fixup: fix-up exited 128", step: "fixup" },
        attempted,
        fresh: { checkoutBackupId: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000", ref: "main", sha: seed.sha },
        alreadyRetried: false,
      }),
    ).toEqual({ action: "cold", why: "seed failed (fixup: fix-up exited 128)" });
    expect(
      seedRetryDecision({
        answer: { seeded: false, reason: "seed-unconfigured", detail: "presigned R2 transfer needs R2_ACCESS_KEY_ID" },
        attempted,
        fresh: undefined,
        alreadyRetried: false,
      }),
    ).toEqual({ action: "cold", why: "seed unconfigured (presigned R2 transfer needs R2_ACCESS_KEY_ID)" });
  });
});

describe("seededSandboxNote", () => {
  it("names the reason the resident was not used, then what the sandbox was seeded from — ref@sha7", () => {
    expect(
      seededSandboxNote("resident degraded (disk-pressure)", {
        slug: "acme/widgets",
        ref: "feat/x",
        sha: "89abcdef0123456789abcdef0123456789abcdef",
        cached: false,
      }),
    ).toBe(
      "resident degraded (disk-pressure) — seeded sandbox · from resident snapshot · acme/widgets · feat/x@89abcde",
    );
    expect(
      seededSandboxNote("resident restoring", { slug: "a/b", ref: "main", sha: seed.sha, cached: true }),
    ).toContain("(already seeded)");
  });
});
