// The standing fold's shadow diff (record 0065; the orchestrator-surfaces
// plan, unit two): fold each finished hosted record's events and compare every
// unit's FINAL stage with the card's ending or idle word for it — the one
// state the instance store holds independently of the events — under the
// record's mapping. Run by hand over records read through the MCP or the CLI;
// its count is posted on the receipts issue before unit three is seeded.
//
//   npx tsx scripts/pipeline-standing-diff.ts <input.json>
//   ... | npx tsx scripts/pipeline-standing-diff.ts -
//
// Input: JSON of the shape
//   { records: RunRecord[],                    // each with its events
//     units?: { [instanceId]: CoordinatorUnit[] } }  // the card's rows per instance
// (`runs get <id> --include messages` supplies a record; `runs unit` and the
// coordinator store supply the unit rows). A record without ship events, or an
// instance with no unit rows given, is skipped and counted as such.
//
// Exit 0 always: the output is the count, a person judges it — one
// disagreement is a fold bug, a class is a vocabulary the record must gain
// (its mapping amended) before unit three ships the words to a reader.
import { readFileSync } from "node:fs";
import { pipelineStandingOf, type Stage } from "../src/core/pipelineStanding.js";
import type { RunEvent } from "../src/core/runEvents.js";

interface UnitRowLike {
  unit: string;
  ending?: { kind?: string };
  idle?: unknown;
}
interface RecordLike {
  id: string;
  instanceId?: string;
  events?: RunEvent[];
  finishedAt?: number;
}
interface Input {
  records?: RecordLike[];
  units?: Record<string, UnitRowLike[]>;
}

/** The card's word folded onto the stage vocabulary — the record's mapping. */
function cardStageOf(row: UnitRowLike): Stage | undefined {
  if (row.ending === undefined || typeof row.ending.kind !== "string") return row.idle ? "idle" : undefined;
  const kind = row.ending.kind;
  if (kind === "merged" || kind === "already_landed") return "merged";
  if (kind === "merge_ready") return "merge-ready";
  if (kind === "idle") return "idle";
  if (kind === "continued") return "coding";
  return "ended";
}

function main(): void {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("usage: npx tsx scripts/pipeline-standing-diff.ts <input.json | ->");
    process.exitCode = 2;
    return;
  }
  const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  const input = JSON.parse(raw) as Input;
  const records = input.records ?? [];
  const unitRows = input.units ?? {};

  let compared = 0;
  let agreed = 0;
  const disagreements: string[] = [];
  const skipped: string[] = [];

  for (const record of records) {
    const events = record.events ?? [];
    const standing = pipelineStandingOf(events);
    if (standing.units.length === 0) {
      skipped.push(`${record.id}: no ship_unit events (${standing.unnamedRounds.length} unnamed rounds)`);
      continue;
    }
    const rows = record.instanceId !== undefined ? unitRows[record.instanceId] : undefined;
    if (rows === undefined) {
      skipped.push(`${record.id}: no unit rows given for instance ${record.instanceId ?? "(none)"}`);
      continue;
    }
    for (const unit of standing.units) {
      const row = rows.find((r) => r.unit === unit.unit);
      const expected = row === undefined ? undefined : cardStageOf(row);
      if (expected === undefined) {
        skipped.push(`${record.id} ${unit.unit}: the card has no ending or idle word`);
        continue;
      }
      compared++;
      if (unit.stage === expected) agreed++;
      else
        disagreements.push(
          `${record.id} ${unit.unit}: fold says ${unit.stage}${unit.detail !== undefined ? ` (${unit.detail})` : ""}, card says ${expected} (${row?.ending?.kind ?? "idle"})`,
        );
    }
  }

  console.log(`records: ${records.length}`);
  console.log(`units compared: ${compared} · agreed: ${agreed} · disagreed: ${disagreements.length}`);
  for (const line of disagreements) console.log(`  ✗ ${line}`);
  if (skipped.length > 0) {
    console.log(`skipped: ${skipped.length}`);
    for (const line of skipped) console.log(`  – ${line}`);
  }
}

main();
