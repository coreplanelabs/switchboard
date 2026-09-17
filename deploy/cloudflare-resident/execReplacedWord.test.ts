import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// The `/exec` answer says `runtime-replaced` only when the resident knows the
// container it held is gone (docs/reference/specs/resident-repos.md item 43;
// harness.md item 6, the third failure shape). A command the SDK fails with a
// word that vouches the runtime MOVED (a stale process handle, an inactive
// runtime identity, an interruption for a replaced runtime, the Durable
// Object's own reset) is the word whatever else is known. A command the SDK
// fails saying only that the container is DOWN — "The container is not
// running, consider calling start()", "Process supervisor is closed", a
// WebSocket closed under the call — is the word only when the resident saw the
// container stop (`onStop`, the rollout's signal) or has a restore under way;
// otherwise the answer says what the SDK said, with no word and no `reason`,
// and the harness's one more command decides. An asleep or starting container
// answers the same words, so the platform's view of `running` is never the
// evidence. This scan over the entry holds the line: plain Node, the file read
// as text, never loaded — like lifecycle.test.ts.

const source = readSource("worker.ts");

/** The text of one module-level function of the entry: from its declaration to the first line that is a lone `}`. */
function functionOf(name: string): string {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start, `worker.ts declares function ${name}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.search(/^}\n/m);
  return end === -1 ? rest : rest.slice(0, end + 2);
}

describe("the /exec answer says runtime-replaced only when the resident knows the container it held is gone", () => {
  it("every RuntimeReplacedError the exec route meets — the preflight's probe and the command alike — goes through one gate, replacedExecAnswer, and never straight to the word", () => {
    const impl = methodOf(source, "execThreadImpl");
    expect(impl, "execThreadImpl is declared").not.toBeNull();
    expect(impl).toMatch(/replacedExecAnswer\(/);
    expect(impl).not.toMatch(/runtimeReplacedErr\(/);
    // The gate wraps the whole route body, so a replacement met by the
    // preflight's own command (`test -d` on the worktree) is judged too, and
    // the body itself converts nothing before the gate sees it.
    expect(impl).toMatch(/try \{\s*return await this\.execThreadBody\(/);
    const body = methodOf(source, "execThreadBody");
    expect(body, "execThreadBody is declared").not.toBeNull();
    expect(body).not.toMatch(/runtimeReplacedErr\(/);
    expect(body).not.toMatch(/RuntimeReplacedError/);
  });

  it("the gate: the word when the SDK vouches the runtime moved or the resident knows the container is gone; otherwise what the SDK said, with no reason", () => {
    const gate = methodOf(source, "replacedExecAnswer");
    expect(gate, "replacedExecAnswer is declared").not.toBeNull();
    expect(gate).toMatch(/sdkVouchesRuntimeMoved\(err\.cause\)/);
    expect(gate).toMatch(/await this\.knowsContainerGone\(\)/);
    expect(gate).toMatch(/return runtimeReplacedErr\(err\)/);
    expect(gate).toMatch(/error: errMsg\(err\.cause\)/);
    expect(gate).not.toMatch(/reason:/);
  });

  it("what the resident knows: the container stop it saw and a restore under way — never the platform's `running` flag, which an asleep or starting container also answers false", () => {
    const knows = methodOf(source, "knowsContainerGone");
    expect(knows, "knowsContainerGone is declared").not.toBeNull();
    expect(knows).toMatch(/this\.containerStop !== undefined/);
    expect(knows).toMatch(/state === "restoring"/);
    expect(knows).not.toMatch(/container\??\.running/);
  });

  it("the rollout's signal is recorded where the platform delivers it: onStop records the stop with its exit code and reason, logs it, and still runs the SDK's own stop reconciliation; a command the container answers clears the record", () => {
    const onStop = methodOf(source, "onStop");
    expect(onStop, "onStop is declared").not.toBeNull();
    expect(onStop).toMatch(/this\.containerStop = \{/);
    expect(onStop).toMatch(/exitCode/);
    expect(onStop).toMatch(/reason/);
    expect(onStop).toMatch(/console\.log\(\s*`container: stopped/);
    expect(onStop).toMatch(/await super\.onStop\(\)/);
    const run = methodOf(source, "run");
    expect(run, "run is declared").not.toBeNull();
    // The spawn is the proof the container answers: the stop seen before it is history.
    expect(run).toMatch(/this\.containerStop = undefined/);
  });

  it("the SDK's vouching is the typed classes and the words that say the runtime MOVED — never the words for a container that is merely down; the resident's own steps keep the union", () => {
    const vouches = functionOf("sdkVouchesRuntimeMoved");
    expect(vouches).toMatch(/StaleProcessHandleError/);
    expect(vouches).toMatch(/RuntimeIdentityInactiveError/);
    expect(vouches).toMatch(/RUNTIME_REPLACED_REASONS\.has/);
    expect(vouches).toMatch(/isDurableObjectCodeUpdateReset/);
    expect(vouches).toMatch(/RUNTIME_MOVED_WORDING\.test/);
    expect(vouches).not.toMatch(/RUNTIME_REPLACEMENT_WORDING/);
    expect(vouches).not.toMatch(/STOPPED_CONTAINER_WORDING/);
    expect(vouches).not.toMatch(/RPCTransportError/);
    const replacement = functionOf("isRuntimeReplacement");
    expect(replacement).toMatch(/RUNTIME_REPLACEMENT_WORDING\.test/);
    expect(replacement).toMatch(/RPC_TRANSPORT_LOSS_KINDS\.has/);
  });

  it("the idempotent routes keep item 43's answer as it was: read and write say the word and the client re-attaches and retries", () => {
    for (const name of ["readThreadFileImpl", "writeThreadFileImpl"]) {
      const impl = methodOf(source, name);
      expect(impl, `${name} is declared`).not.toBeNull();
      expect(impl).toMatch(/return runtimeReplacedErr\(err\)/);
    }
  });
});
