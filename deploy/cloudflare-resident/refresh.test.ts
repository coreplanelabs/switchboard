import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The refresh cycle as a Workflow instance lives in refresh.ts, not in the
// Worker's entry — and the Workflows binding resolves its class by name on the
// entry module (`class_name` in wrangler.template.jsonc), so the entry must
// re-export it. This scan over the sources holds that boundary: the class is
// declared in refresh.ts and nowhere in worker.ts, worker.ts re-exports it
// under the bound name, and neither refresh.ts nor shared.ts imports the entry
// at runtime (a type-only import is erased before the modules evaluate), so the
// split is not a cycle. Plain Node, like this project's other tests: worker.ts
// itself is read as text, never loaded.

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/** The class the binding names, read from the template so the test follows a
 *  rename. The span runs to the array's close, not the object's: the template's
 *  `{{script}}` placeholder has braces of its own. */
function boundClassName(): string {
  const m = /"workflows":\s*\[[^\]]*"class_name":\s*"([A-Za-z_$][\w$]*)"/.exec(read("wrangler.template.jsonc"));
  if (!m) throw new Error("wrangler.template.jsonc declares no workflows binding");
  return m[1];
}

describe("the refresh module — the Workflow entrypoint leaves worker.ts, which re-exports it for the binding", () => {
  const name = boundClassName();
  it("worker.ts declares no class by the binding's name", () => {
    expect(read("worker.ts")).not.toMatch(new RegExp(`\\bclass ${name}\\b`));
  });
  it("refresh.ts declares it as the exported WorkflowEntrypoint", () => {
    expect(read("refresh.ts")).toMatch(new RegExp(`^export class ${name} extends WorkflowEntrypoint<`, "m"));
  });
  it("worker.ts re-exports it under the binding's class_name", () => {
    expect(read("worker.ts")).toMatch(new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./refresh";`, "m"));
  });
  it("neither refresh.ts nor shared.ts imports worker.ts at runtime — every import of it is type-only", () => {
    for (const file of ["refresh.ts", "shared.ts"]) {
      for (const statement of read(file).match(/^import[^;]*from "\.\/worker";/gm) ?? []) {
        expect(statement, `${file}: ${statement}`).toMatch(/^import type\b/);
      }
    }
  });
});
