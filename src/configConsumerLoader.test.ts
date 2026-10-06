import { describe, expect, it } from "vitest";
import { loadAppConfigWithReceiptFrom } from "./config.js";
import { baseConfigDocument } from "./configDocument.js";
import { secretsFrom } from "./secrets.js";
const commit = "a".repeat(40);
const yaml = `organization: example
providers:
  test:
    wire: openai-responses
    apiKeyEnv: TEST_API_KEY
defaults:
  agent: general
  models:
    general: test/general-model
runHistory:
  worker:
    baseUrl: https://state.example
    tokenEnv: MEMORY_TOKEN
grants:
  'slack:UTEST':
    actions: [all]
`;
const doc = baseConfigDocument(yaml, "candidate", new Date(1));
function loader(documents: Record<string, typeof doc>) {
  const keys: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const key = JSON.parse(String(init?.body)).key as string;
    keys.push(key);
    return Response.json({ document: documents[key] ?? null, version: documents[key] ? 1 : 0 });
  };
  const opts = {
    env: { STATE_WORKER_URL: "https://state.example" },
    secrets: secretsFrom({ MEMORY_TOKEN: "test" }),
    warn: () => {},
    fetch: fetchImpl,
    consumer: { commit },
  };
  return { keys, opts };
}
describe("consumer-bound config loader", () => {
  it("a new consumer reads its own staged document while the legacy base remains unchanged", async () => {
    const original = baseConfigDocument(yaml.replace("general-model", "legacy-model"), "legacy", new Date(0));
    const h = loader({ base: original, [`base-${commit}`]: doc });
    const loaded = await loadAppConfigWithReceiptFrom("state://base", h.opts);
    expect(h.keys).toEqual([`base-${commit}`]);
    expect(loaded.receipt.source).toEqual({ kind: "state", key: `base-${commit}`, version: 1 });
    expect(loaded.receipt.sha256).toBe(doc.sha256);
    expect(original.source).toBe("legacy");
  });
  it("a legacy reader can restart before and after staged new-slot data without seeing the new format", async () => {
    const legacy = baseConfigDocument(yaml.replace("general-model", "legacy-model"), "legacy", new Date(0));
    const documents = { base: legacy } as Record<string, typeof doc>;
    const h = loader(documents);
    const oldReader = { ...h.opts, consumer: undefined };
    const before = await loadAppConfigWithReceiptFrom("state://base", oldReader);
    documents[`base-${commit}`] = doc;
    const during = await loadAppConfigWithReceiptFrom("state://base", oldReader);
    const own = await loadAppConfigWithReceiptFrom("state://base", h.opts);
    expect(before.receipt.sha256).toBe(legacy.sha256);
    expect(during.receipt.sha256).toBe(legacy.sha256);
    expect(own.receipt.sha256).toBe(doc.sha256);
    expect(h.keys).toEqual(["base", "base", `base-${commit}`]);
    expect(documents.base).toEqual(legacy);
  });

  it("a missing own slot refuses even if a valid legacy base exists", async () => {
    const h = loader({ base: doc });
    await expect(loadAppConfigWithReceiptFrom("state://base", h.opts)).rejects.toThrow();
    expect(h.keys).toEqual([`base-${commit}`]);
  });
  it("an explicitly foreign slot refuses before reading any document", async () => {
    const foreign = `base-${"b".repeat(40)}`;
    const h = loader({ [foreign]: doc });
    await expect(loadAppConfigWithReceiptFrom(`state://${foreign}`, h.opts)).rejects.toThrow("does not belong");
    expect(h.keys).toEqual([]);
  });
});
