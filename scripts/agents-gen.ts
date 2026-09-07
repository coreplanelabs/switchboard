// Write the Commands table into AGENTS.md from package.json (which scripts
// exist) and project.json (what each does, when to run it), or check that the
// committed table is current.
//
//   npm run agents:gen      rewrite the table
//   npm run agents:check    what CI runs — exit 1 with the reason: a drifted
//                           table, a script with no description, a description
//                           for a script that no longer exists, or AGENTS.md
//                           past the budget that keeps it an index
//
// The decisions live in src/docs/agentsTable.ts and are unit-tested there;
// this file only reads and writes the tree.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_BUDGET_BYTES,
  budgetProblem,
  commandDocProblems,
  NOTE,
  REGION,
  renderCommandsTable,
  type CommandDoc,
} from "../src/docs/agentsTable.js";
import { replaceRegion } from "../src/docs/regions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function main(): number {
  const check = process.argv.includes("--check");
  const tag = check ? "agents:check" : "agents:gen";
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const facts = JSON.parse(readFileSync(join(ROOT, "project.json"), "utf8")) as { commands: Record<string, unknown> };
  const docs = Object.fromEntries(Object.entries(facts.commands).filter(([k]) => !k.startsWith("$")));

  const problems = commandDocProblems(pkg.scripts, docs);
  if (problems.length > 0) {
    for (const p of problems) console.error(`${tag} ${p}`);
    return 1;
  }

  const current = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const outcome = replaceRegion(
    current,
    REGION,
    renderCommandsTable(pkg.scripts, docs as Record<string, CommandDoc>),
    NOTE,
  );
  if (!outcome.ok) {
    console.error(`${tag} AGENTS.md: ${outcome.problem}`);
    return 1;
  }

  const budget = budgetProblem(outcome.text);
  if (check) {
    if (outcome.changed) console.error(`${tag} AGENTS.md's Commands table is out of date — run \`npm run agents:gen\``);
    if (budget) console.error(`${tag} ${budget}`);
    if (outcome.changed || budget) return 1;
    console.log(
      `${tag} ok — ${Object.keys(pkg.scripts).length} scripts described, AGENTS.md ${Buffer.byteLength(outcome.text, "utf8")} bytes of ${AGENTS_BUDGET_BYTES}`,
    );
    return 0;
  }
  if (outcome.changed) {
    writeFileSync(join(ROOT, "AGENTS.md"), outcome.text);
    console.log(`${tag} wrote the Commands table into AGENTS.md`);
  } else {
    console.log(`${tag} ok — AGENTS.md already current`);
  }
  if (budget) {
    console.error(`${tag} ${budget}`);
    return 1;
  }
  return 0;
}

process.exit(main());
