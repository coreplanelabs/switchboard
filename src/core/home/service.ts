import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Predicate } from "../authz/types.js";
import { matchesPredicate } from "../authz/predicate.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import { instanceFactsOf, unitFactsOf, type InstanceFacts, type UnitFacts } from "../unitRuns.js";

export interface HomeInventory {
  listInstances(options: {
    limit: number;
    cursor?: string;
    order?: "key";
  }): Promise<{ items: CoordinatorInstance[]; cursor?: string; resumeCursor?: string }>;
  listUnits(instanceId: string): Promise<CoordinatorUnit[]>;
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
  nextAction: string;
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
    !text(value.nextAction) ||
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
  nextAction: { kind: "recorded"; text: string } | { kind: "unknown" };
}
export interface HomePipeline {
  instance: InstanceFacts;
  unresolved: number;
  needsYou: number;
  moving: number;
  waiting: number;
}
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
}
export interface HomeReader {
  actorId: string;
  visibleTo: Predicate;
}
export interface HomeServiceDeps {
  /** Fixed by the installation wiring; no browser-selected tenant enters here. */
  organizationId: string;
  instances: HomeInventory;
  conditions?: { list(unitKey: string): Promise<HomeCondition[]> };
  liveUnitKeys?: (visibleTo: Predicate) => Promise<ReadonlySet<string>>;
  maxPages?: number;
  maxUnits?: number;
  /** Installation-owned persistent key; never a browser value or a generated startup key. */
  historyCursorKey?: Uint8Array;
}
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

export function createHomeService(deps: HomeServiceDeps): {
  snapshot(input: HomeReader): Promise<HomeSnapshot>;
  history(input: HomeReader, options?: { limit?: number; cursor?: string }): Promise<HomeHistory>;
} {
  if (!deps.organizationId.trim()) throw new Error("Home requires an installation organization");
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const maxUnits = deps.maxUnits ?? DEFAULT_MAX_UNITS;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(maxUnits) || maxUnits < 1)
    throw new Error("Home read bounds must be positive integers");
  const historyKey = deps.historyCursorKey ? Buffer.from(deps.historyCursorKey) : undefined;
  if (historyKey && historyKey.length !== 32) throw new Error("Home history cursor key must contain 32 bytes");
  const cursorContext = (input: HomeReader) => Buffer.from(JSON.stringify([deps.organizationId, input.actorId]));
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
      throw new Error("Home history cursor is invalid for this reader");
    }
  }

  async function project(instance: CoordinatorInstance, unit: CoordinatorUnit, input: HomeReader) {
    const facts = unitFactsOf(unit);
    let conditions: HomeCondition[] = [];
    let conditionsComplete = true;
    // Private worker text remains in its original thread, never in fleet conditions.
    if (deps.conditions && unit.workBrief === undefined) {
      try {
        const readConditions = await deps.conditions.list(facts.unit);
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
      conditions.find((condition) => condition.owner.kind === "person" && condition.owner.id === input.actorId) ??
      conditions[0];
    const row: HomeUnit = {
      unit: facts,
      instance: visibleInstance(instance, unit),
      conditions,
      nextAction: nextCondition ? { kind: "recorded", text: nextCondition.nextAction } : { kind: "unknown" },
    };
    return { row, conditionsComplete, terminal: conditionsComplete && completed(instance, unit, conditions) };
  }

  async function read(input: HomeReader) {
    const unresolved: HomeUnit[] = [];
    const ended: HomeUnit[] = [];
    let status: HomeReadStatus = "complete";
    let live: ReadonlySet<string> = new Set();
    const fail = () => {
      status = "partial";
    };
    if (input.visibleTo.kind === "none") return { unresolved, ended, live, status };
    if (deps.liveUnitKeys) {
      try {
        live = await deps.liveUnitKeys(input.visibleTo);
      } catch {
        fail();
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
        fail();
        break;
      }
      for (const instance of page.items) {
        if (seenInstances.has(instance.id)) {
          fail();
          continue;
        }
        seenInstances.add(instance.id);
        if (
          !matchesPredicate(input.visibleTo, {
            userId: instance.userId,
            channelId: instance.channelId,
            repo: instance.repo,
            channelVisibility: "unknown",
          })
        )
          continue;
        let units: CoordinatorUnit[];
        try {
          units = await deps.instances.listUnits(instance.id);
        } catch {
          fail();
          continue;
        }
        for (const unit of units) {
          if (rowsRead >= maxUnits) {
            fail();
            break;
          }
          rowsRead++;
          if (unit.instanceId !== instance.id) {
            fail();
            continue;
          }
          const facts = unitFactsOf(unit);
          if (seenUnits.has(facts.unit)) {
            fail();
            continue;
          }
          seenUnits.add(facts.unit);
          const projected = await project(instance, unit, input);
          if (!projected.conditionsComplete) fail();
          (projected.terminal ? ended : unresolved).push(projected.row);
        }
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
        fail();
        break;
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    if (!terminalPage) fail();
    if (status !== "complete" && unresolved.length + ended.length === 0) status = "unavailable";
    return { unresolved, ended, live, status };
  }

  return {
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
          (condition) => condition.owner.kind === "person" && condition.owner.id === input.actorId,
        )
          ? "needsYou"
          : rows.live.has(row.unit.unit)
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
      const result: HomeHistory = { organizationId: deps.organizationId, status: "complete", units: [] };
      if (input.visibleTo.kind === "none") return result;
      const start = options.cursor === undefined ? undefined : decodeCursor(options.cursor, input);
      let inventory = start?.inventory;
      let instanceOffset = start?.instance ?? 0;
      let afterUnit = start?.afterUnit;
      let scanned = 0;
      let inventoryAvailable = false;
      const seenCursors = new Set<string>();
      const finish = (position?: HistoryPosition, bounded = false): HomeHistory => {
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
            return finish(position(), true);
          }
          units.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
          for (const unit of units) {
            if (afterUnit !== undefined && unit.unit <= afterUnit) continue;
            if (scanned >= maxUnits) return finish(position(), true);
            scanned++;
            if (unit.instanceId !== instance.id) {
              afterUnit = unit.unit;
              result.status = "partial";
              continue;
            }
            const projected = await project(instance, unit, input);
            if (!projected.conditionsComplete) result.status = "partial";
            if (projected.terminal && result.units.length >= limit) {
              const next = position();
              if (!next) result.status = "partial";
              return finish(next);
            }
            afterUnit = unit.unit;
            if (projected.terminal) result.units.push(projected.row);
          }
          afterUnit = undefined;
        }
        if (page.cursor === undefined) return finish();
        if (!page.cursor || page.cursor === resume || seenCursors.has(page.cursor)) return finish(undefined, true);
        seenCursors.add(page.cursor);
        inventory = page.cursor;
        instanceOffset = 0;
        if (pageNumber + 1 === maxPages) return finish({ version: 1, inventory, instance: 0 }, true);
      }
      return finish(undefined, true);
    },
  };
}
