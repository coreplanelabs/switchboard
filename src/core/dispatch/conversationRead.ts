import { parseDirectives } from "../../directives.js";
import type { IncomingMessage } from "../types.js";
import type { SpawnBinding, SpawnRequest } from "./spawn.js";
import {
  operatorTurnContext,
  parseOperatorTurn,
  prepareActionContext,
  OPERATOR_BIND_TOOL,
  type ActionContextDeps,
} from "./operator.js";

/** Use the existing action binder before handing a selected read task to spawn. */
export async function bindConversationRead(
  deps: Pick<ActionContextDeps, "config" | "runLedger">,
  message: IncomingMessage,
  request: SpawnRequest,
  prTarget?: unknown,
): Promise<SpawnBinding> {
  // The front-door directives select this parent. The child retains the
  // parent's remaining lease and uses the spawn tool's narrower settings.
  const msg = { ...message, text: parseDirectives(message.text).text };
  const prepared = await prepareActionContext(deps, { msg });
  const parsed = parseOperatorTurn(
    {
      tool: OPERATOR_BIND_TOOL,
      input: {
        preset: request.preset,
        ...(request.repo ? { repo: request.repo } : {}),
        prTarget,
        reason: "Selected by the orchestrator",
      },
    },
    operatorTurnContext(prepared.input),
  );
  if (parsed.kind !== "decision" || parsed.decision.kind !== "binds")
    return {
      kind: "refused",
      message: parsed.kind === "violation" ? parsed.violation : "The read task did not bind an action.",
    };
  const bind = parsed.decision.binds[0];
  if (!bind || bind.preset !== request.preset)
    return { kind: "refused", message: "The read task did not bind its selected preset." };
  return {
    kind: "bound",
    request: {
      ...request,
      ...(bind.repo ? { repo: bind.repo } : {}),
      ...(bind.prTarget ? { prompt: `${request.prompt}\n\nSelected pull request: ${bind.prTarget.quote}` } : {}),
    },
    ...(bind.repo ? { target: { repo: bind.repo, ...(bind.prTarget ? { prTarget: bind.prTarget } : {}) } } : {}),
  };
}
