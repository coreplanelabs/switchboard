import { describe, expect, it } from "vitest";
import { baseConfigDocument } from "../configDocument.js";
import {
  pushConfigForServedConsumer,
  confirmConsumerConfigPublication,
  type PreparedConfigPublication,
} from "./run.js";
const commit = "a".repeat(40);
const slot = `base-${commit}`;
const original = baseConfigDocument("# legacy original\n", "old", new Date(0));
const current = baseConfigDocument("# own current\n", "current", new Date(1));
const candidate = { ok: true as const, text: "# own candidate\n", how: "config from candidate" };
const health = {
  status: 200,
  body: {
    ok: true,
    draining: false,
    loadedBase: {
      schema: 1,
      source: { kind: "state", key: slot, version: 3 },
      sha256: current.sha256,
      process: { commit },
    },
  },
};
const app = { value: { version: 4, image: "registry.example/actual" } };
const instances = { value: [{ name: "singleton", state: "running", version: 4 }] };
function backend() {
  const rows = new Map<string, { document: unknown; version: number }>([
    ["base", { document: original, version: 2 }],
    [slot, { document: current, version: 3 }],
  ]);
  const writes: string[] = [];
  const keys: string[] = [];
  let race = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    const key = body.key;
    const row = rows.get(key) ?? { document: null, version: 0 };
    if (String(input).endsWith("/config/get")) {
      keys.push(key);
      return Response.json(row);
    }
    writes.push(key);
    const source = body.sourcePrecondition;
    if (row.version !== body.expectedVersion || (source && rows.get(source.key)?.version !== source.version))
      return Response.json({ error: "version conflict", version: row.version }, { status: 409 });
    rows.set(key, { document: body.document, version: row.version + 1 });
    if (race && key.startsWith("deploy-base-")) rows.set(slot, { document: original, version: 4 });
    return Response.json({ ok: true, version: row.version + 1, ...(source ? { sourcePrecondition: source } : {}) });
  };
  return {
    rows,
    writes,
    keys,
    target: {
      stateWorkerUrl: "https://state.example",
      key: "base",
      env: { MEMORY_TOKEN: "test" },
      fetch: fetchImpl,
      now: () => new Date(2),
    },
    race: () => {
      race = true;
    },
  };
}
describe("direct config targets the actual consumer", () => {
  it("publishes only the eligible owned slot while retaining the legacy base", async () => {
    const b = backend();
    expect(await pushConfigForServedConsumer(candidate, b.target, { commit }, health, app, instances)).toMatchObject({
      ok: true,
      version: 4,
    });
    expect(b.rows.get("base")).toEqual({ document: original, version: 2 });
    expect(b.writes.filter((key) => !key.startsWith("deploy-base-"))).toEqual([slot]);
    expect(b.keys.filter((key) => !key.startsWith("deploy-base-"))).toEqual([slot]);
  });
  it("a mismatched publishing parser reads or writes no config", async () => {
    const b = backend();
    expect(
      await pushConfigForServedConsumer(candidate, b.target, { commit: "b".repeat(40) }, health, app, instances),
    ).toMatchObject({ ok: false, write: "not-written" });
    expect(b.keys).toEqual([]);
    expect(b.writes).toEqual([]);
  });
  it("a successor update during preparation survives both source and target comparisons", async () => {
    const b = backend();
    b.race();
    expect(await pushConfigForServedConsumer(candidate, b.target, { commit }, health, app, instances)).toMatchObject({
      ok: false,
      write: "not-written",
    });
    expect(b.rows.get(slot)).toEqual({ document: original, version: 4 });
    expect(b.rows.get("base")).toEqual({ document: original, version: 2 });
  });
});

describe("consumer publication final source readback", () => {
  const next = baseConfigDocument(candidate.text, "candidate", new Date(2));
  const active = {
    ...health,
    body: {
      ...health.body,
      loadedBase: { ...health.body.loadedBase, source: { kind: "state", key: slot, version: 1 }, sha256: next.sha256 },
    },
  };
  const publication: PreparedConfigPublication = {
    stateWorkerUrl: "https://state.example",
    key: slot,
    how: "candidate",
    snapshotKey: "snapshot",
    prior: { version: 0, document: null },
    candidate: next,
    inputSource: { key: "base", version: 2, document: original },
  };
  it("requires the exact new slot while the separate legacy source is still current", async () => {
    expect(
      await confirmConsumerConfigPublication(publication, { commit }, active, app, instances, async () => ({
        ok: true,
        version: 2,
        document: original,
      })),
    ).toEqual({ ok: true });
  });
  it("a late legacy write after slot ACK declines acceptance without restoring", async () => {
    let reads = 0;
    expect(
      await confirmConsumerConfigPublication(publication, { commit }, active, app, instances, async () => {
        reads++;
        return { ok: true, version: 3, document: current };
      }),
    ).toMatchObject({ ok: false });
    expect(reads).toBe(1);
  });
  it("a same-consumer update expects its acknowledged new version, not its previous source version", async () => {
    const owned = {
      ...publication,
      prior: { version: 3, document: current },
      inputSource: { key: slot, version: 3, document: current },
    };
    const serving = {
      ...active,
      body: {
        ...active.body,
        loadedBase: { ...active.body.loadedBase, source: { kind: "state", key: slot, version: 4 } },
      },
    };
    expect(
      await confirmConsumerConfigPublication(owned, { commit }, serving, app, instances, async () => ({
        ok: true,
        version: 4,
        document: next,
      })),
    ).toEqual({ ok: true });
  });
});
