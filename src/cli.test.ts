import { describe, expect, it } from "vitest";
import { parseCliInvocation } from "./cli.js";

// Feature: features/resident-repos.md — the CLI accepts a stable thread key
// (--thread flag or SWITCHBOARD_THREAD env) so repeated invocations can act
// as ONE thread (re-attach / binding-persistence verification).

describe("parseCliInvocation", () => {
  it("--thread <key> is honored and stripped from the request text", () => {
    const r = parseCliInvocation(["--thread", "cli:u5test", "agent:coding", "do it"], {});
    expect(r).toEqual({ threadKey: "cli:u5test", text: "agent:coding do it" });
  });

  it("--thread=<key> form works too", () => {
    const r = parseCliInvocation(["--thread=cli:u5test", "hello"], {});
    expect(r).toEqual({ threadKey: "cli:u5test", text: "hello" });
  });

  it("SWITCHBOARD_THREAD env supplies the key when no flag is given", () => {
    const r = parseCliInvocation(["hello"], { SWITCHBOARD_THREAD: "cli:envkey" });
    expect(r.threadKey).toBe("cli:envkey");
  });

  it("the flag beats the env var", () => {
    const r = parseCliInvocation(["--thread", "cli:flag", "hi"], { SWITCHBOARD_THREAD: "cli:env" });
    expect(r.threadKey).toBe("cli:flag");
  });

  it("defaults to an ephemeral per-invocation key", () => {
    const r = parseCliInvocation(["what", "is", "2+2"], {});
    expect(r.threadKey).toMatch(/^cli:\d+$/);
    expect(r.text).toBe("what is 2+2");
  });
});
