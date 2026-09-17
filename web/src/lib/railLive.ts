import type { HomeConversationRowSeed, RunIndexRowSeed } from "@core/channels/webSeed.js";
import { splitRunLabel } from "./format";

// The rail's live truth (docs/reference/specs/web-chat.md item 7): the page
// follows the runs index's own feed, narrowed to the viewer's runs
// (`/runs?stream=1&mine=1`), and reads it into the rail — which threads have a
// run in flight, how many, and a thread the seed did not know (a run started
// since the page loaded, on any channel). The seed's `live` flags are the
// picture at load; the feed's picture replaces them once it has replayed the
// active set. The same map gives the tab its live count: every run of the
// viewer's in flight anywhere, not only the open conversation's.

export interface LiveRun {
  threadKey: string;
  startedAt: number;
  label?: string;
  channelId?: string;
}

export interface RailLiveState {
  /** The viewer's runs in flight, by run id, as the feed last said. */
  runs: Map<string, LiveRun>;
  /** True once the feed has opened and replayed: from then on it is the truth about `live`. */
  connected: boolean;
}

export function railLiveState(): RailLiveState {
  return { runs: new Map(), connected: false };
}

/** One feed event into the map: a live upsert is kept, a finished one or a
 *  `removed` drops out, anything else is ignored. */
export function applyIndexEvent(state: RailLiveState, ev: { type?: string; run?: RunIndexRowSeed; id?: string }): void {
  if (ev.type === "upsert" && ev.run) {
    if (ev.run.finished || !ev.run.threadKey) state.runs.delete(ev.run.id);
    else
      state.runs.set(ev.run.id, {
        threadKey: ev.run.threadKey,
        startedAt: ev.run.startedAt,
        ...(ev.run.label !== undefined ? { label: ev.run.label } : {}),
        ...(ev.run.channelId !== undefined ? { channelId: ev.run.channelId } : {}),
      });
  } else if (ev.type === "removed" && ev.id) state.runs.delete(ev.id);
}

/** Live runs per thread key. */
export function liveByThread(state: RailLiveState): Map<string, LiveRun[]> {
  const out = new Map<string, LiveRun[]>();
  for (const run of state.runs.values()) {
    const list = out.get(run.threadKey) ?? [];
    list.push(run);
    out.set(run.threadKey, list);
  }
  return out;
}

/** The thread key a rail row names: a short id is a conversation of the viewer's
 *  lane, anything with a colon is the key itself. */
export function rowThreadKey(lane: string, rowId: string): string {
  return rowId.includes(":") ? rowId : `${lane}:${rowId}`;
}

function platformOf(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : "unknown";
}

/** The rail's rows as the feed knows them: the seed's rows with `live` and the
 *  run count corrected where the feed disagrees, and a row on top for each live
 *  thread the seed did not list (titled by the run's label snippet until a
 *  reload reads its request). Before the feed connects, the seed stands. */
export function liveRailRows(
  seedRows: readonly HomeConversationRowSeed[],
  state: RailLiveState,
  lane: string,
): HomeConversationRowSeed[] {
  if (!state.connected) return [...seedRows];
  const live = liveByThread(state);
  const seen = new Set<string>();
  const rows = seedRows.map((row) => {
    const key = rowThreadKey(lane, row.id);
    seen.add(key);
    const runs = live.get(key);
    if (!runs) return row.live ? { ...row, live: false } : row;
    // A live run the seed did not count (started since) adds to the row.
    const extra = row.live ? 0 : runs.length;
    return {
      ...row,
      live: true,
      runs: row.runs + extra,
      lastAt: Math.max(row.lastAt, ...runs.map((r) => r.startedAt)),
    };
  });
  const fresh: HomeConversationRowSeed[] = [];
  for (const [key, runs] of live) {
    if (seen.has(key)) continue;
    const newest = runs.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    const snippet = newest.label ? splitRunLabel(newest.label).snippet : undefined;
    fresh.push({
      id: key.startsWith(`${lane}:`) ? key.slice(lane.length + 1) : key,
      title: snippet ?? newest.label ?? key,
      excerpt: snippet ?? newest.label ?? key,
      lastAt: newest.startedAt,
      runs: runs.length,
      live: true,
      surface: platformOf(newest.channelId ?? key),
    });
  }
  fresh.sort((a, b) => b.lastAt - a.lastAt);
  return [...fresh, ...rows];
}
