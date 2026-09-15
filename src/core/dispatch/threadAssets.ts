// The thread's files (record 0033; docs/reference/specs/execution.md item 20):
// one catalogue, read one way, rendered three ways. The runs' `artifact` events
// are the catalogue of what a thread received and produced — the record is
// the access list, a file no run recorded is not reachable, and nothing here
// lists the store or copies the facts anywhere else. `readThreadAssets` reads
// it once: every run of the thread, every page of every record, one entry per
// key, then one HEAD per key. The re-pull into `attachments/`, the prompt's
// FILES OF THIS THREAD block and `recall` all render that one read.
//
// A leaf module on purpose: the tools import it, and the web app's typecheck
// walks the tools' imports — nothing here reaches the dispatcher's runtime.
import type { ArtifactStore } from "../../artifacts/store.js";
import type { RunEvent } from "../runEvents.js";
import type { RunListCursor, RunView, RunsService } from "../runsService.js";
import { formatSize, type ThreadArtifact } from "./staging.js";

/** One file of the thread: received on one of its messages (`in`) or produced
 *  by one of its runs (`out`), as the run records name it, and whether the
 *  store still holds it (`held`, from `ThreadArtifact`). */
export interface ThreadAsset extends ThreadArtifact {
  direction: "in" | "out";
  /** The run whose record first names the key (a re-pulled file is named again by later runs). */
  runId: string;
  /** The run's `artifact` event's position in its record, when the record has one. */
  seq?: number;
}

/** How many of the thread's runs one page of the catalogue read brings back. */
export const THREAD_ASSETS_PAGE = 50;

/** Pure: the catalogue from the runs' events, oldest run first and in event
 *  order, one entry per key — the run that first recorded a key owns the
 *  entry, and a later run naming the same key (a re-pull) adds nothing. */
export function threadAssetsOf(
  runsOldestFirst: ReadonlyArray<{ id: string; events: readonly RunEvent[] }>,
): Omit<ThreadAsset, "held">[] {
  const seen = new Set<string>();
  const out: Omit<ThreadAsset, "held">[] = [];
  for (const run of runsOldestFirst) {
    for (const e of run.events) {
      if (e.type !== "artifact" || seen.has(e.key)) continue;
      seen.add(e.key);
      out.push({
        key: e.key,
        name: e.name,
        size: e.size,
        contentType: e.contentType,
        direction: e.direction,
        runId: run.id,
        ...(e.seq !== undefined ? { seq: e.seq } : {}),
      });
    }
  }
  return out;
}

/** The thread's files in one read: every run of the thread — paged past the
 *  first page, since a thread that has run for weeks holds more runs than one
 *  page lists — each record paged to its end, since a file dropped on a steer
 *  lands wherever in the log the steer did; the `artifact` events, `in` and
 *  `out`, one entry per key, oldest run first; then the store asked by HEAD,
 *  once per key, whether it still holds the object. A page that fails or is
 *  refused stops that read where it stands and the log says so: a store
 *  hiccup costs an incomplete list, never the request. */
export async function readThreadAssets(
  deps: { runs: Pick<RunsService, "listRuns" | "getRunEvents">; store: Pick<ArtifactStore, "head"> },
  threadKey: string,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<ThreadAsset[]> {
  const runs: RunView[] = [];
  let before: RunListCursor | undefined;
  try {
    for (;;) {
      const page = await deps.runs.listRuns({
        status: "all",
        visibleTo: { kind: "all" },
        threadKey,
        limit: THREAD_ASSETS_PAGE,
        ...(before !== undefined ? { before: before.finishedAt, beforeId: before.id } : {}),
      });
      runs.push(...page.runs);
      // A store the list could not reach answers live rows only, without
      // throwing: the catalogue is what those rows name, and the log says so.
      if (page.storeUnavailable) {
        warn(
          `[thread] ${threadKey}: listing its runs for their files answered live rows only after ${runs.length} run(s) — the run store was unavailable`,
        );
        break;
      }
      if (page.nextBefore === undefined) break;
      before = page.nextBefore;
    }
  } catch (err) {
    warn(
      `[thread] ${threadKey}: listing its runs for their files stopped after ${runs.length} run(s) — ${describe(err)}`,
    );
  }
  const perRun: { id: string; events: RunEvent[] }[] = [];
  for (const run of runs.reverse()) {
    const events: RunEvent[] = [];
    let afterSeq: number | undefined;
    try {
      for (;;) {
        const r = await deps.runs.getRunEvents(run.id, afterSeq === undefined ? {} : { afterSeq });
        if (!r.ok) {
          warn(`[thread] ${run.id}: reading its files stopped after ${events.length} event(s) — ${r.error}`);
          break;
        }
        events.push(...r.value.events);
        if (r.value.nextAfterSeq === undefined) break;
        afterSeq = r.value.nextAfterSeq;
      }
    } catch (err) {
      warn(`[thread] ${run.id}: reading its files failed after ${events.length} event(s) — ${describe(err)}`);
    }
    perRun.push({ id: run.id, events });
  }
  return Promise.all(
    threadAssetsOf(perRun).map(async (asset): Promise<ThreadAsset> => {
      try {
        return { ...asset, held: (await deps.store.head(asset.key)) !== null };
      } catch (err) {
        warn(`[thread] ${asset.key}: the store could not be asked whether it holds it — ${describe(err)}`);
        return asset;
      }
    }),
  );
}

/** One file as the prompt and `recall` describe it, the same words in both:
 *  its name, size and type, whether the thread received or a run produced it,
 *  and where it is for this run. `path` is the workspace path this run staged
 *  it under, if any (`WorkspaceFiles`). */
export function describeAsset(asset: ThreadAsset, path: string | undefined): string {
  const what = `${asset.name} (${formatSize(asset.size)}, ${asset.contentType})`;
  const origin = asset.direction === "in" ? "received on this thread" : `produced by run ${asset.runId}`;
  return `${what} — ${origin}; ${whereIs(asset, path)}`;
}

/** Where a file is for this run, one clause: in the workspace when this run
 *  pulled it, gone when the store no longer holds it, unknown when the store
 *  could not be asked, on its run's page for a produced file, in the store
 *  for a received one this run did not pull. */
export function whereIs(asset: ThreadAsset, path: string | undefined): string {
  if (path !== undefined) return `in this workspace at ./${path}`;
  if (asset.held === false) return "no longer in the store (its retention passed)";
  if (asset.held === undefined) return "the store could not be asked whether it still holds it";
  return asset.direction === "out"
    ? "on that run's page, not in this workspace"
    : "in the store, not in this workspace";
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
