// A declaration belongs to its spec criterion. This checker validates explicit
// references and proof bindings; it does not infer data flow or grant authority.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import ts from "typescript";
import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const file = z.string().regex(/^(?:src|deploy|web\/src)\/(?:[\w-]+\/)*[\w.-]+\.[cm]?[jt]s$/);
const ref = z.strictObject({ file, symbol: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/) });
const words = z.array(z.string().min(1)).min(1);
export const decisionBoundarySchema = z.strictObject({
  id: name,
  criterion: name,
  kind: z.literal("effect-result"),
  input: ref.extend({ kind: z.literal("trusted-adapter-result") }),
  validator: ref,
  consumer: ref,
  terminal: words,
  retry: z.strictObject({
    kind: z.literal("same-effect-until-ack"),
    owner: ref,
    identity: z.literal("effect-id"),
    pending: words,
    outstandingCap: ref,
  }),
  failure: z.strictObject({ invalid: z.literal("refuse"), transport: z.literal("ack-unconfirmed") }),
  proofs: z.array(z.string().min(1)).min(1),
});

export function boundaryBlocks(markdown) {
  const blocks = [];
  const visit = (node) => {
    if (node.type === "code" && /\bdecision-boundary\b/i.test(`${node.lang ?? ""} ${node.meta ?? ""}`))
      blocks.push({
        raw: node.value,
        line: node.position.start.line,
        malformed: node.lang !== "json" || node.meta !== "decision-boundary",
      });
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(markdown));
  return blocks;
}

/** The owning criterion requires its declaration even if its fence disappears. */
export function boundaryRequirements(markdown) {
  return markdown.split("\n").flatMap((line, index) => {
    if (!line.startsWith("|") || !/<!--\s*decision-boundary\b/i.test(line)) return [];
    const introductions = [...line.matchAll(/<!--\s*decision-boundary\b/gi)];
    const markers = [...line.matchAll(/<!--\s*decision-boundary:\s*([a-z][a-z0-9.-]*)\s*-->/g)];
    return [
      {
        id: introductions.length === 1 && markers.length === 1 ? markers[0][1] : undefined,
        line: index + 1,
        raw: line,
      },
    ];
  });
}

function symbols(source, fileName) {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = new Map();
  const visit = (node, parent = "") => {
    const declared =
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node);
    const own = declared && node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const key = own ? (parent ? `${parent}.${own}` : own) : parent;
    if (own) {
      const values = found.get(key) ?? [];
      values.push(node);
      found.set(key, values);
    }
    ts.forEachChild(node, (child) => visit(child, own ? key : parent));
  };
  visit(tree);
  return found;
}

const beneath = (header, path) => path === header || path.startsWith(header.replace(/\/$/, "") + "/");
const equalParts = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
const isTestOrDeclaration = (path) => /\.(?:test|spec)\./.test(path) || /\.d\.[cm]?ts$/.test(path);

export function checkBoundaries(markdown, { root, headers, proofRefs, titlesFor }) {
  const problems = [];
  const seen = new Set();
  const requirements = boundaryRequirements(markdown);
  const sourceCache = new Map();
  const codeHeaders = headers.filter((h) => markdown.split("\n")[h.line - 1].startsWith("- **Code**:"));
  const testHeaders = headers.filter((h) => markdown.split("\n")[h.line - 1].startsWith("- **Tests**:"));
  for (const block of boundaryBlocks(markdown)) {
    const fail = (reason) => problems.push({ kind: "boundary", line: block.line, raw: block.raw, reason });
    if (block.malformed) {
      fail("decision-boundary fence must be exactly json decision-boundary");
      continue;
    }
    let value;
    try {
      value = JSON.parse(block.raw);
    } catch {
      fail("decision-boundary must contain valid JSON");
      continue;
    }
    const decoded = decisionBoundarySchema.safeParse(value);
    if (!decoded.success) {
      fail(
        "invalid decision-boundary: " +
          decoded.error.issues.map((i) => `${i.path.join(".") || "declaration"}: ${i.message}`).join("; "),
      );
      continue;
    }
    const d = decoded.data;
    if (seen.has(d.id)) fail(`duplicate decision-boundary id: ${d.id}`);
    seen.add(d.id);
    const resolve = (reference) => {
      if (isTestOrDeclaration(reference.file) || !codeHeaders.some((h) => beneath(h.path, reference.file))) {
        fail(`${d.id}: source ${reference.file} must be production code covered by the owning Code header`);
        return undefined;
      }
      if (!sourceCache.has(reference.file)) {
        try {
          sourceCache.set(reference.file, symbols(readFileSync(join(root, reference.file), "utf8"), reference.file));
        } catch {
          sourceCache.set(reference.file, new Map());
        }
      }
      const matches = sourceCache.get(reference.file).get(reference.symbol) ?? [];
      if (matches.length !== 1) {
        fail(`${d.id}: source symbol must resolve exactly once: ${reference.file}::${reference.symbol}`);
        return undefined;
      }
      return matches[0];
    };
    const input = resolve(d.input);
    for (const reference of [d.validator, d.consumer, d.retry.owner]) {
      const node = resolve(reference);
      if (
        node &&
        !(
          ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body) ||
          (ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
        )
      )
        fail(`${d.id}: validator, consumer and retry owner must be callable source symbols: ${reference.symbol}`);
    }
    const cap = resolve(d.retry.outstandingCap);
    if (
      cap &&
      !(
        ts.isVariableDeclaration(cap) &&
        (cap.parent.flags & ts.NodeFlags.Const) !== 0 &&
        cap.initializer &&
        ts.isNumericLiteral(cap.initializer) &&
        Number.isInteger(Number(cap.initializer.text)) &&
        Number(cap.initializer.text) > 0
      )
    )
      fail(`${d.id}: outstanding-effect cap must name a positive integer source constant`);
    if (input) {
      const type = ts.isTypeAliasDeclaration(input) && input.type;
      const cases =
        type &&
        ts.isUnionTypeNode(type) &&
        type.types.every((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
          ? type.types.map((t) => t.literal.text)
          : undefined;
      const declared = [...d.terminal, ...d.retry.pending];
      if (
        !cases ||
        new Set(declared).size !== declared.length ||
        new Set(cases).size !== cases.length ||
        declared.length !== cases.length ||
        !declared.every((c) => cases.includes(c))
      )
        fail(`${d.id}: terminal and pending outcomes must exactly partition a closed string-literal input union`);
    }
    const lines = markdown.split("\n");
    const criterion = lines
      .map((line, i) => ({ line, number: i + 1 }))
      .filter((r) => r.line.startsWith("|") && r.line.includes(`<a id="${d.criterion}"></a>`));
    if (criterion.length !== 1) {
      fail(`${d.id}: criterion anchor must identify exactly one validation row`);
      continue;
    }
    if (requirements.filter((r) => r.id === d.id && r.line === criterion[0].number).length !== 1)
      fail(`${d.id}: its owning criterion must require this decision-boundary id`);
    if (!criterion[0].line.includes("`[unit]`")) fail(`${d.id}: criterion must declare a unit proof`);
    for (const proof of d.proofs) {
      const [path, ...parts] = proof.split("::");
      if (
        !/\.(?:test|spec)\.[cm]?[jt]s$/.test(path) ||
        !testHeaders.some((h) => beneath(h.path, path)) ||
        parts.length < 1 ||
        parts.some((p) => p.length === 0 || /[*…]/.test(p))
      ) {
        fail(`${d.id}: proof must name an exact leaf test under the owning Tests header: ${proof}`);
        continue;
      }
      const nodes = titlesFor(path) ?? [];
      const leaves = nodes.filter((n) => n.leaf && equalParts(n.parts, parts));
      const disabled = nodes.some(
        (n) =>
          (n.mode || n.conditional || n.parameterized) &&
          (n.mode === "only" || n.parts.every((part, i) => parts[i] === part)),
      );
      if (leaves.length !== 1 || disabled) {
        fail(
          `${d.id}: proof must resolve to one active leaf test, without disabled ancestors or focused suites: ${proof}`,
        );
        continue;
      }
      if (!proofRefs.some((r) => r.line === criterion[0].number && r.file === path && equalParts(r.titles, parts)))
        fail(`${d.id}: exact proof must also be bound by its criterion row: ${proof}`);
    }
  }
  const requiredIds = new Set();
  for (const requirement of requirements) {
    let reason;
    if (!requirement.id) reason = "criterion must contain exactly one valid decision-boundary requirement";
    else if (requiredIds.has(requirement.id)) reason = `duplicate decision-boundary requirement: ${requirement.id}`;
    else if (!seen.has(requirement.id)) reason = `required decision-boundary declaration is absent: ${requirement.id}`;
    if (reason) problems.push({ kind: "boundary", line: requirement.line, raw: requirement.raw, reason });
    if (requirement.id) requiredIds.add(requirement.id);
  }
  return problems;
}

/** A deliberately broad, separate census. Counts are candidates, not findings. */
export function candidateCensus(root) {
  let files = 0;
  let candidates = 0;
  const byKind = { regex: 0, textComparison: 0, parserCall: 0 };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "testing", "fixtures"].includes(entry.name)) continue;
      const fileName = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fileName);
        continue;
      }
      if (!/\.[cm]?[jt]s$/.test(fileName) || isTestOrDeclaration(fileName)) continue;
      files++;
      const tree = ts.createSourceFile(
        fileName,
        readFileSync(join(root, fileName), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        let kind;
        if (ts.isRegularExpressionLiteral(node)) kind = "regex";
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          if (["includes", "startsWith", "endsWith", "match", "matchAll", "test"].includes(method))
            kind = "textComparison";
          else if (/^(parse|decode|validate)/.test(method)) kind = "parserCall";
        }
        if (kind) {
          byKind[kind]++;
          candidates++;
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  };
  for (const dir of ["src", "deploy", "web/src", "scripts"]) walk(dir);
  return {
    scope:
      "Non-test JS/TS in src, deploy, web/src and scripts; excludes dependencies, generated output, fixtures, Vue/templates and shell/workflows",
    files,
    candidates,
    byKind,
    meaning: "Unreviewed syntax candidates, including safe uses. Not a semantic coverage or safety gate.",
  };
}
