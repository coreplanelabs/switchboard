// What the ship pipeline's two child rounds share (docs/reference/specs/agent-ship.md
// items 3–8): the resolved coordinates a child runs on, the prompt blocks
// composed into its system, the slice of the pipeline's input both rounds
// read, and the pipeline state a round is handed. The coding and review
// rounds each extend the slice with what only they use; `ShipPipelineInput`
// extends every slice, so the orchestrator's shape is the sum of its stages.

import type { AgentDef } from "../../agents/registry.js";
import type { Effort } from "../../effort.js";
import type { Provider } from "../../providers/types.js";
import type { ExecutorFactoryOptions } from "../../execution/factory.js";
import type { WebCapability } from "../../tools/web.js";
import type { GithubCapability } from "../../tools/github.js";
import type { SkillStore } from "../../skills/index.js";
import type { RunEvent } from "../runEvents.js";
import type { RunControl } from "../runRegistry.js";
import type { FollowUpInbox } from "../threadAdmission.js";
import type { ShipEntry } from "./preflight.js";

/** One child round's resolved coordinates: the child agent's def and the
 *  model/effort the config layers resolved FOR THAT AGENT (a `model:` or
 *  `effort:` directive on the ship request wins, like any request). */
export interface ShipChildSpec {
  agent: AgentDef;
  provider: Provider;
  /** `<provider>/<model>` as resolved — for the child's config-awareness block. */
  modelRef: string;
  model: string;
  effort?: Effort;
}

/** The advisory/system blocks composed into one child's prompt (the same seam
 *  the dispatcher uses: memory → config awareness → instructions → agent). */
export interface ShipBlocks {
  memory: string | undefined;
  config: string | undefined;
  /** The self-description block (routing-and-config behavior 11). */
  about?: string | undefined;
  instructions: string | undefined;
  skills: string | undefined;
}

/** The slice of the pipeline's input every child round reads: how to resolve
 *  and prompt the child, where it attaches, and the hooks its run drives. */
export interface ChildRoundDeps {
  /** Resolve one child round's agent/provider/model/effort. */
  child: (name: "coding" | "review") => ShipChildSpec;
  /** The prompt blocks for one child (skills are scoped per child agent). */
  blocks: (spec: ShipChildSpec) => ShipBlocks;
  factory: ExecutorFactoryOptions;
  threadKey: string;
  control: RunControl;
  /** The thread's follow-up inbox (docs/reference/specs/thread-admission.md): handed to
   *  every child round's runner so a reply during the pipeline is read by the
   *  child in flight at its next step. Absent (tests) → children run as
   *  without follow-ups. */
  inbox?: FollowUpInbox;
  /** Run-visibility event sink (registry + card refresh). */
  onEvent: (event: RunEvent) => void;
  onProgress: (note: string) => void;
  /** The card checklist hook children drive through update_status. */
  reportProgress: (checklist: string) => void;
  web?: WebCapability;
  skills?: SkillStore;
  /** The `github_*` tools' capability for the child runs (docs/reference/specs/github-tools.md). */
  githubTools?: GithubCapability;
  logKey: string;
}

/** The pipeline state a child round is handed: where it works, and how its
 *  agent's budgets are clipped to the pipeline's remaining wall clock. */
export interface ChildRoundContext {
  entry: ShipEntry;
  /** Never mutate the shared AgentDef — children run a clipped COPY. */
  clip: (def: AgentDef) => AgentDef;
}
