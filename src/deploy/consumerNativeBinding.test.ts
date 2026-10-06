import { describe, expect, it } from "vitest";
import { baseConfigDocument } from "../configDocument.js";
import {
  configSourceObservation,
  originalConfigSourceObservation,
  eligibleConfigPublicationConsumer,
  confirmConsumerConfigPublication,
  pushConfigForServedConsumer,
  type PreparedConfigPublication,
} from "./run.js";
import type { ContainerInstance, Read } from "./sandboxLiveGate.js";

const commit = "a".repeat(40);
const slot = `base-${commit}`;
const document = baseConfigDocument("# private input\n", "source", new Date(0));
const application = { value: { version: 18, image: "registry.example/actual" } };
const singleton: ContainerInstance = { name: "singleton", state: "running", version: 18 };
const health = (key: string, version = 7) => ({
  status: 200,
  body: {
    ok: true,
    draining: false,
    loadedBase: { schema: 1, source: { kind: "state", key, version }, sha256: document.sha256, process: { commit } },
  },
});
const original = (key: string) => ({
  key,
  version: 7,
  sha256: document.sha256,
  observedProcessCommit: commit,
  application: application.value,
});
const negatives: [string, Read<ContainerInstance[]>][] = [
  [
    "stopped singleton and foreign running row",
    {
      value: [
        { ...singleton, state: "stopped" },
        { ...singleton, name: "other" },
      ],
    },
  ],
  ["foreign running row only", { value: [{ ...singleton, name: "other" }] }],
  ["unnamed running row", { value: [{ ...singleton, name: null }] }],
  ["blank native name", { value: [singleton, { ...singleton, name: " ", state: "stopped" }] }],
  [
    "duplicate non-serving identities",
    {
      value: [
        singleton,
        { ...singleton, name: "other", state: "stopped" },
        { ...singleton, name: "other", state: "stopped" },
      ],
    },
  ],
  ["duplicate singleton rows", { value: [singleton, { ...singleton, state: "stopped" }] }],
  ["unknown competing state", { value: [singleton, { ...singleton, name: "other", state: "unknown" }] }],
  ["missing singleton version", { value: [{ ...singleton, version: null }] }],
  ["stale singleton version", { value: [{ ...singleton, version: 17 }] }],
  ["unavailable inventory", { error: "unavailable" }],
];

describe("consumer native singleton binding", () => {
  it.each(negatives)("%s cannot authorize current or original source or publication", async (_name, inventory) => {
    for (const key of ["base", slot]) {
      expect(configSourceObservation(health(key), application, inventory).ok).toBe(false);
      expect(originalConfigSourceObservation(original(key), application, inventory)).toBe(false);
    }
    expect(eligibleConfigPublicationConsumer({ commit }, health(slot), application, inventory).ok).toBe(false);
    let stateReadsOrWrites = 0;
    expect(
      await pushConfigForServedConsumer(
        { ok: true, text: document.yaml, how: "candidate" },
        {
          stateWorkerUrl: "https://state.example",
          key: "base",
          env: { MEMORY_TOKEN: "test" },
          fetch: async () => {
            stateReadsOrWrites++;
            return Response.json({});
          },
        },
        { commit },
        health(slot),
        application,
        inventory,
      ),
    ).toMatchObject({ ok: false, write: "not-written" });
    expect(stateReadsOrWrites).toBe(0);
    const publication: PreparedConfigPublication = {
      stateWorkerUrl: "https://state.example",
      key: slot,
      how: "candidate",
      snapshotKey: "private",
      prior: { version: 7, document },
      candidate: document,
      inputSource: { key: "base", version: 7, document },
    };
    expect(
      await confirmConsumerConfigPublication(
        publication,
        { commit },
        health(slot, 8),
        application,
        inventory,
        async () => ({ ok: true, version: 7, document }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("the unique running singleton retains both source paths and eligible publication", () => {
    const inventory = { value: [singleton] };
    for (const key of ["base", slot]) {
      expect(configSourceObservation(health(key), application, inventory).ok).toBe(true);
      expect(originalConfigSourceObservation(original(key), application, inventory)).toBe(true);
    }
    expect(eligibleConfigPublicationConsumer({ commit }, health(slot), application, inventory).ok).toBe(true);
  });

  it("failed native app reads and image disagreement retain their refusal", () => {
    const inventory = { value: [singleton] };
    expect(configSourceObservation(health("base"), { error: "unknown app" }, inventory).ok).toBe(false);
    expect(originalConfigSourceObservation(original("base"), { error: "unknown app" }, inventory)).toBe(false);
    expect(eligibleConfigPublicationConsumer({ commit }, health(slot), { error: "unknown app" }, inventory).ok).toBe(
      false,
    );
    expect(
      eligibleConfigPublicationConsumer({ commit }, health(slot), application, inventory, "registry.example/other").ok,
    ).toBe(false);
  });
});
