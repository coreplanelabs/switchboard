// The filed misses of `load:route` (docs/reference/specs/load-harness.md
// item 17): the nineteen distinct router misses people filed, rewritten
// without names, ids or org slugs, each carrying the bind the person meant —
// a registry command with its input, or the preset a right route names. Some
// were never the model's to miss: a directive regex, a typed-line grammar and
// a repository token scan each read a slice of the request before or after
// the model and outranked it; the rest were the model misreading words it
// could see. The misses row replays each fixture and holds the router to
// binding every one as the person meant. Neutral names only (acme/…, r-N,
// mem:…): the public tree carries no private references.

interface RouteMissBase {
  id: string;
  text: string;
  /** The repository the thread names, put on the router's user turn as
   *  production puts it there. */
  threadRepo?: string;
  /** Conversations the text links that the bot could quote — the count the
   *  route stage puts on the user turn; the replay hands it to `route()`. */
  references?: number;
}

/** One filed miss with the bind the person meant: a command and its input
 *  (compared after `parseInput` on both sides), or the presets a right route
 *  names. */
export type RouteMissFixture =
  | (RouteMissBase & {
      meant: "command";
      command: string;
      input: { args?: readonly unknown[]; options?: Record<string, unknown> };
    })
  | (RouteMissBase & { meant: "preset"; presets: readonly string[] });

const cmd = (
  id: string,
  text: string,
  command: string,
  input: { args?: readonly unknown[]; options?: Record<string, unknown> },
  over: Partial<RouteMissBase> = {},
): RouteMissFixture => ({ id, text, meant: "command", command, input, ...over });

const preset = (
  id: string,
  text: string,
  presets: readonly string[],
  over: Partial<RouteMissBase> = {},
): RouteMissFixture => ({ id, text, meant: "preset", presets, ...over });

export const ROUTE_MISS_FIXTURES: readonly RouteMissFixture[] = [
  // A repository whose name the old token scan refused (a dot in the name),
  // so the router named another repository or none.
  cmd("m01", "run the tests in acme/pipeline.js on main", "repo.test", { args: ["acme/pipeline.js", "main"] }),
  // The thread named the repository; the scan read a different token in the
  // text and outranked it.
  cmd(
    "m02",
    "run the build on main",
    "repo.build",
    { args: ["acme/data-load", "main"] },
    { threadRepo: "acme/data-load" },
  ),
  // A typed directive skipped the model, so the sentence after it never
  // routed: the person disowned the preset in the same breath.
  cmd("m03", "agent:general forget the preset — stop run r-31 first, hard", "runs.stop", {
    args: ["r-31"],
    options: { mode: "hard" },
  }),
  // A typed command line a grammar parser read before the model, binding the
  // wrong scope.
  cmd("m04", "config set channel effort high", "config.set", { args: ["channel"], options: { effort: "high" } }),
  // "Forget" read as small talk; the person named the record.
  cmd("m05", "please forget the record mem:user:7, it is stale", "memory.forget", { args: ["mem:user:7"] }),
  // A question about run history bound to nothing.
  cmd("m06", "show me yesterday's runs", "runs.list", {}),
  // A fleet-state question routed to a preset instead of the registry read.
  cmd("m07", "is there a warm resident for acme/api right now?", "repo.list", {}),
  // A reply into a live thread was folded into the running turn before any
  // model saw it; the person meant new write work.
  preset("m08", "actually, also add a retry to the fetch helper", ["ship"]),
  // Terse assent read as chatter.
  preset("m09", "ship it", ["ship"]),
  // "Review … and land it" split as a compound; a write ask is never a part.
  preset("m10", "review the failing-test fix and land it if it is green", ["ship"]),
  // A small docs edit read as a question.
  preset("m11", "can you fix the typo on the getting-started page", ["ship"]),
  // A diagnosis question sent to the write preset.
  preset("m12", "the ci on acme/api is red — why?", ["research", "general", "explore"]),
  // An outcome sentence with no verb of change routed read-only.
  preset("m13", "the dashboard should load in under a second; make that true", ["ship"]),
  // A what-would-it-take question misread as an order.
  preset("m14", "what would it take to add rate limiting to the api?", ["general", "research"]),
  // The task lived in the linked conversation; the link read as something to
  // read first and the ask routed read-only.
  preset("m15", "in acme/web ship what the linked thread describes", ["ship"], { references: 1 }),
  // A pull request named casually routed to the write preset.
  preset("m16", "take a look at https://github.com/acme/api/pull/88 when you get a chance", ["review"]),
  // An ask only a sandbox answers, routed to a chat-only preset.
  preset("m17", "run the whole verify in acme/api and tell me what breaks", ["explore"]),
  // A write ask in a named repository drew a question instead of the write
  // preset; the unresolved detail (which repo holds the workflow to copy) was
  // the coding run's to resolve with the org in front of it.
  preset("m18", "in acme/company add the lgtm github action like you see in other org repos", ["ship"]),
  // The answer to that question, joined back onto the original ask (the shape
  // the door routes on a floor): the joined line is a complete write ask,
  // never an unclear fragment for the fallback preset.
  preset(
    "m19",
    "in acme/company add the lgtm github action like you see in other org repos — Which repo has the lgtm action you want copied?: acme/tools is the repo",
    ["ship"],
  ),
];
