import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const DOCKERFILE = resolve(ROOT, "deploy/cloudflare-sandbox/Dockerfile");
const WRAPPER = resolve(ROOT, "deploy/cloudflare-sandbox/docker-wrapper.sh");

// Feature: docs/reference/specs/execution.md item 17 — the cold sandbox image
// carries a Docker engine behind a lazy-start wrapper. Static: the image is
// built by check:image, not here; the wrapper's runtime behaviour is the
// spec's live row.

const dockerfile = readFileSync(DOCKERFILE, "utf8");
const wrapper = readFileSync(WRAPPER, "utf8");

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

describe("the cold sandbox image ships a Docker engine", () => {
  const aptLayer = instructions(dockerfile).find((l) => /^RUN\b.*apt-get install\b/.test(l)) ?? "";

  it("installs docker.io and iptables in the apt layer, without recommends", () => {
    const installs = aptLayer.match(/apt-get install -y --no-install-recommends [^&]+/g) ?? [];
    const packages = installs.flatMap((i) => i.split(/\s+/).slice(4));
    expect(packages).toContain("docker.io");
    expect(packages).toContain("iptables");
  });

  it("still drops the apt lists in the same layer", () => {
    expect(aptLayer).toContain("rm -rf /var/lib/apt/lists/*");
  });

  it("installs the wrapper as /usr/local/bin/docker, ahead of the engine's client on PATH", () => {
    const copy = instructions(dockerfile).find((l) => /^COPY\b.*docker-wrapper\.sh\b/.test(l)) ?? "";
    expect(copy).toMatch(/^COPY --chmod=0?755 docker-wrapper\.sh \/usr\/local\/bin\/docker$/);
  });
});

describe("the docker wrapper", () => {
  it("is plain sh that parses", () => {
    expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
    expect(() => execFileSync("sh", ["-n", WRAPPER], { stdio: "pipe" })).not.toThrow();
  });

  it("starts the daemon in its own session, so the exec reaper does not take it down", () => {
    expect(wrapper).toMatch(/^\s*setsid -f dockerd >"\$LOG" 2>&1$/m);
    const code = wrapper
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/nohup|&\s*$/m);
  });

  it("enables IPv4 forwarding before the daemon starts", () => {
    const forward = wrapper.indexOf("net.ipv4.ip_forward=1");
    const start = wrapper.indexOf("setsid -f dockerd");
    expect(forward).toBeGreaterThan(-1);
    expect(forward).toBeLessThan(start);
  });

  it("starts the daemon only when the socket is missing or the engine does not answer", () => {
    expect(wrapper).toMatch(/if \[ ! -S \/var\/run\/docker\.sock \] \|\| ! daemon_ready; then/);
    expect(wrapper).toMatch(/daemon_ready\(\) \{ "\$REAL" info >\/dev\/null 2>&1; \}/);
  });

  it("waits a bounded 40 s and then fails naming the daemon log", () => {
    expect(wrapper).toMatch(/-ge 40 \]/);
    expect(wrapper).toMatch(/did not come up within 40 s — see \$LOG" >&2\n\s*exit 1/);
    expect(wrapper).toContain("LOG=/var/log/dockerd.log");
  });

  it("ends by handing over to the engine's own client with the caller's arguments", () => {
    const lines = wrapper.trimEnd().split("\n");
    expect(lines.at(-1)).toBe('exec "$REAL" "$@"');
    expect(wrapper).toContain("REAL=/usr/bin/docker");
  });

  it("stays short enough to check by eye", () => {
    expect(wrapper.split("\n").length).toBeLessThanOrEqual(45);
  });
});
