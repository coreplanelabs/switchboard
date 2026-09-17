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
// WebSocket closed under the call — is the word only when the resident knows
// the container it held is gone: the container's exit as the platform's
// monitor recorded it (the Container base's `stopped_with_code`, the rollout
// signal's one programmatic trace) or a restore under way; otherwise the
// answer says what the SDK said, with no word and no `reason`, and the
// harness's one more command decides. An asleep or starting container answers
// the same words, so the platform's view of `running` is never the evidence,
// and the Container base's `onStop` — replayed at the next start for an idle
// sleep as much as for a roll — is never a source. The same decision, made
// once where `run()` classifies the failure, gates the incarnation swap. This
// scan over the entry holds the line: plain Node, the file read as text, never
// loaded — like lifecycle.test.ts.

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

  it("the gate: the word when the replacement was known at the choke point — the SDK vouched the runtime moved or the resident knew the container gone, the one decision run() made and carried on the error — otherwise what the SDK said, with no reason", () => {
    const gate = methodOf(source, "replacedExecAnswer");
    expect(gate, "replacedExecAnswer is declared").not.toBeNull();
    expect(gate).toMatch(/if \(err\.known\) return runtimeReplacedErr\(err\)/);
    expect(gate).toMatch(/error: errMsg\(err\.cause\)/);
    expect(gate).not.toMatch(/reason:/);
    // One decision, made where the failure is classified; the gate re-judges nothing.
    expect(gate).not.toMatch(/sdkVouchesRuntimeMoved|knowsContainerGone/);
    expect(source).toMatch(
      /class RuntimeReplacedError extends Error \{\s*constructor\(\s*readonly phase: "spawn" \| "collect",\s*readonly cause: unknown,(?:\s*\/\*\*[\s\S]*?\*\/)?\s*readonly known: boolean,/,
    );
  });

  it("what the resident knows: the container's exit as the platform's monitor recorded it (the Container base's `stopped_with_code`, the rollout signal's trace — never `stopped`, our own idle stop, nor `running`, a start under way) and a restore under way — never the platform's `running` flag, never a replayed `onStop`; a read that fails is no knowledge (the SDK's words, never an unhandled throw)", () => {
    const knows = methodOf(source, "knowsContainerGone");
    expect(knows, "knowsContainerGone is declared").not.toBeNull();
    expect(knows).toMatch(/\(await this\.getState\(\)\)\.status === "stopped_with_code"/);
    expect(knows).toMatch(/\(await this\.getStatus\(\)\)\.state === "restoring"/);
    expect(knows).not.toMatch(/container\??\.running/);
    expect(knows).not.toMatch(/containerStop|onStop/);
    // Each read sits inside a try whose catch keeps going or answers false, so
    // the 409 is always produced and a failed read never becomes the word.
    expect(knows.match(/try \{/g)).toHaveLength(2);
    expect(knows.match(/\} catch \{/g)).toHaveLength(2);
    expect(knows).toMatch(/return false;\s*\}\s*\}\s*$/);
    // The Container base replays onStop before a start (syncPendingStoppedEvents)
    // and never delivers the rollout live, so the entry keeps no stop record and
    // overrides no stop hook: an idle sleep's replayed stop cannot count.
    expect(methodOf(source, "onStop")).toBeNull();
    expect(source).not.toMatch(/containerStop\b/); // the teardown's `containerStopped` is another thing
  });

  it("the incarnation swap is gated as the word is: run() swaps memos and leases only for a replacement the SDK vouched or the resident knows, and the error carries that decision (`known`) for the exec gate to read", () => {
    const run = methodOf(source, "run");
    expect(run, "run is declared").not.toBeNull();
    expect(run.match(/const known = await this\.replacementKnown\(err\);/g)).toHaveLength(2);
    expect(run.match(/if \(known\) this\.swapIncarnation\(\);/g)).toHaveLength(2);
    expect(run).toMatch(/new RuntimeReplacedError\("spawn", err, known\)/);
    expect(run).toMatch(/new RuntimeReplacedError\("collect", err, known\)/);
    expect(run).not.toMatch(
      /^\s*this\.swapIncarnation\(\);\s*\/\/ the container this incarnation's memos described is gone$/m,
    );
    const replacementKnown = methodOf(source, "replacementKnown");
    expect(replacementKnown, "replacementKnown is declared").not.toBeNull();
    expect(replacementKnown).toMatch(/sdkVouchesRuntimeMoved\(err\) \|\| \(await this\.knowsContainerGone\(\)\)/);
    expect(functionOf("sdkVouchesRuntimeMoved")).not.toMatch(/knowsContainerGone/);
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

  it("the idempotent routes keep item 43's answer as it was: read, the bytes read and write say the word unconditionally — there it drives the client's re-attach-and-retry, never a verdict — and none of them consults the gate", () => {
    for (const name of ["readThreadFileImpl", "readThreadBytes", "writeThreadFileImpl"]) {
      const impl = methodOf(source, name);
      expect(impl, `${name} is declared`).not.toBeNull();
      expect(impl).toMatch(/return runtimeReplacedErr\(err\)/);
      expect(impl).not.toMatch(/replacedExecAnswer|knowsContainerGone|sdkVouchesRuntimeMoved/);
    }
  });
});
