// Write the generated regions of docs/reference/* from the command registry
// (features/docs-site.md items 6–8).
//
//   npm run docs:gen     rewrite every region; prints one line per file changed
//   npm run docs:check   verify the committed regions match the code — what CI
//                        runs, exit 1 with the files that drifted
//
// The mechanism is the same one `skills:sync` uses for vendored skills: the
// generator is the only writer, and the check makes a stale table a red build
// instead of a docs bug someone finds months later. Needs no network, no
// config, no deps — just the registry, so it runs from a bare worktree.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRegistry, type CommandDef } from "../src/core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../src/core/commands/all.js";
import { docCommands, GENERATED_REGIONS, type DocCommand } from "../src/docs/reference.js";
import { declaredRegions, replaceRegion } from "../src/docs/regions.js";

const DOCS_DIR = process.env.SWITCHBOARD_DOCS_DIR ?? fileURLToPath(new URL("../docs", import.meta.url));

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

function render(cmds: readonly DocCommand[]): FileOutcome[] {
  return Object.entries(GENERATED_REGIONS).map(([file, regions]) => {
    const path = join(DOCS_DIR, file);
    const current = readFileSync(path, "utf8");
    const problems: string[] = [];
    let next = current;
    for (const [name, renderer] of Object.entries(regions)) {
      const outcome = replaceRegion(next, name, renderer(cmds));
      if (!outcome.ok) problems.push(`${file}: ${outcome.problem}`);
      else next = outcome.text;
    }
    // A marker in the file that no renderer owns: a typo, or a renderer that was
    // deleted and left its block frozen in the page.
    for (const name of declaredRegions(current)) {
      if (!(name in regions)) problems.push(`${file}: region '${name}' has a marker but no renderer in GENERATED_REGIONS`);
    }
    return { file, next, current, problems };
  });
}

function main(): number {
  const check = process.argv.includes("--check");
  const outcomes = render(catalogue());
  const problems = outcomes.flatMap((o) => o.problems);
  const drifted = outcomes.filter((o) => o.problems.length === 0 && o.next !== o.current);

  for (const p of problems) console.error(`docs:${check ? "check" : "gen"} ${p}`);
  if (check) {
    for (const o of drifted) console.error(`docs:check ${o.file} is out of date — run \`npm run docs:gen\``);
    if (problems.length + drifted.length === 0) {
      console.log(`docs:check ok — ${outcomes.length} file(s) match the command registry`);
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
