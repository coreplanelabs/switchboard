import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CLI_CALLER, parseCliArgv, runCli } from "../cli.js";
import { callerFor } from "../channels/commandHttp.js";
import { handleMcpRequest, toCaller } from "../channels/mcp.js";
import { resolveChatActor } from "./authz/actor.js";
import { authorize } from "./authz/authorize.js";
import { NO_GRANTS } from "./authz/types.js";
import { ALL_GRANTS } from "./authz/grants.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { parseChatCommand } from "./commandChat.js";
import {
  CommandError,
  CommandRegistry,
  commandDefiner,
  renderText,
  resourceOf,
  type Caller,
  type CommandDef,
} from "./commandRegistry.js";
import { jsonSchemaFor, namedToInput, tokenize, toSurfaceNames } from "./commandSurface.js";
import { registerCoreCommands, type CoreCommandDeps } from "./commands/all.js";
import type { CoreDeps } from "./dispatcher.js";
import { RunStoreFrictionLedger } from "./frictionLedger.js";
import { RunRegistry } from "./runRegistry.js";
import { InMemoryRunStore } from "./runStore.js";
import {
  admits,
  AUTHZ_INGRESS_TOKENS,
  AUTHZ_ROLES,
  buildAuthorizationMatrix,
  buildConformanceMatrix,
  carriedBy,
  catalogueSnapshot,
  COMMAND_FIXTURES,
  CROSS_CUTTING_ASSERTIONS,
  expectedFlags,
  expectedRejection,
  fieldsOf,
  forCaller,
  parseCatalogueTable,
  policyGaps,
  QUOTED_SAMPLE,
  quoteChatToken,
  renderAuthorizationMatrix,
  renderConformanceMatrix,
  renderVariantCell,
  roleActor,
  schemaPropertyNames,
  SURFACE_METAS,
  toChatText,
  toKebabQuery,
  UNKNOWN_OPTION,
  variantsOf,
  withCallerToken,
  type Named,
} from "./testing/commandConformance.js";

// Feature: features/command-registry.md item 25 — the REGISTRY-DRIVEN
// CONFORMANCE SUITE. Nothing below names a command: the catalogue is enumerated
// (`registerCoreCommands`, asserted identical to `buildCoreCommands`), every
// case is generated from each command's declared zod schemas
// (`exhaustiveVariants`), and ONE pattern is asserted per command × variant ×
// surface (HTTP GET/POST, MCP tools/call, CLI argv, chat text):
//   1. name mapping + round-trip: the adapter's route/tool/argv/text binds to
//      the same parsed `{ args, options }` on every surface;
//   2. the MCP inputSchema lists exactly the fields (enums/defaults survive);
//   3. help names every argument and option; a refusal carries the ONE code
//      every surface uses for that fault (`invalid_input`, whether the grammar
//      or the registry saw it first), names the field and never echoes the
//      submitted value;
//   4. auth: admission on every surface is `authorize(actor, action, resource)`
//      over the policy table — a fixed actor set × every command is derived from
//      the table and checked against the real adapters (R13); a credential with
//      no grants is refused before parse; writes are POST-only; reads never
//      mutate the fixture; the Caller the registry saw is the adapter's;
//   5. output hygiene: no capability token or planted secret; stored free text
//      wrapped as untrusted on machine surfaces;
//   6. every surface yields the identical `invoke` JSON (chat: `renderText` of it)
//      — identical MODULO THE CALLER'S OWN ID: a caller-scoped command (memory,
//      invariant 4) answers with the caller's own scope key, and each surface
//      resolves a different caller id (`access:…`, `mcp:…`, `cli:local`,
//      `slack:U…`), so the reference is `invoke` with that surface's caller and
//      the cross-surface comparison folds the id back to `{caller.id}`;
//   7. a sorted catalogue snapshot + the docs table fence the catalogue; the
//      matrix `scripts/command-conformance-matrix.ts` prints is the suite's own.
// A new command is covered the moment it is registered — or fails loudly here
// (no sample for a field, a happy path that does not succeed against the
// generic fixture, a missing docs row, a stale snapshot) until its author adds
// a `FIELD_HINTS` entry / `COMMAND_FIXTURES` row / docs row / snapshot update.
//
// Nothing real runs: the world every case is driven against — the generic
// fixture, `fakeDeps` (a recording stub for every executing dependency) and the
// five surface drivers — is `src/core/testing/conformanceFixture.ts`, and
// `node:child_process` + `fetch` are disarmed for the whole file — a command
// that reached a real runner would fail here, not deploy something.

vi.mock("node:child_process", () => {
  const armed = (name: string) => () => {
    throw new Error(`conformance suite: node:child_process.${name} must never run — a command reached a real executor`);
  };
  return {
    spawn: armed("spawn"),
    spawnSync: armed("spawnSync"),
    exec: armed("exec"),
    execSync: armed("execSync"),
    execFile: armed("execFile"),
    execFileSync: armed("execFileSync"),
    fork: armed("fork"),
  };
});

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("conformance suite: fetch must never run — a command reached the network");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

import {
  assertChatShape,
  assertNoSecrets,
  assertUntrusted,
  CATALOGUE,
  chat,
  CHAT_CHANNEL,
  cli,
  CONFIG_DIR,
  fakeReqRes,
  fixture,
  freshConfig,
  httpGet,
  httpHandler,
  httpIdentityOf,
  httpOptions,
  httpPost,
  lastInvoke,
  namesField,
  NOBODY,
  NOW,
  PLANTED_ENV_SECRET,
  powerCaller,
  reference,
  registryRefused,
  runAsRole,
  runOn,
  SURFACES,
  surfacesFor,
  type Fixture,
} from "./testing/conformanceFixture.js";
// ---- 7. the regression fences -------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

describe("command conformance — catalogue fences", () => {
  it("the suite tests the catalogue the bot and the CLI bind (buildCoreCommands ≡ registerCoreCommands)", async () => {
    const f = await fixture();
    const real = buildCoreCommands(freshConfig().store, new InMemoryRunStore(), {
      registry: new RunRegistry(),
      env: { MEMORY_TOKEN: PLANTED_ENV_SECRET },
      dataDir: CONFIG_DIR,
      warn: () => {},
      frictionLedger: new RunStoreFrictionLedger(new InMemoryRunStore()),
      tracker: new InMemoryIssueTracker(),
      audit: () => {},
    });
    expect(
      real
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(
      f.commands
        .list()
        .map((c) => c.id)
        .sort(),
    );
    expect(CATALOGUE.length).toBeGreaterThan(0);
  });

  it("catalogue snapshot: id, arguments, options (names + kinds + enum values), surfaces, action, policy target, effect — update deliberately", () => {
    expect(catalogueSnapshot(CATALOGUE)).toMatchSnapshot();
  });

  it("features/command-registry.md `## Catalogue` table lists exactly the registered commands", () => {
    const md = readFileSync(join(here, "..", "..", "features", "command-registry.md"), "utf8");
    expect(parseCatalogueTable(md)).toEqual(CATALOGUE.map((c) => c.id).sort());
  });

  it("every command has a sample for every field and a happy path that succeeds against the generic fixture (or a COMMAND_FIXTURES entry)", async () => {
    expect(await conformanceFailures(fixture)).toEqual([]);
  });

  it("every COMMAND_FIXTURES entry names a registered command (no stale escape hatches)", () => {
    const ids = new Set(CATALOGUE.map((c) => c.id));
    for (const id of Object.keys(COMMAND_FIXTURES))
      expect(ids.has(id), `COMMAND_FIXTURES["${id}"] names no registered command`).toBe(true);
  });

  it("authorization: every command's action has a policy row on the resource it authorizes (features/authorization.md item 4)", () => {
    expect(policyGaps(CATALOGUE)).toEqual([]);
  });

  it("authorization: a command whose action has no policy row fails loudly, by name", () => {
    const define = commandDefiner<CoreCommandDeps>();
    const orphan = define({
      id: "demo.norow",
      action: "demo:read",
      effect: "read",
      describe: "no row names demo:read",
      handler: async () => ({}),
    });
    const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
    registerCoreCommands(registry);
    registry.register(orphan);
    expect(policyGaps(registry.list() as CommandDef<unknown>[])).toEqual([
      expect.stringMatching(/^demo\.norow: no policy row for demo:read on command/),
    ]);
    // …and the registry refuses it for everyone, the local CLI included: no row → deny (R7).
    expect(authorize(CLI_CALLER.actor, orphan.action, { type: "command", id: orphan.id })).toEqual({
      allow: false,
      reason: "no-rule",
    });
  });

  it("authorization: the fixed actor set resolves through the real adapters to the actors the matrix decides for (grants from config, never from the adapter)", async () => {
    const f = await fixture(() => {}, "authz");
    for (const role of AUTHZ_ROLES) {
      const expected = roleActor(role);
      const resolved = (() => {
        switch (carriedBy(role.id)) {
          case "chat":
            return resolveChatActor(
              { userId: role.id, channelId: CHAT_CHANNEL, threadKey: `${CHAT_CHANNEL}:t1` },
              (id) => f.config.grantsFor(id),
            );
          case "access":
            return callerFor(httpIdentityOf(role), httpOptions(f)).actor;
          case "mcp":
            return toCaller(AUTHZ_INGRESS_TOKENS[role.id.slice("mcp:".length)]!, (id) => f.config.grantsFor(id)).actor;
          case "cli":
            return CLI_CALLER.actor;
        }
      })();
      expect({ kind: resolved.kind, id: resolved.id, grants: resolved.grants }, role.column).toEqual({
        kind: expected.kind,
        id: expected.id,
        grants: expected.grants,
      });
    }
  });

  it("the fence is live: a command with an unfakeable dependency or an unsampleable field is listed by name", async () => {
    const define = commandDefiner<CoreCommandDeps>();
    // Real actions, so the real rows admit the power caller and the fence measures the FIXTURE, not the table.
    const needsDeps = define({
      id: "demo.needs",
      action: "runs:read",
      effect: "read",
      describe: "needs a dependency the fixture lacks",
      handler: async () => {
        throw new CommandError("unavailable", "demo store not configured");
      },
    });
    const unsampleable = define({
      id: "demo.strict",
      args: [{ name: "ticket", schema: z.string().regex(/^ZZ-\d{9}$/), describe: "ticket" }],
      action: "runs:read",
      effect: "read",
      describe: "an argument no generic sample satisfies",
      handler: async () => ({}),
    });
    const failures = await conformanceFailures(() =>
      fixture((registry) => {
        registry.register(needsDeps);
        registry.register(unsampleable);
      }),
    );
    expect(failures).toEqual([
      expect.stringMatching(/^demo\.needs: happy path .*unavailable/),
      expect.stringMatching(/^demo\.strict: no sample for ticket/),
    ]);
  });

  it("scripts/command-conformance-matrix.ts prints this suite's matrix: one row per variant the suite runs, one exercised cell per surface it drives, one authorization row per command", () => {
    const script = readFileSync(join(here, "..", "..", "scripts", "command-conformance-matrix.ts"), "utf8");
    expect(script).toContain("buildConformanceMatrix");
    expect(script).toContain("renderConformanceMatrix");
    expect(script).toContain("registerCoreCommands");
    const matrix = buildConformanceMatrix(CATALOGUE);
    let variants = 0;
    let cells = 0;
    for (const cmd of CATALOGUE) {
      const vs = variantsOf(cmd).variants;
      variants += vs.length;
      for (const v of vs) cells += surfacesFor(cmd, v).length;
      expect(
        matrix.commands.find((c) => c.id === cmd.id)?.rows.map((r) => r.variant),
        cmd.id,
      ).toEqual(vs.map((v) => v.name));
    }
    expect(matrix.summary).toEqual({ commands: CATALOGUE.length, surfaces: SURFACES.length, variants, cells });
    expect(matrix.authorization.rows.map((r) => r.id)).toEqual(CATALOGUE.map((c) => c.id).sort());
    const md = renderConformanceMatrix(matrix);
    expect(
      md
        .split("\n")
        .filter(
          (l) =>
            /^\| [^-|]/.test(l) &&
            !l.startsWith("| Variant") &&
            !l.startsWith("| Assertion") &&
            !l.startsWith("| Command"),
        ).length,
    ).toBe(variants + CATALOGUE.length + CROSS_CUTTING_ASSERTIONS.length);
    expect(md).toContain(renderAuthorizationMatrix(matrix.authorization).join("\n"));
  });

  it("one error vocabulary: no matrix row has two exposed cells that disagree — a rejected row names its one code and every exposed cell is ⛔, an accepted row is all ✅", () => {
    const matrix = buildConformanceMatrix(CATALOGUE);
    const rows = matrix.commands.flatMap((c) => c.rows.map((r) => ({ id: c.id, ...r })));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const exposed = Object.values(row.cells).filter((c) => c.kind !== "not-exposed");
      expect(exposed.length, `${row.id} [${row.variant}] runs nowhere`).toBeGreaterThan(0);
      expect(
        new Set(exposed.map((c) => JSON.stringify(c))).size,
        `${row.id} [${row.variant}]: ${JSON.stringify(row.cells)}`,
      ).toBe(1);
      expect(exposed[0].kind === "rejected" ? row.rejection : undefined, `${row.id} [${row.variant}]`).toBe(
        exposed[0].kind === "rejected" ? "invalid_input" : undefined,
      );
    }
    // The rendered rows say the same: every non-"—" cell of a row is the same glyph, and only a rejected row names a code.
    const rendered = renderConformanceMatrix(matrix)
      .split("\n")
      .map((l) => l.split(" | "))
      .filter(
        (cols) => cols.length === SURFACE_METAS.length + 2 && /^\| [^-|]/.test(cols[0]) && cols[0] !== "| Variant",
      );
    expect(rendered.length).toBe(rows.length);
    for (const cols of rendered) {
      const cells = cols
        .slice(2)
        .map((c) => c.replace(/\s*\|$/, ""))
        .filter((c) => c !== "—");
      expect(new Set(cells).size, cols.join(" | ")).toBe(1);
      expect(cols[0].includes("→ `invalid_input`"), cols.join(" | ")).toBe(cells[0] === "⛔");
    }
    expect(renderVariantCell({ variant: "unknown option", rejection: "invalid_input" })).toBe(
      "unknown option → `invalid_input`",
    );
    expect(renderVariantCell({ variant: "required-only" })).toBe("required-only");
  });

  it("toChatText quotes a token exactly as the tokenizer needs: whitespace, empty, an embedded \" or ' — and round-trips QUOTED_SAMPLE", () => {
    for (const t of [
      "plain",
      "",
      "two words",
      'say "hi"',
      "it's",
      `a"b'c`,
      QUOTED_SAMPLE,
      " lead",
      "trail ",
      `"`,
      "'",
    ]) {
      const quoted = quoteChatToken(t);
      expect(tokenize(quoted), JSON.stringify(t)).toEqual({ ok: true, tokens: [t] });
    }
    expect(quoteChatToken("plain")).toBe("plain");
    expect(quoteChatToken("two words")).toBe('"two words"');
    expect(quoteChatToken('say "hi"')).toBe(`'say "hi"'`);
    expect(tokenize(toChatText(["config", "instructions"], ["me", ...QUOTED_SAMPLE.split(" ")]))).toEqual({
      ok: true,
      tokens: ["config", "instructions", "me", ...QUOTED_SAMPLE.split(" ")],
    });
    // The suite exercises this on every command with a free-text field.
    expect(
      CATALOGUE.some((cmd) => variantsOf(cmd).variants.some((v) => v.name.endsWith(" with embedded quotes"))),
    ).toBe(true);
  });
});

/** One line per command the generic fixture cannot drive to success: a field
 *  with no acceptable sample, or a required-only invocation that does not
 *  come back `ok`. Each command gets a fresh fixture (a write must not taint
 *  the next command's run). */
async function conformanceFailures(build: () => Promise<Fixture>): Promise<string[]> {
  const failures: string[] = [];
  const cmds = (await build()).commands.list();
  for (const cmd of cmds) {
    const f = await build();
    const { variants, missingSamples } = variantsOf(cmd);
    if (missingSamples.length > 0) {
      failures.push(
        `${cmd.id}: no sample for ${missingSamples.join(", ")} — add a hint in FIELD_HINTS or a COMMAND_FIXTURES entry`,
      );
      continue;
    }
    const happy = variants.find((v) => v.name === "required-only")!;
    const res = await reference(f, cmd, happy.named, powerCaller);
    if (!res.ok)
      failures.push(
        `${cmd.id}: happy path ${JSON.stringify(happy.named)} failed: ${res.error} — ${res.message}; add a COMMAND_FIXTURES entry (hints/baseline) or fake its dependency in fakeDeps`,
      );
  }
  return failures;
}

// ---- 1–6. every command × every variant × every surface --------------------------------------------------

describe.each(CATALOGUE.map((cmd) => ({ id: cmd.id, cmd })))("command conformance — $id", ({ cmd }) => {
  const variants = variantsOf(cmd).variants;

  it("names derive mechanically: tools/list carries group_verb with the exact jsonSchemaFor; /api/<id>, argv words, and chat form all resolve to this command", async () => {
    const f = await fixture();
    const names = toSurfaceNames(cmd.id);
    expect(names).toEqual({
      http: `/api/${cmd.id}`,
      mcp: cmd.id.replace(".", "_"),
      cli: cmd.id.split("."),
      chat: cmd.id.replace(".", " "),
    });
    const list = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer power" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      {} as CoreDeps,
      { auth: { tokens: { power: { subject: "power" } } }, commands: f.commands, grantsFor: () => ALL_GRANTS },
    );
    const tools = (list.body as { result: { tools: { name: string; inputSchema: unknown }[] } }).result.tools;
    const tool = tools.find((t) => t.name === names.mcp);
    if (cmd.surfaces?.mcp === false) expect(tool).toBeUndefined();
    else expect(tool?.inputSchema).toEqual(jsonSchemaFor(cmd));
    if (cmd.surfaces?.cli !== false)
      expect(parseCliArgv([...names.cli, "--help"], f.commands)).toEqual({ kind: "command-help", id: cmd.id });
    else expect(parseCliArgv([...names.cli, "--help"], f.commands).kind).toBe("usage");
    const chatParsed = parseChatCommand(`${names.chat} --help`, f.commands);
    if (cmd.surfaces?.chat !== false) expect(chatParsed?.kind).toBe("reply");
    else expect(chatParsed).toBeNull();
    const t = fakeReqRes(
      cmd.effect === "write" ? "POST" : "GET",
      names.http,
      cmd.effect === "write" ? "{}" : undefined,
      { "content-type": "application/json" },
    );
    await httpHandler(f)(t.req, t.res, { sub: "power" });
    if (cmd.surfaces?.http !== false) expect(t.status(), t.text()).not.toBe(404);
    else expect(t.status(), `${cmd.id}: opted out of http yet served`).toBe(404);
  });

  it("MCP inputSchema lists exactly the arguments and options, required = the non-optional ones, additionalProperties false; enum values and defaults survive", () => {
    const fields = fieldsOf(cmd);
    const schema = jsonSchemaFor(cmd) as {
      properties: Record<string, { enum?: unknown[]; default?: unknown; anyOf?: { enum?: unknown[] }[] }>;
      required?: string[];
      additionalProperties: boolean;
    };
    expect(schemaPropertyNames(cmd)).toEqual(fields.map((f) => f.name).sort());
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(
      fields
        .filter((f) => f.required)
        .map((f) => f.name)
        .sort(),
    );
    for (const f of fields) {
      const declaredEnum = (() => {
        const def = (
          f.schema as unknown as {
            _zod: { def: { type: string; innerType?: z.ZodType; entries?: Record<string, unknown> } };
          }
        )._zod.def;
        const inner =
          def.type === "optional" || def.type === "default"
            ? (def.innerType as unknown as { _zod: { def: { type: string; entries?: Record<string, unknown> } } })._zod
                .def
            : def;
        return inner.type === "enum" && inner.entries ? Object.values(inner.entries) : undefined;
      })();
      if (declaredEnum)
        expect(
          schema.properties[f.name].enum ?? schema.properties[f.name].anyOf?.flatMap((a) => a.enum ?? []),
          `${cmd.id}.${f.name} enum`,
        ).toEqual(declaredEnum);
      const def = (f.schema as unknown as { _zod: { def: { type: string; defaultValue?: unknown } } })._zod.def;
      if (def.type === "default")
        expect(schema.properties[f.name].default, `${cmd.id}.${f.name} default`).toEqual(def.defaultValue);
    }
  });

  it("help (CLI --help and chat --help) names every argument and every option flag", async () => {
    const f = await fixture();
    const fields = fieldsOf(cmd);
    const check = (text: string, where: string) => {
      for (const a of fields.filter((x) => x.kind === "arg"))
        expect(text, `${where} names <${a.name}>`).toContain(`<${a.name}>`);
      for (const flag of expectedFlags(cmd)) expect(text, `${where} names ${flag}`).toContain(flag);
      expect(text).toContain(cmd.describe);
    };
    if (cmd.surfaces?.cli !== false)
      check((await runCli(f.commands, { kind: "command-help", id: cmd.id }, CLI_CALLER)).stdout, "cli --help");
    if (cmd.surfaces?.chat !== false) {
      const parsed = parseChatCommand(`${toSurfaceNames(cmd.id).chat} --help`, f.commands);
      expect(parsed?.kind).toBe("reply");
      check(parsed?.kind === "reply" ? parsed.text : "", "chat --help");
      assertChatShape(parsed?.kind === "reply" ? parsed.text : "", "chat --help");
    }
  });

  it("every accepted variant binds to the same parsed { args, options } and yields the identical invoke JSON on every exposed surface (chat: renderText of it), modulo the caller's own id; the Caller is the adapter's; no token, no secret; free text wrapped", async () => {
    for (const variant of variants.filter((v) => v.expect.ok)) {
      const label = `${cmd.id} [${variant.name}]`;
      // Reads share one fixture and must leave it untouched; each write gets its own.
      const shared = cmd.effect === "read" ? await fixture() : undefined;
      const fresh = async () => shared ?? (await fixture());
      const before = shared ? await shared.fingerprint() : undefined;
      let firstParsed: unknown;
      let firstJson: unknown;
      for (const surface of surfacesFor(cmd, variant)) {
        const where = `${label} via ${surface.meta.column}`;
        const f = await fresh();
        f.recorded.length = 0;
        const out = await runOn(surface, f, cmd, variant.named, "power");
        expect(out.ok, `${where}: ${out.wire}`).toBe(true);
        const { caller, parsed } = lastInvoke(f, cmd);
        expect({ kind: caller.kind, id: caller.id }, `${where}: the Caller the registry saw`).toEqual(
          surface.caller("power"),
        );
        if (surface === chat) expect(caller.origin?.channelId, `${where}: chat origin`).toBe(CHAT_CHANNEL);
        // The reference: a direct `invoke` as the very caller the adapter resolved, on an equivalent fixture.
        const refFixture = await fresh();
        const ref = await reference(refFixture, cmd, variant.named, caller);
        expect(ref.ok, `${where}: reference invoke ${JSON.stringify(ref)}`).toBe(true);
        if (!ref.ok) continue;
        expect(parsed, `${where}: parsed input`).toEqual(lastInvoke(refFixture, cmd).parsed);
        const normalizedParsed = withCallerToken(parsed, caller.id);
        firstParsed ??= normalizedParsed;
        expect(normalizedParsed, `${where}: parsed input differs from the first surface's`).toEqual(firstParsed);
        if (surface.meta.machine) {
          expect(out.json, `${where}: invoke JSON`).toEqual(ref.value);
          assertUntrusted(out.json, where);
          const normalized = withCallerToken(out.json, caller.id);
          firstJson ??= normalized;
          expect(
            normalized,
            `${where}: invoke JSON differs from the first machine surface's (beyond the caller's own id)`,
          ).toEqual(firstJson);
        } else {
          expect(out.text, `${where}: chat reply`).toBe(renderText(cmd, ref.value, { now: NOW, surface: "chat" }));
          assertChatShape(out.text ?? "", `${where}: chat reply`);
        }
        assertNoSecrets(out.wire, f, where);
      }
      if (shared && before !== undefined)
        expect(await shared.fingerprint(), `${label}: a read command mutated the fixture`).toBe(before);
    }
  });

  it("every rejected variant (type mismatch per field, unknown option, missing argument) is refused on every surface with the ONE expected code — identical across surfaces — naming the field, never echoing the value", async () => {
    for (const variant of variants.filter((v) => !v.expect.ok)) {
      if (variant.expect.ok) continue;
      const { field } = variant.expect;
      const codes = new Map<string, string | undefined>();
      for (const surface of surfacesFor(cmd, variant)) {
        const f = await fixture();
        const out = await runOn(surface, f, cmd, variant.named, "power");
        const where = `${cmd.id} [${variant.name}] via ${surface.meta.column}`;
        expect(out.ok, `${where}: accepted ${out.wire}`).toBe(false);
        // One error vocabulary: a grammar surface that refuses before invoke reports the registry's own code for that fault.
        expect(out.code, `${where}: ${out.wire}`).toBe(expectedRejection(variant));
        codes.set(surface.meta.column, out.code);
        if (surface.meta.key === "cli") expect(out.status, `${where}: exit code`).toBe(2);
        expect(namesField(out.text ?? "", field), `${where}: "${out.text}" does not name ${field}`).toBe(true);
        if (variant.planted !== undefined)
          expect(out.wire, `${where}: echoes the submitted value`).not.toContain(
            typeof variant.planted === "string" ? variant.planted : JSON.stringify(variant.planted),
          );
        assertNoSecrets(out.wire, f, where);
        // Nothing ran: the fixture is untouched by a refused call.
        expect(f.recorded.filter((r) => r.result.ok)).toEqual([]);
        expect(f.executed, `${where}: an executor ran`).toEqual([]);
      }
      // The cells of this row agree: one code, whichever surface spelled the fault.
      expect(
        new Set(codes.values()).size,
        `${cmd.id} [${variant.name}]: codes differ across surfaces ${JSON.stringify([...codes])}`,
      ).toBe(1);
    }
  });

  it("auth: a credential without the grant is refused BEFORE parse on every machine surface (a malformed input still gets unauthorized, not invalid_input); chat admission is the table's decision for the message's actor; writes are POST-only", async () => {
    const happy = variants.find((v) => v.name === "required-only")!;
    const malformed: Named = { ...happy.named, [UNKNOWN_OPTION]: "x" };
    for (const surface of surfacesFor(cmd).filter((s) => s.meta.machine)) {
      const f = await fixture();
      // The CLI's grammar runs before invoke (its one real caller holds every grant), so it gets the well-formed input.
      const out = await runOn(surface, f, cmd, surface === cli ? happy.named : malformed, "nobody");
      expect(out.ok, `${cmd.id} via ${surface.meta.column}: nobody was admitted`).toBe(false);
      expect(out.code, `${cmd.id} via ${surface.meta.column}: ${out.wire}`).toBe("unauthorized");
      if (surface === httpGet || surface === httpPost) expect(out.status).toBe(403);
      expect(f.recorded.filter((r) => r.result.ok)).toEqual([]);
      expect(f.executed).toEqual([]);
      assertNoSecrets(out.wire, f, `${cmd.id} via ${surface.meta.column} (refused)`);
    }
    if (cmd.surfaces?.chat !== false) {
      const f = await fixture();
      // What the table says for the actor the chat adapter resolves for NOBODY (the plain Slack user's baseline grants).
      const msg = { userId: NOBODY, channelId: CHAT_CHANNEL, threadKey: `${CHAT_CHANNEL}:t1` };
      const nobody: Caller = {
        kind: "chat",
        id: NOBODY,
        actor: resolveChatActor(msg, (id) => f.config.grantsFor(id)),
        origin: msg,
      };
      const input = namedToInput(cmd, forCaller(happy.named, NOBODY), "camel");
      if ("error" in input) throw new Error(input.error);
      const admitted = authorize(nobody.actor, cmd.action, resourceOf(cmd, input, nobody)).allow;
      const out = await runOn(chat, f, cmd, happy.named, "nobody");
      expect(out.ok, `${cmd.id} (${cmd.action}): nobody admitted=${admitted}, got ${out.wire}`).toBe(admitted);
      if (!admitted) {
        expect(out.code).toBe("unauthorized");
        expect(out.text).toMatch(/^🚫 `.+` is restricted\. Ask /);
        expect(f.executed).toEqual([]);
      }
    }
    // A credential holding no grant at all is refused whatever the surface (fail-closed, R7) — driven as a CLI
    // caller, the one surface every command is exposed on.
    const bare = await reference(await fixture(), cmd, happy.named, {
      kind: "cli",
      id: "cli:nothing",
      actor: { kind: "service", id: "cli:nothing", grants: NO_GRANTS },
    });
    expect(bare).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    if (cmd.surfaces?.http !== false) {
      const f = await fixture();
      const t = fakeReqRes(
        "GET",
        `${toSurfaceNames(cmd.id).http}?${toKebabQuery(forCaller(happy.named, "access:power")).toString()}`,
      );
      await httpHandler(f)(t.req, t.res, { sub: "power" });
      if (cmd.effect === "write") expect(t.status(), `${cmd.id}: write over GET`).toBe(405);
      else expect(t.status(), `${cmd.id}: read over GET`).toBe(200);
      if (cmd.effect === "write") {
        expect(f.recorded).toEqual([]);
        expect(f.executed).toEqual([]);
      }
    }
  });

  it("authorization (R13): for every actor of the fixed set, the surface that carries it admits or refuses exactly as `authorize` over the policy table says; a refusal is `unauthorized` before parse with nothing executed", async () => {
    const happy = variants.find((v) => v.name === "required-only")!;
    const row = buildAuthorizationMatrix([cmd]).rows[0]!;
    for (const role of AUTHZ_ROLES.filter((r) => CommandRegistry.exposedTo(cmd, carriedBy(r.id)))) {
      const admitted = admits(cmd, role);
      expect(row.cells[role.id], `${cmd.id} × ${role.column}: matrix cell`).toBe(admitted);
      const f = await fixture(() => {}, "authz");
      const out = await runAsRole(f, cmd, happy.named, role);
      const where = `${cmd.id} (${cmd.action} on ${row.resource}) × ${role.column}`;
      if (admitted) {
        expect(registryRefused(f, out), `${where}: the table admits, the surface refused: ${out.wire}`).toBe(false);
      } else {
        expect(registryRefused(f, out), `${where}: the table refuses, the surface admitted: ${out.wire}`).toBe(true);
        if (carriedBy(role.id) === "access") expect(out.status, where).toBe(403);
        if (carriedBy(role.id) === "chat") expect(out.text, where).toMatch(/^🚫 `.+` is restricted\. Ask /);
        expect(
          f.recorded.filter((r) => r.result.ok),
          where,
        ).toEqual([]);
        expect(f.executed, where).toEqual([]);
        assertNoSecrets(out.wire, f, where);
      }
    }
  });
});
