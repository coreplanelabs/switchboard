import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const workerFiles = readdirSync(join(root, "deploy"))
  .filter((name) => name.startsWith("cloudflare") && existsSync(join(root, "deploy", name, "worker.ts")))
  .map((name) => `deploy/${name}/worker.ts`);
const sourceFiles = (directory: string): string[] =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
  });

describe("live HTTP transport coverage", () => {
  it("installs the shared observer in the bot and every Worker entry", () => {
    expect(read("src/index.ts")).toContain("installHttpTransport();");
    expect(workerFiles).not.toHaveLength(0);
    for (const file of workerFiles) expect(read(file), file).toContain("installHttpTransport();");
  });

  it("routes direct binding fetches and alternate HTTP clients through the observer", () => {
    const violations: string[] = [];
    const files = [...workerFiles, "deploy/cloudflare/coordinator.ts"];
    for (const file of files) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "fetch" &&
          node.expression.expression.kind !== ts.SyntaxKind.SuperKeyword
        )
          violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
    expect(read("deploy/cloudflare/worker.ts")).toContain(
      "observeHttpRequest(request, undefined, () => super.fetch(request))",
    );
    expect(read("src/tools/web.ts")).toContain("observeHttpRequest(url, init, () => rawFetch(url, init))");
  });

  it("does not add another unmeasured Node HTTP client", () => {
    const violations: string[] = [];
    for (const file of sourceFiles("src")) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const module = statement.moduleSpecifier.text;
        if (!["undici", "node:http", "node:https"].includes(module)) continue;
        const names = statement.importClause?.namedBindings;
        if (!names || !ts.isNamedImports(names)) continue;
        for (const specifier of names.elements) {
          const name = specifier.propertyName?.text ?? specifier.name.text;
          if (
            (module === "undici" && name === "fetch" && file !== "src/tools/web.ts") ||
            (module !== "undici" && ["request", "get"].includes(name))
          )
            violations.push(`${file}:${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
