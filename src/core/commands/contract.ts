import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import {
  contractFromPlan,
  DEFAULT_CONTRACT_MAX_CHARS,
  parsePlanUnit,
  renderContract,
  specItemRefs,
  type AgentRules,
} from "../ship/contract.js";

// `contract render --plan <path> --unit U<n>` (docs/reference/specs/agent-ship.md
// item 13): the child contract rendered by hand until the plan runner exists —
// a person pastes the block into a coding prompt and posts the rendered
// length, the number the design record lacks. The command decides only where
// the plan's specs and rules are read from (the repository root the plan path
// implies, or `--root`) and which rules file wins (AGENTS.md, else CLAUDE.md,
// else none); the object and its rendering are `src/core/ship/contract.ts`'s.
//
// CLI-only: it reads host paths the caller names, which is the local
// operator's to do (`cli:local`) and no remote surface's. Its action is
// `contract:read`; no chat baseline holds it.

export interface ContractCommandDeps {
  contract: {
    /** The text at a host path, undefined when there is no such file. */
    readFile(path: string): Promise<string | undefined>;
  };
}

const defineCommand = commandDefiner<ContractCommandDeps>();

const SPECS_DIR = join("docs", "reference", "specs");
/** The rules files, in the order one is taken. */
const RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** The repository root a plan path implies: the directory above `docs/plans/<file>`,
 *  else the plan's own directory (a plan kept elsewhere; `--root` says where the repo is). */
export function repoRootOfPlan(planPath: string): string {
  const plans = dirname(planPath);
  const docs = dirname(plans);
  if (basename(plans) === "plans" && basename(docs) === "docs") return dirname(docs);
  return plans;
}

function renderOutput(output: JsonValue): string {
  const o = output as JsonObject;
  const dropped = Array.isArray(o.dropped) && o.dropped.length > 0 ? o.dropped.map(String).join(", ") : "none";
  const over = o.overBudget === true ? " — still over the budget" : "";
  return `${String(o.text)}\n\n(${String(o.chars)} characters; budget ${String(o.maxChars)}; dropped: ${dropped}${over})`;
}

export const contractRender = defineCommand({
  id: "contract.render",
  options: z.object({
    plan: z.string().min(1).describe("path of the plan record (docs/plans/<file>.md)"),
    unit: z
      .string()
      .regex(/^U\d+$/, "expected a unit id like U<n>")
      .describe("the unit to render, as its heading spells it (U<n>)"),
    root: z
      .string()
      .min(1)
      .optional()
      .describe("the repository root the specs and rules are read under (default: the root the plan path implies)"),
    branch: z.string().min(1).optional().describe("the unit's branch, named in the first instruction"),
    onto: z.string().min(1).optional().describe("the merged parent the branch is rebased onto"),
    maxChars: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(`the rendered block's budget in characters (default ${DEFAULT_CONTRACT_MAX_CHARS})`),
  }),
  action: "contract:read",
  effect: "read",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Render one plan unit's child contract — its section, the spec rows it names with their proof bindings, the repository's agent rules, the guards — as the `## Contract` block a coding prompt carries, and measure it.",
  render: renderOutput,
  handler: async ({ options, deps }) => {
    const planMarkdown = await deps.contract.readFile(options.plan);
    if (planMarkdown === undefined) throw new CommandError("not_found", `plan not found: ${options.plan}`);
    const root = options.root ?? repoRootOfPlan(options.plan);
    // The builder is pure and synchronous, so the specs the unit names are read
    // first, exactly those; a unit the plan lacks names nothing and the builder
    // below refuses it with the units the plan has.
    const unit = parsePlanUnit(planMarkdown, options.unit);
    const specs = new Map<string, string | undefined>();
    for (const spec of new Set(unit ? specItemRefs(unit.section).map((r) => r.spec) : []))
      specs.set(spec, await deps.contract.readFile(join(root, SPECS_DIR, spec)));
    let agentRules: AgentRules | undefined;
    for (const file of RULES_FILES) {
      const text = await deps.contract.readFile(join(root, file));
      if (text !== undefined) {
        agentRules = { file, text };
        break;
      }
    }
    let contract;
    try {
      contract = contractFromPlan({
        planMarkdown,
        unitId: options.unit,
        readSpec: (spec) => specs.get(spec),
        ...(agentRules ? { agentRules } : {}),
        rebase: { branch: options.branch, onto: options.onto },
      });
    } catch (err) {
      throw new CommandError("invalid_input", err instanceof Error ? err.message : String(err));
    }
    const maxChars = options.maxChars ?? DEFAULT_CONTRACT_MAX_CHARS;
    const rendered = renderContract(contract, { maxChars });
    return {
      plan: options.plan,
      root,
      unit: { id: contract.unit.id, title: contract.unit.title },
      specRows: contract.specRows.map((r) => ({
        spec: r.spec,
        item: r.item,
        found: r.text !== undefined,
        validationRows: r.validation.length,
      })),
      agentRules: agentRules?.file ?? null,
      chars: rendered.chars,
      maxChars,
      dropped: rendered.dropped,
      overBudget: rendered.overBudget,
      text: rendered.text,
    };
  },
});

export const contractCommands: readonly CommandDef<ContractCommandDeps>[] = [
  contractRender,
] as unknown as CommandDef<ContractCommandDeps>[];

export function registerContractCommands<D extends ContractCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of contractCommands) registry.register(cmd as unknown as CommandDef<D>);
}
