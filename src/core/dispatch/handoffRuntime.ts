import type { ContextDependencies } from "../references/contextDependencies.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { HandoffConsumer, HandoffSource } from "./handoff.js";
import type { HandoffValidationDeps } from "./handoffValidation.js";

/** Composition supplies current grants, audience checks and internal storage.
 * The dispatcher never treats manifest shape as proof of source access. */
export interface HandoffAccess extends HandoffValidationDeps {
  captureDependencies(source: HandoffSource): Promise<ContextDependencies>;
  loadSource(source: HandoffSource): Promise<HandoffSource | undefined>;
}
export type HandoffAccessFactory = (input: {
  consumer: HandoffConsumer;
  msg: IncomingMessage;
  io: ChannelIO;
}) => HandoffAccess | Promise<HandoffAccess>;
