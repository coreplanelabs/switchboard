import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CommandRegistry, flag, type CommandDef } from "../core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../core/commands/all.js";
import {
  cell,
  docCommands,
  GENERATED_REGIONS,
  renderApiRoutes,
  renderCapabilityCommands,
  renderChatCommands,
  renderCliCommands,
  usageFor,
  whoMayRun,
} from "./reference.js";
import { declaredRegions } from "./regions.js";
import type { Capabilities } from "../core/capabilities.js";
import { CAPABILITY_KEYS, dependsOn } from "../core/capabilityGating.js";
import { chatForm } from "../core/commandSurface.js";

/** A hand-built catalogue: one command per shape the renderers must handle. */
function fixture(): CommandDef<unknown>[] {
  return [
    {
      id: "thing.show",
      args: [{ name: "scope", schema: z.enum(["me", "channel"]), describe: "whose" }],
      options: z.object({ dryRun: flag.optional(), limit: z.coerce.number().int().optional() }),
      action: "repo:read",
      effect: "read",
      describe: "Show a thing; per-agent forms take --models.<agent>.",
      handler: async () => null,
    },
    {
      id: "thing.wipe",
      args: [{ name: "id", schema: z.string(), describe: "which" }],
      action: "repo:write",
      effect: "write",
      describe: "Wipe it.",
      handler: async () => null,
    },
    {
      id: "local.only",
      action: "deploy:write",
      effect: "write",
      surfaces: { chat: false, http: false, mcp: false },
      describe: "Operator-only, terminal-only.",
      handler: async () => null,
    },
  ] as unknown as CommandDef<unknown>[];
}

const docs = docCommands(fixture());

describe("usageFor", () => {
  it("prints an enum positional as its values, since a table has no help text under it", () => {
    expect(usageFor(fixture()[0])).toContain("thing show <me|channel>");
  });

  it("keeps the argument's name when its schema is not an enum, and brackets optional flags", () => {
    expect(usageFor(fixture()[1])).toBe("thing wipe <id>");
    expect(usageFor(fixture()[0])).toBe("thing show <me|channel> [--dry-run] [--limit <integer>]");
  });
});

describe("cell", () => {
  it("escapes a pipe so it cannot end the cell", () => {
    expect(cell("a|b")).toBe("a\\|b");
  });

  it("escapes angle brackets in prose (a bare <agent> is a tag to GitHub and a component to Vue)", () => {
    expect(cell("takes --models.<agent>")).toBe("takes --models.&lt;agent&gt;");
  });

  it("leaves angle brackets inside an inline code span alone, where an entity would render literally", () => {
    expect(cell("pass `--mode <soft>` please")).toBe("pass `--mode <soft>` please");
  });

  it("flattens newlines, which would end the row", () => {
    expect(cell("a\n\nb")).toBe("a b");
  });
});

describe("renderCliCommands", () => {
  const out = renderCliCommands(docs);

  it("sections by group in registration order", () => {
    expect(out.indexOf("### `thing`")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("### `thing`")).toBeLessThan(out.indexOf("### `local`"));
  });

  it("collapses the all-surfaces case to two words so the narrow ones stand out", () => {
    expect(out).toContain("| `thing wipe <id>` | Wipe it. | every surface |");
    expect(out).toContain("CLI only");
  });
});

describe("renderChatCommands", () => {
  const out = renderChatCommands(docs);

  it("omits commands opted out of chat", () => {
    expect(out).not.toContain("local only");
  });

  it("states who may run each one, in the vocabulary of the permissions reference — decided by the policy table, not asserted by the definition", () => {
    expect(out).toContain(
      "| `thing show <me\\|channel> [--dry-run] [--limit <integer>]` | Show a thing; per-agent forms take --models.&lt;agent&gt;. | anyone |",
    );
    expect(out).toContain("| `thing wipe <id>` | Wipe it. | repo managers (`repo:write`) |");
    expect(out).toContain("| Command | What it does | Who can run it |");
  });
});

describe("whoMayRun", () => {
  const cmd = (
    action: string,
    resource?: CommandDef<unknown>["resource"],
  ): Pick<CommandDef<unknown>, "id" | "action" | "resource"> => ({
    id: "x.y",
    action: action as CommandDef<unknown>["action"],
    ...(resource ? { resource } : {}),
  });

  it("labels the narrowest Slack reader the table admits: the open baseline, the coding right, repo management, admins", () => {
    expect(whoMayRun(cmd("help:read"))).toBe("anyone");
    expect(whoMayRun(cmd("config:write"))).toBe("anyone"); // a person's own scope; the channel scope is the handler's question
    expect(whoMayRun(cmd("repo:exec", () => ({ type: "agent", name: "coding" })))).toBe(
      "anyone granted `agent:run:coding`",
    );
    expect(whoMayRun(cmd("friction:write"))).toBe("repo managers (`repo:write`)");
    expect(whoMayRun(cmd("runs:read"))).toBe("admins");
  });

  it("a command whose action has no row is nobody's — the docs say so instead of guessing", () => {
    expect(whoMayRun(cmd("thing:read"))).toBe("nobody in Slack");
  });
});

describe("renderApiRoutes", () => {
  const out = renderApiRoutes(docs);

  it("gives a write POST only and a read either verb, with the action a token needs", () => {
    expect(out).toContain("| `/api/thing.wipe` | `POST` | `repo:write` |");
    expect(out).toContain("| `/api/thing.show` | `GET`, `POST` | `repo:read` |");
    expect(out).toContain("| Route | Methods | Action | What it does |");
  });

  it("omits commands with no HTTP surface", () => {
    expect(out).not.toContain("/api/local.only");
  });
});

describe("renderCapabilityCommands", () => {
  /** The hand-built catalogue plus one command that needs memory. */
  const gated = docCommands([
    ...fixture(),
    {
      id: "thing.remember",
      action: "memory:read",
      effect: "read",
      describe: "Needs memory.",
      enabledWhen: (caps: Capabilities) => caps.memory,
      handler: async () => null,
    },
  ] as unknown as CommandDef<unknown>[]);
  const out = renderCapabilityCommands(gated);

  it("has one row per capability axis, in the contract's order, and names a gated command in its axis's row in chat form", () => {
    const rows = out.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows.map((r) => r.split("|")[1].trim())).toEqual(CAPABILITY_KEYS.map((k) => `\`${k}\``));
    expect(out).toContain("| `memory` | `thing remember` |");
  });

  it("reads — for an axis that turns nothing on, and counts the always-on commands in the closing line", () => {
    expect(out).toContain("| `costs` | — |");
    expect(out).toContain("The other 3 commands are on in every installation.");
  });
});

describe("the real catalogue", () => {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  const real = docCommands(registry.list() as CommandDef<unknown>[]);

  it("renders every registered command into the CLI table — including the groups a hand-written table had gone stale on", () => {
    const out = renderCliCommands(real);
    for (const cmd of real) expect(out).toContain(`\`${cmd.usage.replace(/\|/g, "\\|")}\``);
    expect(out).toContain("### `mcp`");
    expect(out).toContain("deploy restart");
  });

  it("the capability column lists, per axis, exactly the commands dependsOn derives from the registry — a list nobody typed", () => {
    const out = renderCapabilityCommands(real);
    const defs = registry.list() as CommandDef<unknown>[];
    for (const key of CAPABILITY_KEYS) {
      const expected = defs.filter((cmd) => dependsOn(cmd).includes(key)).map((cmd) => `\`${chatForm(cmd.id)}\``);
      expect(out).toContain(`| \`${key}\` | ${expected.length === 0 ? "—" : expected.join(", ")} |`);
    }
    const alwaysOn = defs.filter((cmd) => dependsOn(cmd).length === 0).length;
    expect(out).toContain(`The other ${alwaysOn} commands are on in every installation.`);
  });

  it("emits no unescaped pipe inside a table row (each row must have the column count its header declares)", () => {
    // One width per renderer: every row of a table — header included — splits into the same number
    // of cells once the escaped pipes are removed. A stray `|` in a cell would make its row wider.
    const renderers = { renderCliCommands, renderChatCommands, renderApiRoutes, renderCapabilityCommands };
    for (const [name, render] of Object.entries(renderers)) {
      const rows = render(real)
        .split("\n")
        .filter((l) => l.startsWith("|") && !/^\|[-|]+\|$/.test(l));
      expect(rows.length, `${name}: renders table rows`).toBeGreaterThan(1);
      const widths = new Set(rows.map((r) => r.replace(/\\\|/g, "").split("|").length));
      expect([...widths], `${name}: every row has the header's column count`).toHaveLength(1);
    }
  });
});

describe("GENERATED_REGIONS", () => {
  it("matches the markers actually present in each docs page (a renamed marker fails here, not silently)", () => {
    for (const [file, regions] of Object.entries(GENERATED_REGIONS)) {
      const text = readFileSync(new URL(`../../docs/${file}`, import.meta.url), "utf8");
      expect(declaredRegions(text).sort()).toEqual(Object.keys(regions).sort());
    }
  });
});
