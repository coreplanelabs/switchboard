// Feature: docs/reference/specs/tracing.md — the streamed set, its classes, and the
// ancestor invariant the partition's depth rule relies on.
import { describe, expect, it } from "vitest";
import { ATTR_KEYS, invalidAttrKeys } from "./attrs.js";
import { classOf, isStreamed, PARENTS, STREAMED_PREFIXES, STREAMED_SPANS } from "./streamSpans.js";

describe("streamSpans", () => {
  it("every enumerated name and every prefix family has a class under both owners; log-only names have none", () => {
    for (const owner of ["agent", "command"] as const) {
      for (const name of STREAMED_SPANS) expect(classOf(name, owner), name).toBeDefined();
      for (const prefix of Object.keys(STREAMED_PREFIXES)) expect(classOf(`${prefix}x`, owner), prefix).toBeDefined();
    }
    for (const logOnly of [
      "exec.exec",
      "github.rest",
      "http.client",
      "post.history_write",
      "model.block.text",
      "slack.catch_up",
      "drain",
      "deploy.step.bot",
      "deploy.wait_live",
      "resident.fleet_refresh",
      "dashboard.residents",
    ]) {
      expect(isStreamed(logOnly), logOnly).toBe(false);
      expect(classOf(logOnly, "agent"), logOnly).toBeUndefined();
    }
  });

  it("run.command and its grafts flip bucket with the owner; nothing else does", () => {
    expect(classOf("run.command", "command")).toEqual({ kind: "counted", bucket: "tools" });
    expect(classOf("run.command", "agent")).toEqual({ kind: "counted", bucket: "getting_ready" });
    expect(classOf("run.command.test", "command")).toEqual({ kind: "counted", bucket: "tools" });
    for (const name of STREAMED_SPANS.filter((n) => n !== "run.command")) {
      expect(classOf(name, "agent"), name).toEqual(classOf(name, "command"));
    }
  });

  it("no counted name is reachable under a background parent, and every cross-bucket ancestor of a counted name is uncounted (both owners)", () => {
    const parentsOf = (name: string): readonly string[] => {
      if (name in PARENTS) return PARENTS[name];
      const prefix = Object.keys(STREAMED_PREFIXES).find((p) => name.startsWith(p));
      return prefix ? PARENTS[prefix] : [];
    };
    const ancestors = (name: string, seen = new Set<string>()): string[] => {
      const out: string[] = [];
      for (const p of parentsOf(name)) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p, ...ancestors(p, seen));
      }
      return out;
    };
    const names = [...STREAMED_SPANS, ...Object.keys(STREAMED_PREFIXES).map((p) => `${p}x`)];
    for (const owner of ["agent", "command"] as const) {
      for (const name of names) {
        const c = classOf(name, owner);
        if (c?.kind !== "counted") continue;
        for (const a of ancestors(name)) {
          const ac = classOf(a.endsWith(".") ? `${a}x` : a, owner);
          expect(ac?.kind, `${name} under ${a}`).not.toBe("background");
          if (ac?.kind === "counted" && ac.bucket !== c.bucket) {
            throw new Error(
              `${name} (${c.bucket}) has a counted ancestor ${a} in another bucket (${ac.bucket}) under owner ${owner}`,
            );
          }
        }
      }
    }
  });

  it("PARENTS covers every streamed name and prefix exactly", () => {
    const expected = new Set<string>([...STREAMED_SPANS, ...Object.keys(STREAMED_PREFIXES)]);
    expect(new Set(Object.keys(PARENTS))).toEqual(expected);
  });
});

describe("attrs", () => {
  it("validates domains and identifier shapes; unknown keys and free text are refused", () => {
    expect(invalidAttrKeys({ channel: "slack", count: 3, ok: true, route: "repos/:owner/:repo/pulls" })).toEqual([]);
    expect(invalidAttrKeys({ count: "3" } as never)).toEqual(["count"]);
    expect(invalidAttrKeys({ nope: 1 } as never)).toEqual(["nope"]);
    expect(invalidAttrKeys({ command: "repo list --all; rm -rf" })).toEqual(["command"]);
    expect(invalidAttrKeys({ host: "https://x.example/?t=SECRET" })).toEqual(["host"]);
    expect(invalidAttrKeys({ execMs: Number.NaN })).toEqual(["execMs"]);
    expect(ATTR_KEYS).toContain("queuedBehindMs");
    // The Workers' own roots (docs/reference/specs/tracing.md item 25): counts, never names.
    expect(invalidAttrKeys({ residents: 3, swept: 120 })).toEqual([]);
    expect(invalidAttrKeys({ residents: "3" } as never)).toEqual(["residents"]);
  });
});
