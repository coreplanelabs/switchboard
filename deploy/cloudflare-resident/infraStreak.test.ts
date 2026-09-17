import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// Item 67 (docs/reference/specs/resident-repos.md): consecutive refresh cycles
// that fail in the resident's OWN steps climb a ladder — count, recreate the
// container, down into item 36's rebuild — while a failure in the repository's
// command keeps parking. Plain Node, the entry read as text, never loaded —
// like runtimeUnreachable.test.ts and autoRebuild.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("the count lives in storage under one key", () => {
  it("noteInfraStreak is the one writer that bumps it; refreshComplete, a repo-step failure, the down rung and the fault injection are its erasers", () => {
    expect(source).toMatch(/^const INFRA_STREAK_KEY = "resident:infraStreak";$/m);
    expect(method("noteInfraStreak")).toMatch(/this\.ctx\.storage\.put\(INFRA_STREAK_KEY, row\)/);
    expect(method("refreshComplete")).toMatch(/storage\.delete\(INFRA_STREAK_KEY\)/);
    const others = residentDO.replace(method("noteInfraStreak"), "").replace(method("debugSetInfraStreak"), "");
    expect(others).not.toMatch(/storage\.put\(INFRA_STREAK_KEY/);
  });
});

describe("refreshFailed climbs the ladder for resident steps and parks for repo steps", () => {
  const body = () => method("refreshFailed");

  it("a repo-command step's failure is degraded as before and ends the resident-step streak", () => {
    const b = body();
    const repo = b.indexOf("if (isRepoCommandStep(failure.step))");
    expect(repo).toBeGreaterThan(-1);
    const branch = b.slice(repo, b.indexOf("const row = await this.noteInfraStreak"));
    expect(branch).toMatch(/storage\.delete\(INFRA_STREAK_KEY\)/);
    expect(branch).toMatch(/setResidentState\("degraded", failure\.reason\)/);
  });

  it("a resident step's failure is counted and the rung decides: count → degraded; recreate → recreateContainer with the infra-streak reason; down → destroy, forget the runtime identity, clear the row, goDown", () => {
    const b = body();
    expect(b).toMatch(/const row = await this\.noteInfraStreak\(failure\.step\)/);
    expect(b).toMatch(/switch \(infraStreakRung\(row\.count\)\)/);
    const recreate = b.slice(b.indexOf('case "recreate"'), b.indexOf('case "down"'));
    expect(recreate).toMatch(/await this\.recreateContainer\(infraStreakReason\(row, "recreate"\)\)/);
    const down = b.slice(b.indexOf('case "down"'));
    expect(down).toMatch(/infraStreakReason\(row, "down"\)/);
    expect(down).toMatch(/await this\.forgetRuntimeIdentity\(\)/);
    expect(down).toMatch(/await this\.destroy\(\)/);
    expect(down).toMatch(/storage\.delete\(INFRA_STREAK_KEY\)/);
    expect(down).toMatch(/await this\.goDown\(reason\)/);
  });

  it("the disk-full recovery keeps its own path, before any counting", () => {
    const b = body();
    expect(b.indexOf("if (failure.diskFull)")).toBeLessThan(b.indexOf("isRepoCommandStep"));
  });
});

describe("the reasons are read as the resident's, never the repo's", () => {
  it("`infra-streak:` is a non-evidence reason (the gate always runs the next cycle) and the gate parks only what parksOnRepeat allows", () => {
    const m = /^const NON_EVIDENCE_REASON = \/(.*)\/;$/m.exec(source);
    expect(m).not.toBeNull();
    expect(new RegExp(m![1]).test("infra-streak: 3 consecutive cycles failed …")).toBe(true);
    expect(source).toMatch(
      /entry\.state === "degraded" && !isNonEvidenceReason\(entry\.reason\) && parksOnRepeat\(entry\.reason\)/,
    );
  });
});

describe("the fault injection and the read view", () => {
  it("`infra-streak` sets the row's count (0 deletes it) and `break-mirror` removes the mirror's config — a fault the wake check does not heal — under its own step name; both are admin-only by construction", () => {
    expect(method("debugSetInfraStreak")).toMatch(
      /if \(count === 0\) \{\s*await this\.ctx\.storage\.delete\(INFRA_STREAK_KEY\)/,
    );
    // The fault must survive the wake check (`readyStamp` tests `objects/`
    // and `.git`): removing the mirror's `config` leaves both and makes the
    // fetch fail — `'origin' does not appear to be a git repository`.
    expect(method("debugBreakMirror")).toMatch(/\["rm", "-f", `\$\{MIRROR_DIR\}\/config`\], "break-mirror"/);
    expect(method("debugBreakMirror")).not.toMatch(/objects/);
    const readOps = /^const READ_DEBUG_OPS = new Set\(\[([^\]]*)\]\);$/m.exec(source);
    expect(readOps).not.toBeNull();
    expect(readOps![1]).not.toMatch(/infra-streak|break-mirror/);
    expect(source).toMatch(/case "infra-streak":/);
    expect(source).toMatch(/case "break-mirror":/);
  });

  it("`/debug info` reads the row and carries it with its rung", () => {
    const body = method("getResidentInfo");
    const list = /const map = await this\.ctx\.storage\.get<unknown>\(\[([^\]]*)\]\)/.exec(body);
    expect(list![1]).toMatch(/\bINFRA_STREAK_KEY\b/);
    expect(body).toMatch(/infraStreak: /);
    expect(body).toMatch(/rung: infraStreakRung\(row\.count\)/);
  });
});
