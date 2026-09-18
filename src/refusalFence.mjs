// The lint that makes the refusal seam a guarantee (record 0054's plan;
// docs/reference/specs/routing-and-config.md item 21): in a producing
// module a refusal reaches the person only as a `Refusal` — rendered by
// `renderRefusal` in src/core/dispatch/reply.ts — or as a thrown value that
// carries one (`RefusalError`, `CommandError`, `McpServiceError`). Plain JS so
// eslint.config.mjs can import it, on the `no-raw-env` pattern next door.
//
// What the rule refuses, in a producing module:
//   io.reply("🚫 …")            a sentence the renderer never saw → build a Refusal
//   throw new Error("…")        a throw the catch-all renders as `uncaught` → RefusalError
//   throw helper()              a helper-built error the fence cannot see through,
//                               unless the helper is named in REFUSAL_BUILDERS
// What it allows:
//   throw new RefusalError(…), throw new CommandError(…), throw new McpServiceError(…)
//   throw err                   a rethrow (the value was fenced where it was built)
//   throw residentFailure(r)    a named builder whose return type is a CommandError

/** The classes whose instances carry a refusal with a cause. */
export const REFUSAL_ERROR_CLASSES = new Set(["RefusalError", "CommandError", "McpServiceError"]);

/** Helpers that build one of the classes above (the fence is syntactic; the
 *  TypeScript return annotation of each named helper is the proof it builds a
 *  fenced value). `residentFailure` is repo.ts's status-mapped CommandError. */
export const REFUSAL_BUILDERS = new Set(["residentFailure"]);

/** The producing modules the fence applies to: the dispatch stages that refuse
 *  (never the renderer, src/core/dispatch/reply.ts, nor the dispatcher — both
 *  are the seam's own machinery), the ship preflight and the plan hand-off,
 *  the command handlers, the directive and resolve parsers, and the MCP
 *  service. The stages that reply answers, receipts and offers (route,
 *  commandRun, runLoop, spawn) join the list as their replies move onto the
 *  seam; the list only grows. */
export const REFUSAL_FENCE_FILES = [
  "src/core/dispatch/authorize.ts",
  "src/core/dispatch/admission.ts",
  "src/core/dispatch/provision.ts",
  "src/core/dispatch/reattach.ts",
  "src/core/dispatch/references.ts",
  "src/core/dispatch/settle.ts",
  "src/core/dispatch/ship.ts",
  "src/core/dispatch/resolve.ts",
  "src/directives.ts",
  "src/core/ship/preflight.ts",
  "src/core/coordinator/handOff.ts",
  "src/core/commands/*.ts",
  "src/core/commandChat.ts",
  "src/mcp/service.ts",
];
export const REFUSAL_FENCE_EXEMPT = ["**/*.test.ts", "src/**/testing/**"];

/** @param {import('estree').Node} node — is this `io.reply` / `<x>.io.reply`? */
function isIoReply(node) {
  if (node.type !== "MemberExpression") return false;
  if (node.property.type !== "Identifier" || node.property.name !== "reply") return false;
  const o = node.object;
  if (o.type === "Identifier" && o.name === "io") return true;
  return o.type === "MemberExpression" && o.property.type === "Identifier" && o.property.name === "io";
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawRefusal = {
  meta: {
    type: "problem",
    docs: { description: "a producing module refuses through the seam: a Refusal, never a raw reply or throw" },
    schema: [],
    messages: {
      rawReply:
        "io.reply() in a producing module bypasses the refusal seam: build a Refusal and render it through renderRefusal (src/core/dispatch/reply.ts).",
      rawThrow:
        "a throw here must carry a Refusal: throw new RefusalError(refusalOf(code, text)) (or a CommandError/McpServiceError, which carry a cause).",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isIoReply(node.callee)) context.report({ node, messageId: "rawReply" });
      },
      ThrowStatement(node) {
        const arg = node.argument;
        if (!arg) return;
        // A rethrow: the value was fenced where it was built.
        if (arg.type === "Identifier") return;
        if (
          arg.type === "NewExpression" &&
          arg.callee.type === "Identifier" &&
          REFUSAL_ERROR_CLASSES.has(arg.callee.name)
        )
          return;
        if (arg.type === "CallExpression" && arg.callee.type === "Identifier" && REFUSAL_BUILDERS.has(arg.callee.name))
          return;
        context.report({ node, messageId: "rawThrow" });
      },
    };
  },
};

/** The plugin eslint.config.mjs registers as `refusals`. */
export const refusalFencePlugin = { rules: { "no-raw-refusal": noRawRefusal } };
