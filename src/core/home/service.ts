import { readUnitGroups, type UnitGroup } from "../coordinator/unitGroups.js";
import { mapLimit } from "../mapLimit.js";
import { HOME_PRIVATE_READ_CONCURRENCY } from "../budgets.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Predicate } from "../authz/types.js";
import { matchesPredicate } from "../authz/predicate.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import {
  instanceFactsOf,
  unitFactsOf,
  unitFactsForPrivateRecipient,
  type InstanceFacts,
  type UnitFacts,
} from "../unitRuns.js";
import { currentUnitProgress } from "../coordinator/unitProgress.js";
import type { HomeWeek } from "./week.js";

export interface HomeInventory {
  get?(id: string): Promise<CoordinatorInstance | null>;
  listInstances(options: {
    limit: number;
    cursor?: string;
    order?: "key";
  }): Promise<{ items: CoordinatorInstance[]; cursor?: string; resumeCursor?: string }>;
  listUnits(instanceId: string): Promise<CoordinatorUnit[]>;
  listUnitsMany?(instanceIds: readonly string[]): Promise<UnitGroup[]>;
}

/** Attribution is supplied by the durable condition producer, never inferred
 * from who originally requested a unit or from a run's health. */
export type HomeConditionOwner =
  | { kind: "person"; id: string }
  | { kind: "automation"; class: string }
  | { kind: "external"; label: string }
  | { kind: "unknown" };
export interface HomeCondition {
  id: string;
  unitKey: string;
  revision: number;
  state: "open" | "resolved";
  owner: HomeConditionOwner;
  summary: string;
  nextAction?: string;
}

function validCondition(value: HomeCondition, unitKey: string): boolean {
  const text = (value: unknown, max = 1000): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max;
  if (
    !value ||
    value.unitKey !== unitKey ||
    !text(value.id, 256) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.state !== "open" && value.state !== "resolved") ||
    !text(value.summary) ||
    (value.nextAction !== undefined && !text(value.nextAction)) ||
    !value.owner
  )
    return false;
  switch (value.owner.kind) {
    case "person":
      return text(value.owner.id, 500);
    case "automation":
      return text(value.owner.class, 500);
    case "external":
      return text(value.owner.label, 500);
    case "unknown":
      return true;
    default:
      return false;
  }
}
export type HomeReadStatus = "complete" | "partial" | "unavailable";
export interface HomeUnit {
  unit: UnitFacts;
  instance: InstanceFacts;
  conditions: HomeCondition[];
  /** Current reader is the saved merge recipient or original work creator. */
  mergeCompletionForReader?: boolean;
  /** Pipeline-only current read classification; absent coverage stays unknown. */
  completion?: "complete" | "active" | "unknown";
  nextAction: { kind: "recorded"; text: string } | { kind: "unknown" };
}
export interface HomePipeline {
  instance: InstanceFacts;
  unresolved: number;
  needsYou: number;
  moving: number;
  waiting: number;
}
export type HomePipelineRead =
  | { status: "not_found" }
  | { status: "unavailable" }
  | {
      status: "complete" | "partial";
      organizationId: string;
      pipeline: HomePipeline & { units: HomeUnit[] };
      movingUnitKeys: string[];
    };
export interface HomeSnapshot {
  organizationId: string;
  status: HomeReadStatus;
  access: "authorized" | "filtered";
  needsYou: HomeUnit[];
  moving: HomeUnit[];
  waiting: HomeUnit[];
  pipelines: HomePipeline[];
}
export interface HomeHistory {
  organizationId: string;
  status: HomeReadStatus;
  units: HomeUnit[];
  cursor?: string;
  week?: HomeWeek;
  now?: number;
}
export interface HomePrivateReadGroup {
  instance: CoordinatorInstance;
  units: readonly CoordinatorUnit[];
}
export interface HomeReader {
  actorId: string;
  visibleTo: Predicate;
  /** Full current row permission, before the global selected-owner filter. */
  readableTo?: Predicate;
  attentionRecipients?: readonly string[];
  /** Trusted global view identity; changing Mine/person/everyone invalidates continuation. */
  scopeKey?: string;
  /** The authenticated host rechecks this exact private source and recipient. */
  readPrivateUnit?(instance: CoordinatorInstance, unit: CoordinatorUnit): Promise<boolean>;
  /** Metadata only: canonical groups read by this page, with full unit keys. */
  readPrivateUnits?(groups: readonly HomePrivateReadGroup[]): Promise<ReadonlyMap<string, boolean>>;
}
export interface HomeServiceDeps {
  /** Fixed by the installation wiring; no browser-selected tenant enters here. */
  organizationId: string;
  instances: HomeInventory;
  conditions?: {
    list(unitKey: string, canonicalUnit?: CoordinatorUnit, privateRead?: boolean): Promise<HomeCondition[]>;
  };
  liveUnitRuns?: (visibleTo: Predicate) => Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  maxPages?: number;
  maxUnits?: number;
  /** Installation-owned persistent key; never a browser value or a generated startup key. */
  historyCursorKey?: Uint8Array;
}
type ReadFailurePhase = "live_units" | "inventory_list" | "unit_list" | "unit_conditions" | "inventory_cursor";
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_UNITS = 20_000;
interface HistoryPosition {
  version: 1;
  inventory: string;
  instance: number;
  afterUnit?: string;
}

/** This list is deliberately narrow. A process ending, held review or spent
 * budget is not proof that its deliverable no longer needs attention. */
function completed(instance: CoordinatorInstance, unit: CoordinatorUnit, conditions: HomeCondition[]): boolean {
  if (conditions.length > 0 || unit.idle || unit.recovery || unit.recoveryHold) return false;
  if (unit.currentEffect?.phase === "active") return false;
  return (
    unit.ending?.kind === "merged" ||
    unit.ending?.kind === "already_landed" ||
    (unit.ending?.kind === "merge_ready" &&
      !!unit.mergeAttention?.resolved &&
      unit.pr?.number === unit.mergeAttention.pr.number &&
      unit.pr.url === unit.mergeAttention.pr.url &&
      unit.lastPush === unit.mergeAttention.headSha) ||
    (instance.stop !== undefined && unit.ending?.kind === "stopped")
  );
}

function visibleInstance(instance: CoordinatorInstance, unit: CoordinatorUnit): InstanceFacts {
  if (unit.workBrief === undefined) return instanceFactsOf(instance);
  return {
    id: instance.id,
    repo: instance.repo,
    ...(instance.base !== undefined ? { base: instance.base } : {}),
    createdAt: instance.createdAt,
  };
}

function currentMovement(
  row: HomeUnit,
  canonical: CoordinatorUnit,
  conditionsComplete: boolean,
  privateRead: boolean,
  live: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const runs = live.get(row.unit.unit);
  if (!runs?.size || canonical.idle || canonical.ending || canonical.recoveryHold) return false;
  const progress = currentUnitProgress(canonical);
  if (row.conditions.length === 0) return !progress;
  if (!conditionsComplete || row.conditions.length !== 1 || (canonical.workBrief && !privateRead)) return false;
  const condition = row.conditions[0]!;
  return (
    !!progress &&
    progress.waiting?.kind === "child" &&
    runs.has(progress.waiting.runId) &&
    condition.id === `${row.unit.unit}:progress` &&
    condition.state === "open" &&
    condition.revision === progress.revision &&
    condition.owner.kind === "automation" &&
    condition.owner.class === "Original worker"
  );
}

export function createHomeService(deps: HomeServiceDeps): {
  snapshot(input: HomeReader): Promise<HomeSnapshot>;
  pipeline(input: HomeReader, id: string): Promise<HomePipelineRead>;
  history(input: HomeReader, options?: { limit?: number; cursor?: string; week?: HomeWeek }): Promise<HomeHistory>;
} {
  if (!deps.organizationId.trim()) throw new Error("Home requires an installation organization");
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const maxUnits = deps.maxUnits ?? DEFAULT_MAX_UNITS;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(maxUnits) || maxUnits < 1)
    throw new Error("Home read bounds must be positive integers");
  const historyKey = deps.historyCursorKey ? Buffer.from(deps.historyCursorKey) : undefined;
  if (historyKey && historyKey.length !== 32) throw new Error("Home history cursor key must contain 32 bytes");
  const cursorContext = (input: HomeReader) =>
    Buffer.from(JSON.stringify([deps.organizationId, input.actorId, input.scopeKey ?? null]));
  function encodeCursor(position: HistoryPosition, input: HomeReader): string | undefined {
    if (!historyKey) return undefined;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", historyKey, iv);
    cipher.setAAD(cursorContext(input));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(position), "utf8"), cipher.final()]);
    return `home1.${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url")}`;
  }
  function decodeCursor(token: string, input: HomeReader): HistoryPosition {
    try {
      if (!historyKey || !/^home1\.[A-Za-z0-9_-]{40,2048}$/.test(token)) throw new Error();
      const bytes = Buffer.from(token.slice(6), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", historyKey, bytes.subarray(0, 12));
      decipher.setAAD(cursorContext(input));
      decipher.setAuthTag(bytes.subarray(-16));
      const value = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"),
      );
      if (
        !value ||
        value.version !== 1 ||
        typeof value.inventory !== "string" ||
        !value.inventory ||
        value.inventory.length > 200 ||
        !Number.isSafeInteger(value.instance) ||
        value.instance < 0 ||
        value.instance >= PAGE_SIZE ||
        (value.afterUnit !== undefined &&
          (typeof value.afterUnit !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value.afterUnit))) ||
        Object.keys(value).some((key) => !["version", "inventory", "instance", "afterUnit"].includes(key))
      )
        throw new Error();
      return value;
    } catch {
      try {
        console.warn(
          JSON.stringify({ event: "home.read.degraded", phase: "history_cursor", reason: "unavailable_or_invalid" }),
        );
      } catch {
        /* Diagnostics cannot change current read coverage. */
      }
      throw new Error("Home history cursor is invalid for this reader");
    }
  }

  async function privateReader(input: HomeReader, groups: readonly HomePrivateReadGroup[]): Promise<HomeReader> {
    if (!input.readPrivateUnits) return input;
    try {
      const reads = await input.readPrivateUnits(groups);
      return {
        ...input,
        readPrivateUnit: async (instance, unit) => {
          const key = `${instance.id}:${unit.unit}`;
          if (!reads.has(key)) throw new Error("Current private metadata proof is unavailable.");
          return reads.get(key)!;
        },
      };
    } catch {
      return {
        ...input,
        readPrivateUnit: async () => {
          throw new Error("Current private metadata proof is unavailable.");
        },
      };
    }
  }
  async function project(
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
    input: HomeReader,
    live: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  ) {
    let privateRead = false,
      privateAvailable = true;
    if (unit.workBrief && input.readPrivateUnit) {
      try {
        privateRead = await input.readPrivateUnit(instance, unit);
      } catch {
        privateAvailable = false;
      }
    }
    const facts = privateRead ? unitFactsForPrivateRecipient(unit) : unitFactsOf(unit);
    let conditions: HomeCondition[] = [];
    let conditionsComplete = privateAvailable;
    // The default fleet reader remains redacted. A source-proved recipient can
    // read the original question without lending its authority to the browser.
    if (deps.conditions && (unit.workBrief === undefined || privateRead)) {
      try {
        const readConditions = await deps.conditions.list(facts.unit, unit, privateRead);
        const counts = new Map<string, number>();
        for (const condition of readConditions) {
          if (!validCondition(condition, facts.unit)) {
            conditionsComplete = false;
            continue;
          }
          counts.set(condition.id, (counts.get(condition.id) ?? 0) + 1);
        }
        if ([...counts.values()].some((count) => count > 1)) conditionsComplete = false;
        if (conditionsComplete) conditions = readConditions.filter((condition) => condition.state === "open");
      } catch {
        conditionsComplete = false;
      }
    }
    const nextCondition =
      conditions.find(
        (condition) => condition.owner.kind === "person" && assignedToReader(input, condition.owner.id),
      ) ?? conditions[0];
    const row: HomeUnit = {
      unit: facts,
      instance: visibleInstance(instance, unit),
      conditions,
      ...(facts.mergeCompletion
        ? {
            mergeCompletionForReader:
              assignedToReader(input, unit.mergeAttention!.assignedTo) || assignedToReader(input, instance.userId),
          }
        : {}),
      nextAction: nextCondition?.nextAction
        ? { kind: "recorded", text: nextCondition.nextAction }
        : { kind: "unknown" },
    };
    const terminal = conditionsComplete && completed(instance, unit, conditions);
    const completion =
      !conditionsComplete || (unit.workBrief !== undefined && !privateRead)
        ? ("unknown" as const)
        : terminal
          ? ("complete" as const)
          : ("active" as const);
    return {
      row,
      conditionsComplete,
      terminal,
      completion,
      moving: currentMovement(row, unit, conditionsComplete, privateRead, live),
    };
  }

  function assignedToReader(input: HomeReader, id: string) {
    return (input.attentionRecipients ?? [input.actorId]).includes(id);
  }
  function readerOwns(input: HomeReader, instance: CoordinatorInstance) {
    return matchesPredicate(input.visibleTo, {
      userId: instance.userId,
      channelId: instance.channelId,
      repo: instance.repo,
      channelVisibility: "unknown",
    });
  }
  function inSelectedWork(input: HomeReader, instance: CoordinatorInstance, conditions: HomeCondition[]) {
    return (
      readerOwns(input, instance) ||
      conditions.some((condition) => condition.owner.kind === "person" && assignedToReader(input, condition.owner.id))
    );
  }
  async function read(input: HomeReader, includeLive = true) {
    const unresolved: HomeUnit[] = [];
    const ended: HomeUnit[] = [];
    const moving = new Set<string>();
    let status: HomeReadStatus = "complete";
    let live: ReadonlyMap<string, ReadonlySet<string>> = new Map();
    let failure: ReadFailurePhase | undefined;
    let failureKind: "type_error" | "syntax_error" | "error" | "non_error" | undefined;
    const fail = (phase?: ReadFailurePhase, kind?: typeof failureKind) => {
      status = "partial";
      if (!failure) {
        failure = phase;
        failureKind = kind;
      }
    };
    if (input.visibleTo.kind === "none") return { unresolved, ended, moving, status };
    if (includeLive && deps.liveUnitRuns) {
      try {
        live = await deps.liveUnitRuns(input.visibleTo);
      } catch {
        fail("live_units");
      }
    }
    const seenCursors = new Set<string>();
    const seenInstances = new Set<string>();
    const seenUnits = new Set<string>();
    let cursor: string | undefined;
    let rowsRead = 0;
    let terminalPage = false;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      let page: Awaited<ReturnType<HomeInventory["listInstances"]>>;
      try {
        page = await deps.instances.listInstances({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      } catch {
        fail("inventory_list");
        break;
      }
      const candidates = page.items.filter((instance) => {
        if (seenInstances.has(instance.id)) {
          fail("inventory_list");
          return false;
        }
        seenInstances.add(instance.id);
        return matchesPredicate(input.readableTo ?? input.visibleTo, {
          userId: instance.userId,
          channelId: instance.channelId,
          repo: instance.repo,
          channelVisibility: "unknown",
        });
      });
      let batched: Map<string, CoordinatorUnit[]> | undefined;
      if (candidates.length && deps.instances.listUnitsMany) {
        try {
          const ids = candidates.map((instance) => instance.id);
          batched = new Map(
            readUnitGroups(await deps.instances.listUnitsMany(ids), ids).map((group) => [
              group.instanceId,
              group.units,
            ]),
          );
        } catch (error) {
          fail(
            "unit_list",
            error instanceof TypeError
              ? "type_error"
              : error instanceof SyntaxError
                ? "syntax_error"
                : error instanceof Error
                  ? "error"
                  : "non_error",
          );
          batched = new Map();
        }
      }
      const groups = await mapLimit(candidates, HOME_PRIVATE_READ_CONCURRENCY, async (instance) => {
        try {
          return {
            instance,
            units: batched ? (batched.get(instance.id) ?? []) : await deps.instances.listUnits(instance.id),
          };
        } catch {
          fail("unit_list");
          return { instance, units: [] };
        }
      });
      const pending: { instance: CoordinatorInstance; unit: CoordinatorUnit }[] = [];
      for (const { instance, units } of groups) {
        for (const unit of units) {
          if (rowsRead >= maxUnits) {
            fail();
            break;
          }
          rowsRead++;
          if (unit.instanceId !== instance.id) {
            fail("unit_list");
            continue;
          }
          const facts = unitFactsOf(unit);
          if (seenUnits.has(facts.unit)) {
            fail("unit_list");
            continue;
          }
          seenUnits.add(facts.unit);
          pending.push({ instance, unit });
        }
      }
      // Only selected bounded rows need private proof, but the canonical group
      // keeps duplicate unit detection and original ownership intact.
      const bounded = new Set(pending.filter(({ unit }) => !!unit.workBrief).map(({ unit }) => unitFactsOf(unit).unit));
      const reader = await privateReader(
        input,
        groups
          .map((group) => ({ ...group, units: group.units.filter((unit) => bounded.has(unitFactsOf(unit).unit)) }))
          .filter((group) => group.units.length),
      );
      const projected = await mapLimit(pending, HOME_PRIVATE_READ_CONCURRENCY, async ({ instance, unit }) => ({
        instance,
        value: await project(instance, unit, reader, live),
      }));
      for (const { instance, value } of projected) {
        if (!value.conditionsComplete) fail("unit_conditions");
        if (!inSelectedWork(input, instance, value.row.conditions)) continue;
        (value.terminal ? ended : unresolved).push(value.row);
        if (value.moving) moving.add(value.row.unit.unit);
      }
      if (rowsRead >= maxUnits && page.cursor !== undefined) {
        fail();
        break;
      }
      if (page.cursor === undefined) {
        terminalPage = true;
        break;
      }
      if (!page.cursor || seenCursors.has(page.cursor)) {
        fail("inventory_cursor");
        break;
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    if (!terminalPage) fail();
    if (status !== "complete" && unresolved.length + ended.length === 0) status = "unavailable";
    if (failure) {
      try {
        console.warn(
          JSON.stringify({
            event: "home.read.degraded",
            phase: failure,
            reason: "unavailable_or_invalid",
            ...(failureKind ? { errorKind: failureKind } : {}),
          }),
        );
      } catch {
        /* Diagnostics cannot change current read coverage. */
      }
    }
    return { unresolved, ended, moving, status };
  }

  return {
    async pipeline(input, id) {
      if (input.visibleTo.kind === "none") return { status: "not_found" };
      let instance: CoordinatorInstance | null | undefined;
      if (deps.instances.get) {
        try {
          instance = await deps.instances.get(id);
        } catch {
          try {
            console.warn(
              JSON.stringify({
                event: "home.read.degraded",
                phase: "inventory_list",
                reason: "unavailable_or_invalid",
              }),
            );
          } catch {
            /* Diagnostics cannot change current read coverage. */
          }
          return { status: "unavailable" };
        }
        if (instance === null) return { status: "not_found" };
      } else {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
          let page: Awaited<ReturnType<HomeInventory["listInstances"]>>;
          try {
            page = await deps.instances.listInstances({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
          } catch {
            try {
              console.warn(
                JSON.stringify({
                  event: "home.read.degraded",
                  phase: "inventory_list",
                  reason: "unavailable_or_invalid",
                }),
              );
            } catch {
              /* Diagnostics cannot change current read coverage. */
            }
            return { status: "unavailable" };
          }
          instance = page.items.find((row) => row.id === id);
          if (instance) break;
          if (page.cursor === undefined) return { status: "not_found" };
          if (!page.cursor || seen.has(page.cursor)) {
            try {
              console.warn(
                JSON.stringify({
                  event: "home.read.degraded",
                  phase: "inventory_cursor",
                  reason: "unavailable_or_invalid",
                }),
              );
            } catch {
              /* Diagnostics cannot change current read coverage. */
            }
            return { status: "unavailable" };
          }
          seen.add(page.cursor);
          cursor = page.cursor;
        }
      }
      if (!instance || instance.id !== id) return { status: "unavailable" };
      if (
        !matchesPredicate(input.readableTo ?? input.visibleTo, {
          userId: instance.userId,
          channelId: instance.channelId,
          repo: instance.repo,
          channelVisibility: "unknown",
        })
      )
        return { status: "not_found" };
      let units: CoordinatorUnit[];
      try {
        units = await deps.instances.listUnits(instance.id);
      } catch {
        try {
          console.warn(
            JSON.stringify({ event: "home.read.degraded", phase: "unit_list", reason: "unavailable_or_invalid" }),
          );
        } catch {
          /* Diagnostics cannot change current read coverage. */
        }
        return { status: "unavailable" };
      }
      input = await privateReader(input, [{ instance, units: units.slice(0, maxUnits) }]);
      let status: "complete" | "partial" = "complete";
      let failure: ReadFailurePhase | undefined;
      let live: ReadonlyMap<string, ReadonlySet<string>> = new Map();
      if (deps.liveUnitRuns) {
        try {
          live = await deps.liveUnitRuns(input.visibleTo);
        } catch {
          failure ??= "live_units";
          status = "partial";
        }
      }
      const privateUnit = units.find((unit) => unit.workBrief !== undefined);
      const shownInstance = privateUnit ? visibleInstance(instance, privateUnit) : instanceFactsOf(instance);
      const pipeline: HomePipeline & { units: HomeUnit[] } = {
        instance: shownInstance,
        unresolved: 0,
        needsYou: 0,
        moving: 0,
        waiting: 0,
        units: [],
      };
      const movingUnitKeys: string[] = [];
      const seenUnits = new Set<string>();
      let scanned = 0;
      for (const unit of units) {
        if (scanned++ >= maxUnits) {
          status = "partial";
          break;
        }
        if (unit.instanceId !== instance.id) {
          failure ??= "unit_list";
          status = "partial";
          continue;
        }
        let projected: Awaited<ReturnType<typeof project>>;
        try {
          projected = await project(instance, unit, input, live);
        } catch {
          failure ??= "unit_conditions";
          status = "partial";
          continue;
        }
        const key = projected.row.unit.unit;
        if (seenUnits.has(key)) {
          failure ??= "unit_list";
          status = "partial";
          continue;
        }
        seenUnits.add(key);
        if (!inSelectedWork(input, instance, projected.row.conditions)) continue;
        // A private worker's provenance stays redacted throughout this entity projection.
        projected.row.instance = shownInstance;
        pipeline.units.push({ ...projected.row, completion: projected.completion });
        if (!projected.conditionsComplete) {
          failure ??= "unit_conditions";
          status = "partial";
        }
        if (projected.completion === "complete") continue;
        pipeline.unresolved++;
        const moving = projected.moving;
        if (moving) movingUnitKeys.push(key);
        const group = projected.row.conditions.some(
          (condition) => condition.owner.kind === "person" && assignedToReader(input, condition.owner.id),
        )
          ? "needsYou"
          : moving
            ? "moving"
            : "waiting";
        pipeline[group]++;
      }
      if (failure) {
        try {
          console.warn(
            JSON.stringify({ event: "home.read.degraded", phase: failure, reason: "unavailable_or_invalid" }),
          );
        } catch {
          /* Diagnostics cannot change current read coverage. */
        }
      }
      if (!pipeline.units.length && !readerOwns(input, instance)) return { status: "not_found" };
      return { status, organizationId: deps.organizationId, pipeline, movingUnitKeys };
    },
    async snapshot(input) {
      const rows = await read(input);
      const result: HomeSnapshot = {
        organizationId: deps.organizationId,
        status: rows.status,
        access: input.visibleTo.kind === "all" ? "authorized" : "filtered",
        needsYou: [],
        moving: [],
        waiting: [],
        pipelines: [],
      };
      const pipelines = new Map<string, HomePipeline>();
      for (const row of rows.unresolved) {
        const group = row.conditions.some(
          (condition) => condition.owner.kind === "person" && assignedToReader(input, condition.owner.id),
        )
          ? "needsYou"
          : rows.moving.has(row.unit.unit)
            ? "moving"
            : "waiting";
        result[group].push(row);
        const pipeline = pipelines.get(row.instance.id) ?? {
          instance: row.instance,
          unresolved: 0,
          needsYou: 0,
          moving: 0,
          waiting: 0,
        };
        pipeline.unresolved++;
        pipeline[group]++;
        pipelines.set(row.instance.id, pipeline);
      }
      result.pipelines = [...pipelines.values()];
      return result;
    },
    async history(input, options = {}) {
      const limit = options.limit ?? PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE)
        throw new Error("Home history limit must be 1–100");
      if (options.week) {
        const week = options.week;
        const aad = Buffer.concat([
          cursorContext(input),
          Buffer.from(JSON.stringify([week.startDate, week.timeZone, week.start, week.end])),
        ]);
        let after: { at: number; key: string } | undefined;
        if (options.cursor !== undefined) {
          try {
            if (!historyKey || !/^homew1\.[A-Za-z0-9_-]{40,2048}$/.test(options.cursor)) throw new Error();
            const bytes = Buffer.from(options.cursor.slice(7), "base64url");
            const decipher = createDecipheriv("aes-256-gcm", historyKey, bytes.subarray(0, 12));
            decipher.setAAD(aad);
            decipher.setAuthTag(bytes.subarray(-16));
            const position: unknown = JSON.parse(
              Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"),
            );
            if (!position || typeof position !== "object" || Object.keys(position).sort().join(",") !== "at,key")
              throw new Error();
            const value = position as { at: unknown; key: unknown };
            if (
              !Number.isSafeInteger(value.at) ||
              Number(value.at) < week.start ||
              Number(value.at) >= week.end ||
              typeof value.key !== "string" ||
              value.key.length > 256
            )
              throw new Error();
            after = value as { at: number; key: string };
          } catch {
            try {
              console.warn(
                JSON.stringify({
                  event: "home.read.degraded",
                  phase: "history_cursor",
                  reason: "unavailable_or_invalid",
                }),
              );
            } catch {
              /* Diagnostics cannot change current read coverage. */
            }
            throw new Error("Home history cursor is invalid for this reader and week");
          }
        }
        // Sort the full bounded census before paging. Inventory-key order says
        // nothing about completion time; incomplete reads remain explicit.
        const census = await read(input, false);
        const rows = census.ended
          .filter((row) => {
            const at = row.unit.mergeCompletion?.at ?? row.unit.ending?.at;
            return (
              at !== undefined &&
              Number.isSafeInteger(at) &&
              at >= week.start &&
              at < week.end &&
              (!after || at < after.at || (at === after.at && row.unit.unit < after.key))
            );
          })
          .sort(
            (a, b) =>
              (b.unit.mergeCompletion?.at ?? b.unit.ending!.at) - (a.unit.mergeCompletion?.at ?? a.unit.ending!.at) ||
              (a.unit.unit < b.unit.unit ? 1 : a.unit.unit > b.unit.unit ? -1 : 0),
          );
        const result: HomeHistory = {
          organizationId: deps.organizationId,
          status: census.status,
          units: rows.slice(0, limit),
          week,
        };
        if (rows.length > limit) {
          if (!historyKey) result.status = "partial";
          else {
            const last = result.units.at(-1)!;
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", historyKey, iv);
            cipher.setAAD(aad);
            const encoded = Buffer.concat([
              cipher.update(
                JSON.stringify({ at: last.unit.mergeCompletion?.at ?? last.unit.ending!.at, key: last.unit.unit }),
                "utf8",
              ),
              cipher.final(),
            ]);
            result.cursor = `homew1.${Buffer.concat([iv, encoded, cipher.getAuthTag()]).toString("base64url")}`;
          }
        }
        return result;
      }
      const result: HomeHistory = { organizationId: deps.organizationId, status: "complete", units: [] };
      if (input.visibleTo.kind === "none") return result;
      const start = options.cursor === undefined ? undefined : decodeCursor(options.cursor, input);
      let inventory = start?.inventory;
      let instanceOffset = start?.instance ?? 0;
      let afterUnit = start?.afterUnit;
      let scanned = 0;
      let inventoryAvailable = false;
      const seenCursors = new Set<string>();
      let failure: ReadFailurePhase | undefined;
      const finish = (position?: HistoryPosition, bounded = false): HomeHistory => {
        if (failure) {
          try {
            console.warn(
              JSON.stringify({ event: "home.read.degraded", phase: failure, reason: "unavailable_or_invalid" }),
            );
          } catch {
            /* Diagnostics cannot change current read coverage. */
          }
        }
        if (bounded) result.status = inventoryAvailable ? "partial" : "unavailable";
        if (position) {
          const token = encodeCursor(position, input);
          if (token) result.cursor = token;
          else result.status = "partial";
        }
        return result;
      };
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        let page: Awaited<ReturnType<HomeInventory["listInstances"]>>;
        try {
          page = await deps.instances.listInstances({
            limit: PAGE_SIZE,
            order: "key",
            ...(inventory ? { cursor: inventory } : {}),
          });
        } catch {
          failure ??= "inventory_list";
          return finish(
            inventory
              ? { version: 1, inventory, instance: instanceOffset, ...(afterUnit ? { afterUnit } : {}) }
              : undefined,
            true,
          );
        }
        inventoryAvailable = true;
        const resume = page.resumeCursor ?? inventory;
        for (let index = instanceOffset; index < page.items.length; index++) {
          const instance = page.items[index]!;
          const position = () =>
            resume
              ? { version: 1 as const, inventory: resume, instance: index, ...(afterUnit ? { afterUnit } : {}) }
              : undefined;
          if (
            !matchesPredicate(input.visibleTo, {
              userId: instance.userId,
              channelId: instance.channelId,
              repo: instance.repo,
              channelVisibility: "unknown",
            })
          ) {
            afterUnit = undefined;
            continue;
          }
          let units: CoordinatorUnit[];
          try {
            units = [...(await deps.instances.listUnits(instance.id))];
          } catch {
            failure ??= "unit_list";
            return finish(position(), true);
          }
          units.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
          units = units.filter((unit) => afterUnit === undefined || unit.unit > afterUnit);
          for (let offset = 0; offset < units.length;) {
            if (scanned >= maxUnits) return finish(position(), true);
            // A terminal lookahead is needed to retain the first unreturned row
            // in the cursor. Do not prove the skipped prefix or later rows that
            // this page cannot scan, even when the retained pipeline is large.
            const batch = units.slice(offset, offset + Math.min(maxUnits - scanned, limit - result.units.length + 1));
            const reader = await privateReader(input, [{ instance, units: batch }]);
            for (const unit of batch) {
              scanned++;
              if (unit.instanceId !== instance.id) {
                afterUnit = unit.unit;
                failure ??= "unit_list";
                result.status = "partial";
                continue;
              }
              const projected = await project(instance, unit, reader);
              if (!projected.conditionsComplete) {
                failure ??= "unit_conditions";
                result.status = "partial";
              }
              if (projected.terminal && result.units.length >= limit) {
                const next = position();
                if (!next) result.status = "partial";
                return finish(next);
              }
              afterUnit = unit.unit;
              if (projected.terminal) result.units.push(projected.row);
            }
            offset += batch.length;
          }
          afterUnit = undefined;
        }
        if (page.cursor === undefined) return finish();
        if (!page.cursor || page.cursor === resume || seenCursors.has(page.cursor)) {
          failure ??= "inventory_cursor";
          return finish(undefined, true);
        }
        seenCursors.add(page.cursor);
        inventory = page.cursor;
        instanceOffset = 0;
        if (pageNumber + 1 === maxPages) return finish({ version: 1, inventory, instance: 0 }, true);
      }
      return finish(undefined, true);
    },
  };
}
