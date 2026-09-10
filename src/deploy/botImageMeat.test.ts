import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const BOT = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
const EXECUTION_IMAGES = ["deploy/cloudflare-resident/Dockerfile", "deploy/cloudflare-sandbox/Dockerfile"] as const;

// Feature: docs/reference/specs/reading-diff.md item 6 — meat.dev's binary lives in
// the BOT image only. The abridged reading diff is produced on the bot host over
// a diff the bot fetches, with the bot's own Anthropic credential, so no
// execution container (resident or sandbox) ever needs the binary or the key.
// Static: the image itself is built by check:image.

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

describe("the bot image carries meat", () => {
  const lines = instructions(BOT);

  it("builds meat in its own stage from an exactly pinned Go image", () => {
    const stage = lines.find((l) => /^FROM\b.* AS meat$/.test(l)) ?? "";
    expect(stage).toMatch(/^FROM docker\.io\/library\/golang:\d+\.\d+\.\d+-bookworm AS meat$/);
  });

  it("installs meat.dev/cmd/meat at a pinned commit sha, CGO off, so the binary is static and the version is the commit's", () => {
    const install = lines.find((l) => /^RUN\b.*go install meat\.dev\/cmd\/meat@/.test(l)) ?? "";
    expect(install).toMatch(/^RUN CGO_ENABLED=0 go install meat\.dev\/cmd\/meat@[0-9a-f]{40}$/);
  });

  it("copies the one binary into the runtime stage and asserts it is on PATH", () => {
    expect(lines).toContain("COPY --from=meat /go/bin/meat /usr/local/bin/meat");
    const assertion = lines.find((l) => /^RUN\b.*command -v meat\b/.test(l)) ?? "";
    expect(assertion).toContain("meat -h");
  });

  it("copies it before the runtime stage drops to the unprivileged user", () => {
    const copy = lines.indexOf("COPY --from=meat /go/bin/meat /usr/local/bin/meat");
    const user = lines.findIndex((l) => /^USER switchboard$/.test(l));
    expect(copy).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(copy);
  });
});

describe.each(EXECUTION_IMAGES)("%s", (path) => {
  it("does not install meat — no execution container needs the binary or the credential", () => {
    const text = readFileSync(resolve(ROOT, path), "utf8");
    expect(instructions(text).some((l) => /\bmeat\b/.test(l))).toBe(false);
  });
});
