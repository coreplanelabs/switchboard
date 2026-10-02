import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executionImageInputTags } from "./imageInputs.js";

const resident = "deploy/cloudflare-resident";
const sandbox = "deploy/cloudflare-sandbox";
const inputs = () =>
  new Map([
    [`${resident}/Dockerfile`, "FROM node:24\nCOPY hook /hook\n"],
    [`${resident}/hook`, "first"],
    [`${sandbox}/Dockerfile`, "FROM node:24\nCOPY --chmod=0755 wrapper.sh /wrapper\n"],
    [`${sandbox}/wrapper.sh`, "first"],
  ]);

describe("execution image input tags", () => {
  it("changes only when a Dockerfile or a local COPY input changes", async () => {
    const files = inputs();
    const read = async (path: string) => files.get(path);
    const original = await executionImageInputTags(read);
    expect(original.resident).toMatch(/^inputs-[0-9a-f]{64}$/);
    expect(original.sandbox).toMatch(/^inputs-[0-9a-f]{64}$/);
    files.set(`${resident}/worker.ts`, "new Worker code");
    expect(await executionImageInputTags(read)).toEqual(original);
    files.set(`${resident}/hook`, "second");
    expect((await executionImageInputTags(read)).resident).not.toBe(original.resident);
    expect((await executionImageInputTags(read)).sandbox).toBe(original.sandbox);
    files.set(`${resident}/Dockerfile`, "FROM node:25\nCOPY hook /hook\n");
    expect((await executionImageInputTags(read)).resident).not.toBe(original.resident);
    files.set(`${sandbox}/.dockerignore`, "*.tmp\n");
    expect((await executionImageInputTags(read)).sandbox).not.toBe(original.sandbox);
  });

  it("falls back to a release tag when an input is missing or the Dockerfile uses an unsupported source", async () => {
    const missing = inputs();
    missing.delete(`${sandbox}/wrapper.sh`);
    expect((await executionImageInputTags(async (path) => missing.get(path))).sandbox).toBeUndefined();
    missing.set(`${sandbox}/Dockerfile`, "FROM node:24\nCOPY . /app\n");
    expect((await executionImageInputTags(async (path) => missing.get(path))).sandbox).toBeUndefined();
    missing.set(`${sandbox}/Dockerfile`, "FROM node:24\nRUN --mount=type=bind,source=./wrapper.sh echo ok\n");
    expect((await executionImageInputTags(async (path) => missing.get(path))).sandbox).toBeUndefined();
    missing.set(`${sandbox}/Dockerfile`, "FROM node:24\nCOPY wrapper.sh /wrapper\n");
    missing.set(`${sandbox}/wrapper.sh`, "invalid \ufffd bytes");
    expect((await executionImageInputTags(async (path) => missing.get(path))).sandbox).toBeUndefined();
  });

  it("covers every local COPY source in the committed execution Dockerfiles", async () => {
    const tags = await executionImageInputTags(async (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });
    expect(tags.resident).toMatch(/^inputs-[0-9a-f]{64}$/);
    expect(tags.sandbox).toMatch(/^inputs-[0-9a-f]{64}$/);
  });
});
