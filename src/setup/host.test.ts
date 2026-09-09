import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostSetupIO,
  isCheckoutRoot,
  modeOf,
  PACKAGE_ROOT,
  publishedImage,
  readTemplates,
  ttyPrompter,
  writePlannedFile,
} from "./host.js";
import { CONFIG_PATH, ENV_PATH } from "./plan.js";

// Feature: docs/reference/specs/init.md — the host half of `switchboard init`:
// templates from the package, files into the working directory, `.env` at
// mode 600 whether created or replaced, and a prompt only on a terminal.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const tmp = () => (dir = mkdtempSync(join(tmpdir(), "swb-init-")));

describe("writePlannedFile", () => {
  it("creates the file's directory and writes it at its mode: .env is 600, config.yaml 644", async () => {
    const cwd = tmp();
    await writePlannedFile({ path: ENV_PATH, text: "A=1\n", mode: 0o600, secretNames: ["A"] }, cwd);
    await writePlannedFile({ path: CONFIG_PATH, text: "organization: acme\n", mode: 0o644, secretNames: [] }, cwd);
    expect(readFileSync(join(cwd, ENV_PATH), "utf8")).toBe("A=1\n");
    expect(modeOf(join(cwd, ENV_PATH))).toBe(0o600);
    expect(modeOf(join(cwd, CONFIG_PATH))).toBe(0o644);
  });

  it("replacing an existing, looser file tightens it to 600 — a --force rewrite never keeps a readable .env", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ENV_PATH), "OLD=1\n", { mode: 0o644 });
    expect(modeOf(join(cwd, ENV_PATH))).toBe(0o644);
    await writePlannedFile({ path: ENV_PATH, text: "A=1\n", mode: 0o600, secretNames: ["A"] }, cwd);
    expect(readFileSync(join(cwd, ENV_PATH), "utf8")).toBe("A=1\n");
    expect(modeOf(join(cwd, ENV_PATH))).toBe(0o600);
  });

  it("the bytes never exist at a looser mode: written to a temp file beside the target at 600, then renamed over it; nothing else is left in the directory", async () => {
    const cwd = tmp();
    const dir = join(cwd, "config");
    // A file that already exists at 644 is the case `writeFile`'s mode would ignore.
    writeFileSync(join(cwd, ENV_PATH), "OLD=1\n", { mode: 0o644 });
    const before = statSync(join(cwd, ENV_PATH)).ino;
    await writePlannedFile({ path: ENV_PATH, text: "A=1\n", mode: 0o600, secretNames: ["A"] }, cwd);
    await writePlannedFile({ path: CONFIG_PATH, text: "organization: acme\n", mode: 0o644, secretNames: [] }, cwd);
    // A new inode: the 644 file was replaced by rename, never opened and rewritten at 644.
    expect(statSync(join(cwd, ENV_PATH)).ino).not.toBe(before);
    expect(readdirSync(cwd).sort()).toEqual([".env", "config"]);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
    expect(modeOf(join(cwd, ENV_PATH))).toBe(0o600);
    expect(modeOf(join(dir, "config.yaml"))).toBe(0o644);
    expect(readFileSync(join(cwd, ENV_PATH), "utf8")).toBe("A=1\n");
  });
});

describe("the package and the working directory", () => {
  it("reads the three templates from the package root — the checked-in examples — and names a missing one", async () => {
    const t = await readTemplates();
    expect(t.env).toContain("ANTHROPIC_API_KEY=");
    expect(t.config).toContain("providers:");
    expect(JSON.parse(t.profile)).toHaveProperty("workers.bot");
    await expect(readTemplates(tmp())).rejects.toThrow(/\.env\.example: no such file/);
  });

  it("the package root is the repository root; a temp dir is not a checkout; the image fact is project.json's", () => {
    expect(isCheckoutRoot(PACKAGE_ROOT)).toBe(true);
    expect(isCheckoutRoot(tmp())).toBe(false);
    expect(isCheckoutRoot(join(PACKAGE_ROOT, "no-such-dir"))).toBe(false);
    expect(publishedImage()).toBe(JSON.parse(readFileSync(join(PACKAGE_ROOT, "project.json"), "utf8")).image);
  });

  it("hostSetupIO is scoped to the working directory: exists/readFile/write resolve there, inCheckout says whether it is the root", async () => {
    const cwd = tmp();
    const io = hostSetupIO(cwd);
    expect(await io.exists(ENV_PATH)).toBe(false);
    expect(await io.readFile("key.pem")).toBeUndefined();
    writeFileSync(join(cwd, "key.pem"), "PEM\n");
    expect(await io.readFile("key.pem")).toBe("PEM\n");
    await io.write({ path: ENV_PATH, text: "A=1\n", mode: 0o600, secretNames: [] });
    expect(await io.exists(ENV_PATH)).toBe(true);
    expect(existsSync(join(cwd, ENV_PATH))).toBe(true);
    expect(io.inCheckout()).toBe(false);
    expect(hostSetupIO(PACKAGE_ROOT).inCheckout()).toBe(true);
  });
});

describe("ttyPrompter", () => {
  const fakeTty = (isTTY: boolean) => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
    Object.assign(stdin, { isTTY });
    Object.assign(stdout, { isTTY });
    return { stdin, stdout };
  };

  it("is undefined without a terminal on both ends — a pipe or CI is never asked anything", () => {
    expect(ttyPrompter(fakeTty(false))).toBeUndefined();
    const half = fakeTty(true);
    Object.assign(half.stdout, { isTTY: false });
    expect(ttyPrompter(half)).toBeUndefined();
  });

  it("on a terminal a plain answer is read and trimmed; a secret answer is read with the keystrokes kept off the output", async () => {
    const io = fakeTty(true);
    const prompt = ttyPrompter(io)!;
    const seen: string[] = [];
    io.stdout.on("data", (c: Buffer) => seen.push(c.toString()));
    const plain = prompt("Organization: ", { secret: false });
    io.stdin.write("  acme \n");
    expect(await plain).toBe("acme");
    const secret = prompt("Key: ", { secret: true });
    io.stdin.write("sk-very-secret\n");
    expect(await secret).toBe("sk-very-secret");
    const out = seen.join("");
    expect(out).toContain("Organization: ");
    expect(out).toContain("Key: ");
    expect(out).not.toContain("sk-very-secret");
  });
});
