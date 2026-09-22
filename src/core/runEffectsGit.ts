// Production git adapters for the typed push effect. All shell strings here are
// runner-authored from closed command fields; no child-supplied executable,
// remote, refspec or flag crosses the port.

import type { Executor } from "../execution/executor.js";
import { shellQuote } from "../execution/shellQuote.js";
import { parseExitPrefix } from "./runEvents.js";
import type {
  EffectEnvelope,
  EffectResult,
  PreparedPushIntent,
  PublishPushRequest,
  PushCommand,
  PushFacts,
  PushGateReceipt,
  RunEffectsDeps,
} from "./runEffects.js";

export interface GitRunEffectsOptions {
  executor: Executor;
  actor: string;
  admittedRepository: string;
  admittedBranch?: string;
  admittedBase?: string | (() => Promise<string | undefined>);
  /** Closed changed-set gates from the repository's onboarded command table. */
  changedSetGates?: readonly { name: string; command: string }[];
  authorize(repository: string): Promise<boolean> | boolean;
  persistEnvelope(envelope: EffectEnvelope): Promise<EffectEnvelope>;
  priorResult(effectId: string): Promise<unknown>;
  persistPrepared(intent: PreparedPushIntent): Promise<PreparedPushIntent>;
  priorPrepared(effectId: string): Promise<unknown>;
  recordResult(result: EffectResult): Promise<void>;
  auditResult?(result: EffectResult): Promise<void>;
  occurredAt(): number;
}

const CLEAN_STATUS_MARKER = "__SWITCHBOARD_CLEAN__";
const DIRTY_STATUS_MARKER = "__SWITCHBOARD_DIRTY__";
const STATUS_COMMAND =
  `status=$(git status --porcelain) || exit $?; ` +
  `if [ -z "$status" ]; then printf '${CLEAN_STATUS_MARKER}\\n'; ` +
  `else printf '%s\\n${DIRTY_STATUS_MARKER}\\n' "$status"; fi`;

const outputLine = (output: string): string | undefined => {
  if (parseExitPrefix(output).failed) return undefined;
  const line = output
    .trim()
    .split(/\r?\n/)
    .find((part) => part.trim().length > 0);
  return line?.trim();
};

function cleanStatus(output: string): boolean {
  if (parseExitPrefix(output).failed) throw new Error("git status failed while resolving publication facts");
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(CLEAN_STATUS_MARKER)) return true;
  if (lines.includes(DIRTY_STATUS_MARKER)) return false;
  throw new Error("git status did not return its machine-readable cleanliness marker");
}

function remoteHeadFrom(output: string): string | undefined {
  const exit = parseExitPrefix(output);
  if (exit.failed) {
    // git ls-remote --exit-code reserves 2 for a successful query whose
    // pattern matched no ref. Every other non-zero is an unavailable read.
    if (exit.exitCode === 2) return undefined;
    throw new Error(`git ls-remote failed${exit.exitCode !== undefined ? ` with exit ${exit.exitCode}` : ""}`);
  }
  const published = outputLine(output)?.split(/\s+/)[0];
  return published && /^[0-9a-f]{40}$/i.test(published) ? published.toLowerCase() : undefined;
}

async function required(executor: Executor, command: string): Promise<string> {
  const output = await executor.exec(command);
  const exit = parseExitPrefix(output);
  if (exit.failed)
    throw new Error(`${command} failed${exit.exitCode !== undefined ? ` with exit ${exit.exitCode}` : ""}`);
  return output;
}

async function facts(executor: Executor, command: PushCommand): Promise<PushFacts> {
  const [endpointOut, branchOut, headOut, treeOut, statusOut, remoteOut] = await Promise.all([
    executor.exec("git remote get-url --push origin"),
    executor.exec("git symbolic-ref --quiet --short HEAD"),
    executor.exec("git rev-parse HEAD"),
    executor.exec("git rev-parse 'HEAD^{tree}'"),
    executor.exec(STATUS_COMMAND),
    executor.exec(`git ls-remote --exit-code origin ${shellQuote(`refs/heads/${command.branch}`)}`),
  ]);
  const endpoint = outputLine(endpointOut);
  const branch = outputLine(branchOut);
  const head = outputLine(headOut);
  const tree = outputLine(treeOut);
  if (!endpoint || !branch || !head || !tree)
    throw new Error("the admitted checkout's push facts could not be resolved");
  const remoteHead = remoteHeadFrom(remoteOut);
  return {
    repository: command.repository,
    endpoint,
    branch,
    head,
    tree,
    clean: cleanStatus(statusOut),
    ...(remoteHead ? { remoteHead } : {}),
  };
}

async function configuredBase(opts: GitRunEffectsOptions): Promise<string | undefined> {
  return typeof opts.admittedBase === "function" ? opts.admittedBase() : opts.admittedBase;
}

async function remoteHead(executor: Executor, destination: string): Promise<string | undefined> {
  return remoteHeadFrom(await executor.exec(`git ls-remote --exit-code origin ${shellQuote(destination)}`));
}

function changedSetGateCommands(opts: GitRunEffectsOptions): readonly { name: string; command: string }[] {
  const gates = opts.changedSetGates?.filter(
    (gate) => gate.name.trim().length > 0 && gate.command.trim().length > 0 && !/[\r\n\0]/.test(gate.command),
  );
  // An absent, empty or malformed command table is not permission to invent a
  // language-specific gate. Publication fails closed until the repository's
  // declared verification command is available.
  return gates?.length ? gates : [{ name: "declared-gates", command: "false" }];
}

export function gitRunEffectsDeps(opts: GitRunEffectsOptions): RunEffectsDeps {
  return {
    actor: opts.actor,
    occurredAt: opts.occurredAt,
    persistEnvelope: opts.persistEnvelope,
    priorResult: opts.priorResult,
    persistPrepared: opts.persistPrepared,
    priorPrepared: opts.priorPrepared,
    recordResult: opts.recordResult,
    ...(opts.auditResult ? { auditResult: opts.auditResult } : {}),
    resolvePush: (command) => facts(opts.executor, command),
    authorizePush: async (resolved, command) => {
      const base = await configuredBase(opts);
      return (
        command.repository === opts.admittedRepository &&
        (opts.admittedBranch === undefined
          ? base === undefined || command.branch !== base
          : command.branch === opts.admittedBranch) &&
        (base === undefined || command.base === base) &&
        resolved.repository === opts.admittedRepository &&
        (await opts.authorize(resolved.repository))
      );
    },
    rebasePush: async (_resolved, command) => {
      await required(opts.executor, `git fetch origin ${shellQuote(command.base)}`);
      await required(opts.executor, `git rebase ${shellQuote(`origin/${command.base}`)}`);
      return facts(opts.executor, command);
    },
    runPushGates: async (resolved, gateSet) => {
      if (gateSet !== "changed-set") return [];
      const gates = changedSetGateCommands(opts);
      const receipts: PushGateReceipt[] = [];
      for (const gate of gates) {
        const output = await opts.executor.exec(gate.command);
        const exit = parseExitPrefix(output);
        const current = await facts(opts.executor, {
          kind: "push",
          repository: resolved.repository,
          branch: resolved.branch,
          expectedHead: resolved.head,
          base: (await configuredBase(opts)) ?? "main",
          gateSet,
        });
        receipts.push({
          name: gate.name,
          exitCode: exit.exitCode ?? (exit.failed ? 1 : 0),
          tree: current.tree,
          clean: current.clean,
          tool: gate.command,
        });
        if (exit.failed) break;
      }
      return receipts;
    },
    reconcilePush: async (request: PublishPushRequest) => remoteHead(opts.executor, request.destination),
    publishPush: async (request: PublishPushRequest) => {
      if (!opts.executor.publishGit) throw new Error("the executor has no runner-owned git publication capability");
      return opts.executor.publishGit(request);
    },
  };
}
