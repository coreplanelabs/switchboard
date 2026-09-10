// Write the generated regions of the docs: the reference tables from the
// command registry (docs/reference/specs/docs-site.md items 6–8), the decisions
// index from the records (item 17), and the two diagrams drawn in more than one
// place from their one source each (item 21).
//
//   npm run docs:gen     rewrite every region; prints one line per file changed
//   npm run docs:check   verify the committed regions match the code — what CI
//                        runs, exit 1 with the files that drifted
//
// The mechanism is the same one `skills:sync` uses for vendored skills: the
// generator is the only writer, and the check makes a stale table a red build
// instead of a docs bug someone finds months later. Needs no network, no
// config, no deps — just the registry, so it runs from a bare worktree.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRegistry, type CommandDef } from "../src/core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../src/core/commands/all.js";
import { DISPATCHER, SEAMS } from "../docs/.vitepress/theme/seams.mjs";
import { DEPLOY_ORDER } from "../src/deploy/plan.js";
import { renderDecisionIndex, type DecisionRecord } from "../src/docs/decisions.js";
import { DIAGRAM_REGION_NOTE, DIAGRAM_REGIONS, type DiagramSources } from "../src/docs/diagrams.js";
import { docCommands, GENERATED_REGIONS, type DocCommand } from "../src/docs/reference.js";
import { declaredRegions, REGION_NOTE, replaceRegion } from "../src/docs/regions.js";

const DOCS_DIR = process.env.SWITCHBOARD_DOCS_DIR ?? fileURLToPath(new URL("../docs", import.meta.url));

/** The third source of generated regions: what the shared diagrams are drawn from. */
const DIAGRAM_SOURCES: DiagramSources = { seams: SEAMS, dispatcher: DISPATCHER, deployOrder: DEPLOY_ORDER };

/** The decision records — the second source of generated regions: their frontmatter is the index. */
function decisionRecords(): DecisionRecord[] {
  const dir = join(DOCS_DIR, "decisions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md") && n !== "README.md")
    .sort()
    .map((n) => ({ path: `docs/decisions/${n}`, text: readFileSync(join(dir, n), "utf8") }));
}

/** Regions rendered from the records rather than the command registry. */
const RECORD_REGIONS: Readonly<
  Record<string, Readonly<Record<string, (records: readonly DecisionRecord[]) => string>>>
> = {
  "explanation/design-decisions.md": { "decision-records": renderDecisionIndex },
};

/** The catalogue, listed for its metadata only — no deps are wired, nothing is
 *  invoked. `registerCoreCommands` is pure registration. */
function catalogue(): DocCommand[] {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  return docCommands(registry.list() as CommandDef<unknown>[]);
}

interface FileOutcome {
  file: string;
  next: string;
  current: string;
  problems: string[];
}

/** `note` is what each region's opening marker says wrote it — the tables and the diagrams name different sources. */
function renderFile(file: string, regions: Readonly<Record<string, () => string>>, note = REGION_NOTE): FileOutcome {
  const path = join(DOCS_DIR, file);
  const current = readFileSync(path, "utf8");
  const problems: string[] = [];
  let next = current;
  for (const [name, renderer] of Object.entries(regions)) {
    const outcome = replaceRegion(next, name, renderer(), note);
    if (!outcome.ok) problems.push(`${file}: ${outcome.problem}`);
    else next = outcome.text;
  }
  // A marker in the file that no renderer owns: a typo, or a renderer that was
  // deleted and left its block frozen in the page.
  for (const name of declaredRegions(current)) {
    if (!(name in regions)) problems.push(`${file}: region '${name}' has a marker but no renderer`);
  }
  return { file, next, current, problems };
}

function render(cmds: readonly DocCommand[], records: readonly DecisionRecord[]): FileOutcome[] {
  const bind = <T>(regions: Readonly<Record<string, (input: T) => string>>, input: T) =>
    Object.fromEntries(Object.entries(regions).map(([name, r]) => [name, () => r(input)]));
  return [
    ...Object.entries(GENERATED_REGIONS).map(([file, regions]) => renderFile(file, bind(regions, cmds))),
    ...Object.entries(RECORD_REGIONS).map(([file, regions]) => renderFile(file, bind(regions, records))),
    ...Object.entries(DIAGRAM_REGIONS).map(([file, regions]) =>
      renderFile(file, bind(regions, DIAGRAM_SOURCES), DIAGRAM_REGION_NOTE),
    ),
  ];
}

function main(): number {
  const check = process.argv.includes("--check");
  const outcomes = render(catalogue(), decisionRecords());
  const problems = outcomes.flatMap((o) => o.problems);
  const drifted = outcomes.filter((o) => o.problems.length === 0 && o.next !== o.current);

  for (const p of problems) console.error(`docs:${check ? "check" : "gen"} ${p}`);
  if (check) {
    for (const o of drifted) console.error(`docs:check ${o.file} is out of date — run \`npm run docs:gen\``);
    if (problems.length + drifted.length === 0) {
      console.log(
        `docs:check ok — ${outcomes.length} file(s) match the command registry, the decision records and the diagram sources`,
      );
      return 0;
    }
    return 1;
  }
  if (problems.length > 0) return 1;
  for (const o of drifted) {
    writeFileSync(join(DOCS_DIR, o.file), o.next);
    console.log(`docs:gen wrote ${o.file}`);
  }
  console.log(`docs:gen ok — ${drifted.length} of ${outcomes.length} file(s) changed`);
  return 0;
}

process.exit(main());
