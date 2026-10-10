import type { UnitRunRowSeed, WebSeed } from "@core/channels/webSeed.js";
import { createPrReviewCollector } from "../../src/lib/prReviewCollector";
/** Only recorded artifacts from an authorized child establish a local diff destination. */
export async function recordedPullRequestRun(
  runs: readonly UnitRunRowSeed[],
  repo: string,
  number: number,
  load: (address: string) => Promise<WebSeed | null>,
): Promise<{ kind: "found"; href: string; head: string } | { kind: "missing" | "unavailable"; searched: number }> {
  const candidates = [...runs]
    .filter((run) => run.finished)
    .reverse()
    .slice(0, 20);
  let unavailable = false;
  for (const run of candidates) {
    let seed: WebSeed | null;
    try {
      seed = await load(`/runs/${encodeURIComponent(run.id)}`);
    } catch {
      unavailable = true;
      continue;
    }
    if (!seed) {
      unavailable = true;
      continue;
    }
    if (seed?.page !== "run" || seed.mode !== "history") continue;
    const collector = createPrReviewCollector();
    for (const event of seed.events) collector.handle(event);
    if (
      collector.state.ready &&
      collector.state.pr.repo === repo &&
      collector.state.pr.number === number &&
      collector.state.pr.headSha
    )
      return {
        kind: "found",
        href: `/runs/${encodeURIComponent(run.id)}?view=pull-request`,
        head: collector.state.pr.headSha,
      };
  }
  return { kind: unavailable ? "unavailable" : "missing", searched: candidates.length };
}
