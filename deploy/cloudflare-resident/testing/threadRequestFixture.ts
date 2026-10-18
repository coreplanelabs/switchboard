import { DAY_MS } from "../../../src/core/budgets.js";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseOwnPr, parseRefByDefault, parsePushed } from "../../../src/execution/residentRebind.js";
import { parseReuse } from "../../../src/execution/residentReuse.js";
import { parseReadonly } from "../../../src/execution/residentReadonly.js";
import { parseWantSha } from "../../../src/execution/residentHead.js";
import { createStepTrace } from "../../../src/execution/residentStepTrace.js";
import { validRunOwner } from "../runRegistration.js";
import { methodOf, readSource } from "./sourceScan.js";

/** Execute the actual attach/detach handlers and attach wrapper. Only their
 * external route, trace sink and native receiver are fixtures. */
export function threadRequestFixture() {
  const source = ts.createSourceFile("worker.ts", readSource("worker.ts"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter((node) =>
    ts.isFunctionDeclaration(node)
      ? ["handleAttach", "handleDetach", "parseRef"].includes(node.name?.text ?? "")
      : ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((d) => d.name.getText(source) === "REF_RE"),
  );
  const compiled = ts.transpileModule(
    declarations.map((node) => node.getText(source)).join("\n") +
      `\nclass Receiver { ${methodOf(readSource("worker.ts"), "attachThread")} }\n({ handleAttach, handleDetach, Receiver })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const attached: unknown[][] = [];
  const traced: unknown[][] = [];
  const detached: unknown[][] = [];
  let receiver: { attachThread: (...args: unknown[]) => Promise<unknown> };
  const { handleAttach, handleDetach, Receiver } = runInNewContext(compiled, {
    Response,
    URL,
    parseOwnPr,
    parseRefByDefault,
    parsePushed,
    parseReuse,
    parseReadonly,
    parseWantSha,
    validRunOwner,
    DAY_MS,
    NO_REF_HINT_REASON: { ownPr: null, refByDefault: false },
    systemClock: () => 1000,
    createStepTrace,
    emitStepRoot: () => {},
    json: (body: unknown, status = 200) => Response.json(body, { status }),
    resolveThreadRoute: async () => ({
      threadKey: "mcp:request",
      record: { defaultRef: "main" },
      stub: {
        attachThread: async (...args: unknown[]) => {
          attached.push(args);
          return receiver.attachThread(...args);
        },
        detachThread: async (...args: unknown[]) => {
          detached.push(args);
          return { released: true };
        },
      },
    }),
    withLevels: async (_stub: unknown, pending: Promise<unknown>) => ({ result: await pending }),
    streamHeartbeatJson: async (pending: Promise<unknown>, render: (value: unknown) => unknown) =>
      Response.json(render(await pending)),
  });
  receiver = Object.assign(new Receiver(), {
    attachAdmissionsInFlight: 0,
    stepTrace: { run: (_trace: unknown, work: () => Promise<unknown>) => work() },
    attachThreadTraced: async (...args: unknown[]) => {
      traced.push(args);
      return { attached: true };
    },
  });
  const context = {
    callId: "11111111-1111-4111-8111-111111111111",
    actor: "operator",
    traceId: null,
    parentSourceId: null,
  };
  const owner = { runId: "run-request", ownerGen: "gen-request", ownerFence: 7 };
  return {
    attached,
    traced,
    detached,
    context,
    owner,
    attach: (body: Record<string, unknown>) =>
      handleAttach({}, { readonly: true, ...owner, ...body }, "trace", false, context) as Promise<Response>,
    detach: (body: Record<string, unknown>) => handleDetach({}, { ...owner, ...body }, context) as Promise<Response>,
  };
}
