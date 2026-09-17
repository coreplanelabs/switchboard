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
// the container it held is gone, and its one reliable knowledge is its own: a
// restore under way for this resident; otherwise the answer says what the SDK
// said, with no word and no `reason`, and the harness's one more command
// decides. Not the Container base's exit state, not the platform's `running`
// flag, not the base's replayed `onStop`: why each separates nothing is the
// record's, in resident-repos.md item 43 with the pinned library's lines. At
// the choke point a classified replacement clears the per-incarnation memos
// unconditionally and mints the incarnation (every lease) only when known,
// and only the word is gated. This scan over the entry holds the line: plain
// Node, the file read as text, never loaded — like lifecycle.test.ts.

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

  it("what the resident knows is a restore under way and nothing else: never the Container base's exit state (a roll writes `stopped` or nothing once the wake replaced the monitor, an idle stop's graceful exit writes `stopped_with_code(0)` — the state separates nothing), never the platform's `running` flag, never a replayed `onStop`; a read that fails is no knowledge (the SDK's words, never an unhandled throw)", () => {
    const knows = methodOf(source, "knowsContainerGone");
    expect(knows, "knowsContainerGone is declared").not.toBeNull();
    expect(knows).toMatch(/\(await this\.getStatus\(\)\)\.state === "restoring"/);
    expect(knows).not.toMatch(/getState\(\)|stopped_with_code/);
    expect(knows).not.toMatch(/container\??\.running/);
    expect(knows).not.toMatch(/containerStop|onStop/);
    // The one read sits inside a try whose catch answers false, so the 409 is
    // always produced and a failed read never becomes the word.
    expect(knows).toMatch(
      /try \{\s*return \(await this\.getStatus\(\)\)\.state === "restoring";\s*\} catch \{\s*return false;\s*\}/,
    );
    // The Container base replays onStop before a start (syncPendingStoppedEvents)
    // and never delivers the rollout live, so the entry keeps no stop record and
    // overrides no stop hook: an idle sleep's replayed stop cannot count.
    expect(methodOf(source, "onStop")).toBeNull();
    expect(source).not.toMatch(/containerStop\b/); // the teardown's `containerStopped` is another thing
  });

  it("the two consequences of a classified replacement are split at the choke point: the per-incarnation memos clear unconditionally (the fact that was stale), the incarnation — and with it every lease — is minted only when the replacement is known, so a transport blip on one request cannot hand a live holder's mutex to a concurrent attach; the word stays gated on the same `known`", () => {
    const run = methodOf(source, "run");
    expect(run, "run is declared").not.toBeNull();
    // Both sites: the memos first, unconditionally; the decision; the incarnation only on it.
    expect(run.match(/this\.clearIncarnationMemos\(\);/g)).toHaveLength(2);
    expect(run.match(/const known = await this\.replacementKnown\(err\);/g)).toHaveLength(2);
    expect(run.match(/if \(known\) this\.swapIncarnation\(\);/g)).toHaveLength(2);
    expect(run).not.toMatch(/^\s*this\.swapIncarnation\(\);\s*$/m);
    expect(run).toMatch(/new RuntimeReplacedError\("spawn", err, known\)/);
    expect(run).toMatch(/new RuntimeReplacedError\("collect", err, known\)/);
    for (const site of run.matchAll(
      /this\.clearIncarnationMemos\(\);[\s\S]{0,600}?const known = await this\.replacementKnown\(err\);/g,
    ))
      expect(site[0], "the memo clear is not under a condition").not.toMatch(
        /if \([^)]*\)\s*this\.clearIncarnationMemos/,
      );
    // The memo block's invariant reads true: a runtime replacement at the one
    // exec choke point clears the memos, whatever the word will say.
    expect(source).toMatch(
      /a runtime replacement surfaces as RuntimeReplacedError at the\s*\/\/ ONE exec choke point \(`run\(\)`\)/,
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
    expect(vouches).toMatch(/RUNTIME_MOVED_WORDING\.test/);
    expect(vouches).not.toMatch(/RUNTIME_REPLACEMENT_WORDING/);
    expect(vouches).not.toMatch(/STOPPED_CONTAINER_WORDING/);
    expect(vouches).not.toMatch(/RPCTransportError/);
    // A DO code-update reset becomes a `ControlResetError` in `run()` before any
    // `RuntimeReplacedError`, so it can never be a vouching reason: the vouching
    // set does not list the isolate reset (`controlReset.test.ts` proves the
    // predicate lives in `isControlReset` alone, off both the gate and the union).
    expect(vouches).not.toMatch(/isDurableObjectCodeUpdateReset/);
    const replacement = functionOf("isRuntimeReplacement");
    expect(replacement).toMatch(/RUNTIME_REPLACEMENT_WORDING\.test/);
    expect(replacement).toMatch(/RPC_TRANSPORT_LOSS_KINDS\.has/);
    // The union too is immune to the isolate reset now (the /exec path never
    // swaps the incarnation on a DO reset); the restore path folds it in by name.
    expect(replacement).not.toMatch(/isDurableObjectCodeUpdateReset/);
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
