import { describe, expect, it } from "vitest";
import {
  consumerConfigKey,
  consumerConfigLocation,
  IMAGE_CONSUMER_BUILD_FILE,
  parseConfigConsumerIdentity,
  readImageConfigConsumerIdentity,
  servedConfigConsumer,
} from "./configConsumer.js";
const commit = "a".repeat(40);
const identity = { commit };

describe("image-owned config identity", () => {
  it("a complete clean artifact chooses its own slot even while another image is desired", () => {
    const result = readImageConfigConsumerIdentity({
      read: (path) => {
        expect(path).toBe(IMAGE_CONSUMER_BUILD_FILE);
        return JSON.stringify({ commit, desiredCommit: "b".repeat(40) });
      },
      stat: () => ({ uid: 0, mode: 0o444, isSymbolicLink: () => false }),
    });
    if (!result.ok) throw new Error(result.problem);
    expect(consumerConfigLocation("state://base", result.identity)).toBe(`state://base-${commit}`);
    expect(Object.isFrozen(result.identity)).toBe(true);
  });
  it.each([
    undefined,
    "{}",
    "null",
    "[]",
    "not JSON",
    ...["unknown", "", "a".repeat(7), `${commit}-dirty`, "b".repeat(41)].map((commit) => JSON.stringify({ commit })),
  ])("missing or ineligible artifact %s cannot choose a slot", (text) => {
    expect(parseConfigConsumerIdentity(text)).toMatchObject({ ok: false });
  });
  it.each([
    { uid: 1001, mode: 0o444, link: false },
    { uid: 0, mode: 0o644, link: false },
    { uid: 0, mode: 0o444, link: true },
  ])("a mutable or redirected artifact is refused: %j", ({ uid, mode, link }) => {
    expect(
      readImageConfigConsumerIdentity({
        read: () => JSON.stringify(identity),
        stat: () => ({ uid, mode, isSymbolicLink: () => link }),
      }),
    ).toMatchObject({ ok: false });
  });
  it("a writable directory is refused even when the file itself is read-only", () => {
    expect(
      readImageConfigConsumerIdentity({
        read: () => JSON.stringify(identity),
        stat: (path) => ({
          uid: 0,
          mode: path === IMAGE_CONSUMER_BUILD_FILE ? 0o444 : 0o755,
          isSymbolicLink: () => false,
        }),
      }),
    ).toMatchObject({ ok: false });
  });
  it("a foreign slot cannot fall back to the global document", () => {
    expect(() => consumerConfigLocation(`state://base-${"b".repeat(40)}`, identity)).toThrow("does not belong");
    expect(() => consumerConfigLocation("state://staging", identity)).toThrow("does not belong");
    expect(consumerConfigKey(identity)).toBe(`base-${commit}`);
  });
  it("file mode retains the configured file without needing an image artifact", () => {
    expect(consumerConfigLocation("config/config.yaml", identity)).toBe("config/config.yaml");
  });
});

describe("serving config eligibility", () => {
  const health = () => ({
    ok: true,
    draining: false,
    build: { commit: "b".repeat(40) },
    loadedBase: {
      schema: 1,
      source: { kind: "state", key: `base-${commit}`, version: 3 },
      sha256: "c".repeat(64),
      process: { commit },
    },
  });
  it("uses the owned slot's immutable process identity while desired/display identity differs", () => {
    expect(servedConfigConsumer(health())).toMatchObject({
      ok: true,
      consumer: { identity: { commit }, key: `base-${commit}`, version: 3 },
    });
  });
  it("a legacy base receipt cannot become eligible through a newer display identity", () => {
    const body = health();
    body.loadedBase.source.key = "base";
    body.build.commit = commit;
    expect(servedConfigConsumer(body)).toMatchObject({ ok: false });
  });
  it.each(["draining", "foreign", "short", "missing", "bad-version"])("refuses an ineligible %s receipt", (failure) => {
    const body = health();
    if (failure === "draining") body.draining = true;
    if (failure === "foreign") body.loadedBase.source.key = `base-${"b".repeat(40)}`;
    if (failure === "short") body.loadedBase.process.commit = "a".repeat(7);
    if (failure === "missing") delete (body as { loadedBase?: unknown }).loadedBase;
    if (failure === "bad-version") body.loadedBase.source.version = 0;
    expect(servedConfigConsumer(body)).toMatchObject({ ok: false });
  });
});
