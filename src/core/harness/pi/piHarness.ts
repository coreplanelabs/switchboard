// pi as the contract's object (docs/reference/specs/harness.md item 7): the
// `Harness` the run loop is handed in production, over the loop that exists
// (`runPiHarnessOpen`, ./harness.ts) with pi's own settings — the deployment's
// compaction thresholds — behind it, so the loop hands every harness the same
// `HarnessDeps`. Its own module, not harness.ts's: the class calls the loop
// through the module boundary, so a test that spies on `runPiHarnessOpen` sees
// every run the object opens.

import type { Identity } from "../../../agents/registry.js";
import type { PiCompactionConfig } from "../../../config.js";
import type { Effort } from "../../../effort.js";
import {
  isPiFacts,
  type Finding,
  type Harness,
  type HarnessDeps,
  type HarnessFacts,
  type HarnessRun,
  type HarnessSession,
} from "../contract.js";
import { PI_EVENT_DISPOSITION } from "./bridge.js";
import { identityOrNothing, type HarnessContainer } from "../container.js";
import { locatePi, runPiHarnessOpen, type PiHarnessDeps } from "./harness.js";
import { piBuiltinToolsFor, piRunPathsAt, piThinkingLevel } from "./process.js";

/** What a deployment sets for every run on pi: the compaction thresholds pi's
 *  settings carry (`pi.compaction` in the config; harness-pi item 4). Absent,
 *  pi's defaults stand. */
export interface PiHarnessSettings {
  compaction?: PiCompactionConfig;
}

export class PiHarness implements Harness {
  readonly name = "pi";
  /** pi reads the session file the bot writes (`piSessionFile`) as its own history. */
  readonly history = "authored-session";
  readonly dispositions = PI_EVENT_DISPOSITION;

  constructor(private readonly settings: PiHarnessSettings = {}) {}

  effort(tier: Effort | undefined): string | undefined {
    return piThinkingLevel(tier);
  }

  builtinTools(identity: Identity): readonly string[] {
    return piBuiltinToolsFor(identity);
  }

  open(deps: HarnessDeps, run: HarnessRun): Promise<HarnessSession> {
    const piDeps: PiHarnessDeps = {
      ...deps,
      ...(this.settings.compaction ? { compaction: this.settings.compaction } : {}),
    };
    return runPiHarnessOpen(piDeps, run);
  }

  /** Where the row's pi is (harness-pi item 8): the container names itself
   *  once, then `locatePi` judges the row's word and the pid, the same steps
   *  `open` takes before a re-attach. Another harness's facts are answered
   *  without a command: nothing of that process is pi's to probe. */
  async find(facts: HarnessFacts, container: HarnessContainer): Promise<Finding> {
    if (!isPiFacts(facts)) return "another-harness";
    return locatePi(facts, container, await identityOrNothing(container));
  }

  /** The leftover pi a previous generation left behind, ended at the pid and
   *  root its facts name, best-effort like the session's end; a row without a
   *  root ends the pid alone. Only the caller knows whether this is the
   *  container the facts name (`find`), so it decides whether to call this. */
  async end(facts: HarnessFacts, container: HarnessContainer): Promise<void> {
    if (!isPiFacts(facts)) return;
    await container.kill(facts.pid).catch(() => {});
    if (facts.root !== undefined) await container.remove(piRunPathsAt(facts.root)).catch(() => {});
  }
}
