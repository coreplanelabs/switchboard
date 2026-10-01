import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryRequirements, checkSpec, collectTestTitles } from "../scripts/specs-check.mjs";

const declaration = () => ({
  id: "plane.ack",
  criterion: "plane-effect-ack",
  kind: "effect-result",
  input: { file: "src/effect.ts", symbol: "Ack", kind: "trusted-adapter-result" },
  validator: { file: "src/effect.ts", symbol: "decode" },
  consumer: { file: "src/effect.ts", symbol: "Ledger.ack" },
  terminal: ["done", "skipped"],
  retry: {
    kind: "same-effect-until-ack",
    owner: { file: "src/effect.ts", symbol: "deliver" },
    identity: "effect-id",
    pending: ["deferred"],
    outstandingCap: { file: "src/effect.ts", symbol: "OPEN_CAP" },
  },
  failure: { invalid: "refuse", transport: "ack-unconfirmed" },
  proofs: ["src/effect.test.ts::acknowledgements::retains deferred offers"],
});

const source = `export type Ack = "done" | "skipped" | "deferred";
export function decode(value: unknown) { return value; }
export class Ledger { ack() {} }
export function deliver() {}
export const OPEN_CAP = 4;`;
const testSource = `describe("acknowledgements", () => {
  it("retains deferred offers", () => { expect(1).toBe(1); });
});`;

function markdown(value: unknown = declaration()) {
  return [
    "# Effect acknowledgements",
    "- **Code**: `src/effect.ts`",
    "- **Tests**: `src/effect.test.ts`",
    "| Criterion | Proof |",
    "|---|---|",
    '| <a id="plane-effect-ack"></a> <!-- decision-boundary: plane.ack --> Deferred offers remain open | `[unit]` `src/effect.test.ts::acknowledgements::retains deferred offers` |',
    "",
    "```json decision-boundary",
    JSON.stringify(value),
    "```",
  ].join("\n");
}

function check(options: { value?: unknown; markdown?: string; source?: string; tests?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "decision-boundary-"));
  try {
    const files = {
      "docs/reference/specs/effects.md": options.markdown ?? markdown(options.value ?? declaration()),
      "src/effect.ts": options.source ?? source,
      "src/effect.test.ts": options.tests ?? testSource,
    };
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), contents);
    }
    return checkSpec("docs/reference/specs/effects.md", {
      root,
      testFiles: ["src/effect.test.ts"],
      titlesFor: (file) =>
        file === "src/effect.test.ts" ? collectTestTitles(files["src/effect.test.ts"], file) : null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("decision-boundary declarations", () => {
  it("binds a typed result and its closed outcomes to the owning criterion and an active exact proof", () => {
    expect(check()).toEqual([]);
  });

  it.each(["input", "validator", "consumer", "retry", "terminal", "failure", "proofs"])(
    "rejects a declaration missing %s",
    (field) => {
      const value: Record<string, unknown> = declaration();
      delete value[field];
      expect(check({ value }).some((p) => p.kind === "boundary")).toBe(true);
    },
  );

  it("rejects unknown fields and renewable migration exemptions", () => {
    expect(check({ value: { ...declaration(), migration: { state: "exempt" } } })).not.toEqual([]);
    expect(check({ value: { ...declaration(), typoo: true } })).not.toEqual([]);
  });

  it("rejects unknown result or retry kinds instead of accepting prose as policy", () => {
    const value = declaration();
    expect(check({ value: { ...value, kind: "maybe-done" } })).not.toEqual([]);
    expect(check({ value: { ...value, retry: { ...value.retry, kind: "try-again" } } })).not.toEqual([]);
  });

  it("requires every declared source symbol to exist under the owning Code header", () => {
    const value = declaration();
    expect(check({ value: { ...value, validator: { ...value.validator, symbol: "missing" } } })).not.toEqual([]);
    expect(check({ markdown: markdown().replace("`src/effect.ts`", "`src/elsewhere.ts`") })).not.toEqual([]);
    expect(check({ value: { ...value, validator: { file: "../escape.ts", symbol: "decode" } } })).not.toEqual([]);
  });

  it("requires the result to be a closed string union exactly partitioned into pending and terminal cases", () => {
    expect(check({ source: source.replace('"done" | "skipped" | "deferred"', "string") })).not.toEqual([]);
    expect(check({ source: source.replace('"deferred";', '"deferred" | "lost";') })).not.toEqual([]);
    expect(check({ value: { ...declaration(), terminal: ["done", "deferred"] } })).not.toEqual([]);
  });

  it("rejects non-callable validators and non-positive outstanding-effect caps", () => {
    const value = declaration();
    expect(check({ value: { ...value, validator: value.input } })).not.toEqual([]);
    expect(check({ value: { ...value, validator: value.retry.outstandingCap } })).not.toEqual([]);
    expect(check({ source: source.replace("OPEN_CAP = 4", "OPEN_CAP = 0") })).not.toEqual([]);
  });

  it("requires one existing criterion with the declared proof in that row", () => {
    expect(check({ value: { ...declaration(), criterion: "missing" } })).not.toEqual([]);
    expect(check({ markdown: markdown().replace('id="plane-effect-ack"', 'id="different"') })).not.toEqual([]);
    expect(
      check({
        markdown: markdown().replace(
          "`[unit]` `src/effect.test.ts::acknowledgements::retains deferred offers`",
          "`[gap]` no proof",
        ),
      }),
    ).not.toEqual([]);
  });

  it("requires a declared boundary to remain recognized when its fence is removed or malformed", () => {
    for (const body of [
      markdown().split("```json decision-boundary")[0],
      markdown().replace("```json decision-boundary", "```json decision-boundary extra"),
      markdown().replace("```json decision-boundary", "```json"),
      markdown()
        .replace("```json decision-boundary\n", "")
        .replace(/\n```$/, ""),
    ]) {
      expect(
        check({ markdown: body }).some((p) => p.kind === "boundary"),
        body,
      ).toBe(true);
    }
  });

  it("binds each required declaration to exactly one well-formed criterion marker", () => {
    for (const marker of [
      "",
      "<!-- decision-boundary: -->",
      "<!-- decision-boundary: plane.ack --> <!-- decision-boundary: plane.ack -->",
      "<!-- decision-boundary: plane.ack --> <!-- decision-boundary: -->",
    ]) {
      expect(
        check({ markdown: markdown().replace("<!-- decision-boundary: plane.ack -->", marker) }).some(
          (p) => p.kind === "boundary",
        ),
      ).toBe(true);
    }
  });

  it("requires the criterion row itself to name the exact declared proof", () => {
    for (const proof of ["src/effect.test.ts::*", "src/effect.test.ts", "src/effect.test.ts::acknowledgements"]) {
      const body = markdown().replace(
        "`src/effect.test.ts::acknowledgements::retains deferred offers`",
        `\`${proof}\``,
      );
      expect(
        check({ markdown: body }).some((p) => p.kind === "boundary"),
        proof,
      ).toBe(true);
    }
  });

  it("rejects type-only signatures for every callable role", () => {
    for (const role of ["validator", "consumer", "retry"] as const) {
      for (const [symbol, extra] of [
        ["Adapter.decode", "export interface Adapter { decode(): void }"],
        ["ambient", "export declare function ambient(): void;"],
        ["Abstract.decode", "export abstract class Abstract { abstract decode(): void; }"],
      ]) {
        const value = declaration();
        const reference = { file: "src/effect.ts", symbol };
        if (role === "retry") value.retry.owner = reference;
        else value[role] = reference;
        expect(
          check({ value, source: source + "\n" + extra }).some((p) => p.kind === "boundary"),
          role + symbol,
        ).toBe(true);
      }
    }
  });

  it("rejects missing, broad, dynamic or skipped proof tests including disabled ancestor suites", () => {
    for (const proof of [
      "src/effect.test.ts::",
      "src/effect.test.ts::acknowledgements::*",
      "src/effect.test.ts::acknowledgements::missing",
    ]) {
      expect(check({ value: { ...declaration(), proofs: [proof] } })).not.toEqual([]);
    }
    for (const tests of [
      testSource.replace("it(", "it.skip("),
      testSource.replace("describe(", "describe.skip("),
      testSource.replace("describe(", "describe.only("),
    ]) {
      expect(check({ tests })).not.toEqual([]);
    }
    expect(check({ tests: testSource.replace('"retains deferred offers"', "dynamicTitle") })).not.toEqual([]);
  });

  it("rejects malformed JSON and duplicate declarations without the stale-proof baseline", () => {
    expect(check({ markdown: markdown().replace(JSON.stringify(declaration()), '{"id":') })).not.toEqual([]);
    expect(check({ markdown: markdown() + "\n" + markdown() })).not.toEqual([]);
    expect(
      check({ value: { ...declaration(), extra: true } })
        .filter((p) => p.kind === "boundary")
        .every((p) => p.key === undefined),
    ).toBe(true);
  });

  it("does not claim conditional or parameterized proofs are exact active tests", () => {
    for (const call of ["it.skipIf(true)(", "it.runIf(false)(", "it.each([1])("]) {
      expect(check({ tests: testSource.replace("it(", call) })).not.toEqual([]);
    }
  });

  it("keeps ordinary grammar and rendering specs outside the prototype", () => {
    expect(
      check({
        markdown: markdown().split("```json decision-boundary")[0].replace("<!-- decision-boundary: plane.ack -->", ""),
      }),
    ).toEqual([]);
  });

  it.each([
    { name: "unknown fields", body: markdown({ ...declaration(), waiver: true }) },
    { name: "missing fence", body: markdown().split("```json decision-boundary")[0] },
    {
      name: "malformed metadata",
      body: markdown().replace("```json decision-boundary", "```json decision-boundary extra"),
    },
    { name: "ordinary fence", body: markdown().replace("```json decision-boundary", "```json") },
    {
      name: "prose instead of fence",
      body: markdown()
        .replace("```json decision-boundary\n", "")
        .replace(/\n```$/, ""),
    },
  ])("the command rejects $name even when asked to refresh the stale-proof baseline", ({ body }) => {
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "boundary-command-")));
    try {
      const files = {
        "package.json": '{"type":"module"}',
        "docs/reference/specs/effects.md": body,
        "src/effect.ts": source,
        "src/effect.test.ts": testSource,
        "scripts/specs-check.mjs": readFileSync(join(repository, "scripts/specs-check.mjs"), "utf8"),
        "scripts/spec-boundaries.mjs": readFileSync(join(repository, "scripts/spec-boundaries.mjs"), "utf8"),
      };
      for (const [file, contents] of Object.entries(files)) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), contents);
      }
      symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
      const result = spawnSync(process.execPath, [join(root, "scripts/specs-check.mjs"), "--update-baseline"], {
        encoding: "utf8",
        cwd: root,
      });
      expect(result.status, body).toBe(1);
      expect(result.stderr).toContain("invalid decision-boundary");
      expect(existsSync(join(root, "docs/reference/specs/specs-check.baseline.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the repository's plane acknowledgement declared beside its existing proof", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const spec = "docs/reference/specs/orchestration-plane.md";
    const body = readFileSync(join(root, spec), "utf8");
    const titles = new Map<string, ReturnType<typeof collectTestTitles> | null>();
    expect(boundaryRequirements(body).map((r) => r.id)).toEqual(["plane.ack"]);
    expect(
      checkSpec(spec, {
        root,
        testFiles: [],
        titlesFor: (file) => {
          if (titles.has(file)) return titles.get(file)!;
          try {
            const nodes = collectTestTitles(readFileSync(join(root, file), "utf8"), file);
            titles.set(file, nodes);
            return nodes;
          } catch {
            titles.set(file, null);
            return null;
          }
        },
      }).filter((p) => p.kind === "boundary"),
    ).toEqual([]);
  });
});
