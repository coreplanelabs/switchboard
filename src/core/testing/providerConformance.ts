// The provider conformance scaffold (record 0052): controls × outcomes as
// rows, harness × block as drivers, each cell a scripted card resolution and
// control decision asserted against the record the card produces and the
// request body the decided words render. The lint names a wire, an
// example-config block or a control with no row; the printer renders the table
// the pull request carries. Nothing here touches the network: the upstream is
// a capturing function, so every cell is scripted.
//
// This is the scaffold this slice lands: the first rows are the record's trace steps
// 2, 3, 5, 7 and 12. The harness-write rows — the card written into pi's
// models.json and OpenCode's configuration — need a later slice and are declared
// `cannot` on every driver with the reason, so the table already shows the gap
// it will close. No vitest import: plain TypeScript the test drives.

import { parseModelRef, wireOf, WIRES, type ProviderConfig, type Wire } from "../provider.js";
import {
  decideControls,
  resolveModelCard,
  type AskedControls,
  type CardRegistry,
  type ControlDecision,
  type ModelCard,
} from "../modelCard.js";
import { installedModelRegistry } from "../installedModelRegistry.js";

/** Every control the matrix has a row for. A control in this list with no row
 *  fails the lint by name. */
export const PROVIDER_CONTROLS = ["effort", "cap", "inputs", "window", "cache"] as const;
export type ProviderControl = (typeof PROVIDER_CONTROLS)[number];

/** A cell's declared outcome (record 0052). */
export type CellOutcome = "native" | "degraded" | "refused";

/** What one row asserts about one control's decision. */
export interface CellExpectation {
  outcome: CellOutcome;
  /** The word applied on the wire, when the row cares. */
  applied?: string;
  /** Whether a layer vouched for the applied word. */
  vouched?: boolean;
  /** A fragment `why` must carry, when the row cares. */
  why?: string;
}

/** One row: a control, an outcome, the block/model it is scripted against and
 *  the words it asserts. `trace` names the record's trace step it came from. */
export interface ProviderScenarioRow {
  id: string;
  control: ProviderControl;
  title: string;
  /** The record's trace step this row is (the first rows are steps 2, 3, 5, 7, 12). */
  trace?: number;
  ref: string;
  asked: AskedControls;
  expect: CellExpectation;
  /** The request body the decided words render, for the payload half of the
   *  assertion; absent when the row only reads the record. */
  payload?: (body: Record<string, unknown>, card: ModelCard) => void;
  /** A row whose cell needs a harness write (a later slice) rather than a record: the
   *  reason the driver declares it cannot. */
  needsHarnessWrite?: string;
}

/** One harness's driver: the blocks and catalog it runs against, and the rows
 *  it declares it cannot pass. */
export interface ProviderDriver {
  harness: string;
  blocks: Readonly<Record<string, ProviderConfig>>;
  registry: CardRegistry;
  /** Rows this driver cannot pass, by id, each with why — asserted, never
   *  skipped (the harness suite's rule). */
  cannot?: Readonly<Record<string, string>>;
}

/** The request body a harness would send for the decided card (the payload
 *  half of a cell): the cap under the card's field, the effort word the card
 *  mapped, and nothing for a control the card does not decide. This is the
 *  capture the proxy's own `fetch` seam records once a later slice writes the card into
 *  a harness; here it is scripted from the decision. */
export function capturedBody(card: ModelCard, decisions: readonly ControlDecision[]): Record<string, unknown> {
  const body: Record<string, unknown> = { model: card.model };
  const effort = decisions.find((d) => d.control === "effort" && d.outcome !== "refused");
  if (effort?.applied !== undefined) body.reasoning_effort = effort.applied;
  const cap = decisions.find((d) => d.control === "cap");
  if (cap?.applied !== undefined) body[cap.applied] = 4096;
  return body;
}

/** One cell run: the card, its decisions, the request body they render, and
 *  the decision this row's control landed on. */
export interface ProviderCell {
  card: ModelCard;
  decisions: ControlDecision[];
  body: Record<string, unknown>;
  decision: ControlDecision | undefined;
}

/** The row's control decided against its card — what the row's check reads. A
 *  row the driver declares it cannot run (a harness write this slice does not
 *  do) refuses here, with the declared reason, so the cell fails as declared
 *  rather than passing on a record it cannot act on. */
export function runProviderRow(driver: ProviderDriver, row: ProviderScenarioRow): ProviderCell {
  const declared = driver.cannot?.[row.id] ?? row.needsHarnessWrite;
  if (declared !== undefined) throw new Error(declared);
  const card = resolveModelCard(row.ref, driver.blocks, driver.registry);
  const decisions = decideControls(card, row.asked);
  const body = capturedBody(card, decisions);
  return { card, decisions, body, decision: decisions.find((d) => d.control === row.control) };
}

/** Assert one row's cell: the decision's outcome, words and payload must match
 *  what the row declares, and a row with no decision is a failure (it read no
 *  record). */
export function assertProviderCell(cell: ProviderCell, row: ProviderScenarioRow): void {
  const d = cell.decision;
  if (!d) throw new Error(`row ${row.id} reads no ${row.control} decision`);
  if (d.outcome !== row.expect.outcome)
    throw new Error(`row ${row.id}: ${row.control} is ${d.outcome}, declared ${row.expect.outcome}`);
  if (row.expect.applied !== undefined && d.applied !== row.expect.applied)
    throw new Error(`row ${row.id}: ${row.control} applied ${String(d.applied)}, declared ${row.expect.applied}`);
  if (row.expect.vouched !== undefined && d.vouched !== row.expect.vouched)
    throw new Error(
      `row ${row.id}: ${row.control} vouched ${String(d.vouched)}, declared ${String(row.expect.vouched)}`,
    );
  if (row.expect.why !== undefined && !d.why.includes(row.expect.why))
    throw new Error(`row ${row.id}: why "${d.why}" does not carry "${row.expect.why}"`);
  if (row.payload) row.payload(cell.body, cell.card);
}

/** A row's verdict for one driver: `pass`; `cannot` — declared and failed as
 *  declared; `fail` — undeclared, or a declared row that passed after all. */
export type ProviderOutcome = "pass" | "fail" | "cannot";

export function providerRowVerdict(
  driver: ProviderDriver,
  row: ProviderScenarioRow,
): { outcome: ProviderOutcome; error?: Error } {
  const declared = driver.cannot?.[row.id] ?? row.needsHarnessWrite;
  try {
    assertProviderCell(runProviderRow(driver, row), row);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (declared === undefined) return { outcome: "fail", error };
    // A declared `cannot` is asserted, never skipped: the cell must fail for
    // the declared reason, not for some other breakage wearing its name.
    if (!error.message.includes(declared)) {
      return {
        outcome: "fail",
        error: new Error(`row ${row.id} fails for a reason other than the declared one: ${error.message}`),
      };
    }
    return { outcome: "cannot", error };
  }
  if (declared === undefined) return { outcome: "pass" };
  return {
    outcome: "fail",
    error: new Error(`row ${row.id} passes for ${driver.harness}, declared cannot: ${declared}`),
  };
}

/** The lint (record 0052): every wire in the enum, every example-config block and
 *  every control must have a row. The caller passes the names it wants held;
 *  a name with no row comes back, and the test fails on a non-empty list. */
export function providerGaps(
  rows: readonly ProviderScenarioRow[],
  names: { wires?: readonly Wire[]; blocks?: readonly string[]; controls?: readonly string[] },
  blocks: Readonly<Record<string, ProviderConfig>>,
): string[] {
  const gaps: string[] = [];
  const wireOfRow = (row: ProviderScenarioRow): Wire | undefined => {
    const block = blocks[parseModelRef(row.ref).provider];
    return block ? wireOf(block) : undefined;
  };
  for (const wire of names.wires ?? WIRES) {
    if (!rows.some((r) => wireOfRow(r) === wire)) gaps.push(`wire ${wire}`);
  }
  for (const block of names.blocks ?? Object.keys(blocks)) {
    if (!rows.some((r) => r.ref.startsWith(`${block}/`))) gaps.push(`block ${block}`);
  }
  for (const control of names.controls ?? PROVIDER_CONTROLS) {
    if (!rows.some((r) => r.control === control)) gaps.push(`control ${control}`);
  }
  return gaps;
}

const CELL: Record<ProviderOutcome, string> = { pass: "✅", fail: "❌", cannot: "✖" };

export interface ProviderColumn {
  harness: string;
  rows: Record<string, ProviderOutcome>;
  cannot?: Readonly<Record<string, string>>;
}

export function buildProviderMatrix(
  drivers: readonly ProviderDriver[],
  rows: readonly ProviderScenarioRow[],
): ProviderColumn[] {
  return drivers.map((driver) => {
    const verdicts: Record<string, ProviderOutcome> = {};
    for (const row of rows) verdicts[row.id] = providerRowVerdict(driver, row).outcome;
    return { harness: driver.harness, rows: verdicts, ...(driver.cannot ? { cannot: driver.cannot } : {}) };
  });
}

/** The matrix as Markdown for the pull request body: one row per scenario, one
 *  column per driver, a declared `cannot` its own mark with the reason below. */
export function renderProviderMatrix(columns: readonly ProviderColumn[], rows: readonly ProviderScenarioRow[]): string {
  const names = columns.map((c) => c.harness);
  const out = [
    `**${rows.length} rows × ${names.length} driver(s)** — record 0052's controls × outcomes; ✅ passes, ❌ fails, ✖ cannot (declared, asserted).`,
    "",
    `| Control | Row | ${names.join(" | ")} |`,
    `|---|---|${names.map(() => ":-:").join("|")}|`,
  ];
  for (const row of rows) {
    const cells = names.map((n) => CELL[columns.find((c) => c.harness === n)?.rows[row.id] ?? "fail"]);
    out.push(`| ${row.control} | \`${row.id}\` — ${row.title} | ${cells.join(" | ")} |`);
  }
  const declared = columns.flatMap((c) =>
    Object.entries(c.cannot ?? {})
      .filter(([id]) => c.rows[id] === "cannot")
      .map(([id, why]) => `✖ ${c.harness} cannot \`${id}\`: ${why}`),
  );
  if (declared.length > 0) out.push("", ...declared);
  out.push("");
  return out.join("\n");
}

// ---- the first rows: the record's trace -------------------------------------

/** The blocks the rows run against: the example config's live blocks plus a
 *  local one, so every wire in the enum has a row. */
export const PROVIDER_BLOCKS: Record<string, ProviderConfig> = {
  anthropic: { type: "anthropic", wire: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { type: "openai-compatible", wire: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  openrouter: {
    type: "openai-compatible",
    wire: "openai-chat",
    vendor: "model",
    catalog: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  deepseek: { type: "openai-compatible", wire: "openai-chat", catalog: "deepseek" },
  local: { type: "openai-compatible", wire: "openai-chat", catalog: "none", baseUrl: "http://localhost:11434/v1" },
};

const registry: CardRegistry = installedModelRegistry;

/** The scaffold's rows. Trace steps 2, 3, 5, 7 and 12 are the record's own
 *  trace on `openrouter/deepseek/deepseek-v4.1-flash` and the V4 Pro pair. */
export const PROVIDER_ROWS: readonly ProviderScenarioRow[] = [
  {
    id: "trace-2-unknown-card",
    control: "window",
    trace: 2,
    title: "a model the catalog does not know resolves every field from the wire layer, provenance wire",
    ref: "openrouter/deepseek/deepseek-v4.1-flash",
    asked: {},
    expect: { outcome: "degraded", applied: "128000", vouched: false, why: "no layer names the window" },
    payload: (body, card) => {
      if (card.provenance.window !== "wire") throw new Error("the window's provenance is not wire");
      if (body.model !== card.model) throw new Error("the payload's model is not the card's");
    },
  },
  {
    id: "trace-3-effort-unvouched",
    control: "effort",
    trace: 3,
    title: "an unknown card sends the asked tier unvouched and says so before the first token",
    ref: "openrouter/deepseek/deepseek-v4.1-flash",
    asked: { effort: "xhigh" },
    expect: { outcome: "degraded", applied: "xhigh", vouched: false, why: "unvouched" },
    payload: (body) => {
      if (body.reasoning_effort !== "xhigh") throw new Error("the payload does not carry the asked tier");
    },
  },
  {
    id: "trace-5-document-stub",
    control: "inputs",
    trace: 5,
    title: "a document degrades to a text stub on every card until a harness carries files",
    ref: "openrouter/deepseek/deepseek-v4.1-flash",
    asked: { documents: 1 },
    expect: { outcome: "degraded", applied: "text", vouched: false, why: "text stub" },
  },
  {
    id: "trace-7-window-degraded",
    control: "window",
    trace: 7,
    title: "an unknown window degrades to pi's 128000 with the note, never a silent 200k",
    ref: "openrouter/deepseek/deepseek-v4.1-flash",
    asked: {},
    expect: { outcome: "degraded", applied: "128000", vouched: false },
  },
  {
    id: "trace-12-effort-refused",
    control: "effort",
    trace: 12,
    title: "a tier the registry card marks null is refused through the aggregator, before the call",
    ref: "openrouter/deepseek/deepseek-v4-pro",
    asked: { effort: "max" },
    expect: { outcome: "refused", vouched: false, why: "does not take effort" },
  },
  {
    id: "trace-12-effort-native",
    control: "effort",
    trace: 12,
    title: "the same tier is native on the same model direct — the card is per block and model",
    ref: "deepseek/deepseek-v4-pro",
    asked: { effort: "max" },
    expect: { outcome: "native", applied: "max", vouched: true },
    payload: (body) => {
      if (body.reasoning_effort !== "max") throw new Error("the payload does not carry the native tier");
    },
  },
  {
    id: "effort-native-anthropic",
    control: "effort",
    title: "a named tier on a known card is native, vouched by the registry",
    ref: "anthropic/claude-opus-4-6",
    asked: { effort: "max" },
    expect: { outcome: "native", applied: "max", vouched: true },
  },
  {
    id: "cap-unvouched",
    control: "cap",
    title: "a cap field no layer names goes out under the wire's default, unvouched",
    ref: "openrouter/deepseek/deepseek-v4.1-flash",
    asked: {},
    expect: { outcome: "degraded", applied: "max_completion_tokens", vouched: false },
    payload: (body) => {
      if (!("max_completion_tokens" in body))
        throw new Error("the payload does not spell the cap with the wire default");
    },
  },
  {
    id: "openai-responses-cap",
    control: "cap",
    title: "an openai-responses block spells the cap with max_output_tokens, unvouched until a layer names it",
    ref: "openai/gpt-5.4",
    asked: {},
    expect: { outcome: "degraded", applied: "max_output_tokens", vouched: false },
  },
  {
    id: "cache-markers",
    control: "cache",
    title: "Anthropic's cache rule is markers from the vendor table; an aggregator's vendor decides it",
    ref: "openrouter/anthropic/claude-sonnet-4",
    asked: {},
    expect: { outcome: "native", applied: "markers", vouched: true },
  },
  {
    id: "harness-write-effort-map",
    control: "effort",
    title: "the resolved level map is written into pi's models.json and OpenCode's variants",
    ref: "anthropic/claude-opus-4-6",
    asked: { effort: "max" },
    expect: { outcome: "native", applied: "max", vouched: true },
    needsHarnessWrite: "a later slice writes the card into the harness; this slice records it only",
  },
  {
    id: "harness-write-cap-field",
    control: "cap",
    title: "the card's cap field is the field the harness's request body spells the cap with",
    ref: "deepseek/deepseek-v4-pro",
    asked: {},
    expect: { outcome: "native", applied: "max_tokens", vouched: true },
    needsHarnessWrite: "a later slice writes the card into the harness; this slice records it only",
  },
];

/** The two drivers the scaffold runs: pi and OpenCode. Both read the same card
 *  in this slice — a later slice makes each harness receive it — so the harness-write
 *  rows are declared cannot on both, with the reason. */
export const PROVIDER_DRIVERS: readonly ProviderDriver[] = [
  {
    harness: "pi",
    blocks: PROVIDER_BLOCKS,
    registry,
    cannot: {
      "harness-write-effort-map": "a later slice writes the card into pi's models.json; this slice records it only",
      "harness-write-cap-field": "a later slice writes the card into pi's models.json; this slice records it only",
    },
  },
  {
    harness: "opencode",
    blocks: PROVIDER_BLOCKS,
    registry,
    cannot: {
      "harness-write-effort-map":
        "a later slice writes the card into OpenCode's configuration; this slice records it only",
      "harness-write-cap-field":
        "a later slice writes the card into OpenCode's configuration; this slice records it only",
    },
  },
];
