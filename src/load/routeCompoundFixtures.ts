// The checked-in compound set of `load:route` (docs/reference/specs/
// load-harness.md item 17): twenty requests a person would type into Slack
// that carry two or more INDEPENDENT asks — neither part needs the other's
// result, each would stand alone — with the presets a right split names, and
// five decoys: one ask with several steps that reads as compound but is one
// request on one preset. The router's compound form is scored on this set on
// every run of the command (the conductor requests in the run history are few,
// and their parts are not on the record). A compound whose parts include a
// write preset (record 0034: a write ask is never a part, since a part runs as
// a child that only reads) is expected to route whole to that preset, single,
// and says so with `collapsesTo`; its parts stay listed as what a person sees
// in the request. Written in the house's voice: the repositories and surfaces
// a team has, the way asks arrive in a prompting channel.

/** One example: a compound with the expected parts' presets (two or more,
 *  order free), or a decoy with its one preset. */
export interface RouteCompoundFixture {
  id: string;
  kind: "compound" | "decoy";
  text: string;
  presets: readonly string[];
  /** Compounds only: the write preset the whole request routes to, single,
   *  because one of its parts needs it (the first such part). The router is
   *  scored on that answer, not on a split; a compound without it is scored on
   *  detection and its parts. */
  collapsesTo?: string;
}

export const ROUTE_COMPOUND_FIXTURES: readonly RouteCompoundFixture[] = [
  // Compounds: independent parts, different presets or two of the same.
  {
    id: "c01",
    kind: "compound",
    text: "review PR 1022 and also look into why the staging resident went down last night",
    presets: ["review", "research"],
  },
  {
    id: "c02",
    kind: "compound",
    text: "can you review https://github.com/acme/api/pull/1018 and, separately, fix the flaky admission test in acme/api — the one in src/core/admission.test.ts that times out on CI",
    presets: ["review", "coding"],
    collapsesTo: "coding",
  },
  {
    id: "c03",
    kind: "compound",
    text: "two things: what does Cloudflare charge for Durable Object storage these days, and how many open issues does acme/web have with the `bug` label",
    presets: ["research", "general"],
  },
  {
    id: "c04",
    kind: "compound",
    text: "look at PR 1034 in acme/api, and while you're at it time the full test suite on main in a cold sandbox — I want p50 numbers per shard",
    presets: ["review", "explore"],
  },
  {
    id: "c05",
    kind: "compound",
    text: "fix the typo in the README of acme/api (it says 'recieve'), and also tell me who last touched src/core/dispatch/route.ts",
    presets: ["coding", "general"],
    collapsesTo: "coding",
  },
  {
    id: "c06",
    kind: "compound",
    text: "summarize the last five releases of acme/web for me; unrelated, is Workers AI available in the EU region yet?",
    presets: ["general", "research"],
  },
  {
    id: "c07",
    kind: "compound",
    text: "review PR 1041 and PR 1042 in acme/api — they're independent PRs, different areas, one verdict each",
    presets: ["review", "review"],
  },
  {
    id: "c08",
    kind: "compound",
    text: "run the api suite on main in a sandbox and report which shards are slowest with numbers; also give me a summary of every open issue labelled `resident` in acme/api",
    presets: ["explore", "general"],
  },
  {
    id: "c09",
    kind: "compound",
    text: "need two things before the demo: bump the version string in acme/web's package.json to 1.3.0, and find out whether Slack's Block Kit supports collapsible sections now",
    presets: ["coding", "research"],
    collapsesTo: "coding",
  },
  {
    id: "c10",
    kind: "compound",
    text: "review https://github.com/acme/platform/pull/512; separately, dig into why the sandbox fleet reports fleet-busy around 3am UTC — run the load harness against it, numbers not guesses",
    presets: ["review", "explore"],
  },
  {
    id: "c11",
    kind: "compound",
    text: "what's the difference between Cloudflare Workflows and Durable Object alarms, and can you also list the open PRs in acme/api by author",
    presets: ["research", "general"],
  },
  {
    id: "c12",
    kind: "compound",
    text: "three asks: fix the broken link in docs/how-to/run-a-load-test.md in acme/api, review PR 1050 there, and tell me what pnpm 11 changed about workspace settings in package.json",
    presets: ["coding", "review", "research"],
    collapsesTo: "coding",
  },
  {
    id: "c13",
    kind: "compound",
    text: "please add a --json flag to `runs list` in acme/api, and also review PR 1055 (someone else's PR, unrelated to the flag)",
    presets: ["coding", "review"],
    collapsesTo: "coding",
  },
  {
    id: "c14",
    kind: "compound",
    text: "how does our resident deps store dedupe archives — read acme/api and explain it to me — and separately what is Anthropic's prompt-cache pricing for the 1h TTL",
    presets: ["general", "research"],
  },
  {
    id: "c15",
    kind: "compound",
    text: "profile the cold start of the sandbox path in acme/api end to end in a sandbox with timings, and also fix issue 1060 in acme/web (the null userName crash)",
    presets: ["explore", "coding"],
    collapsesTo: "coding",
  },
  {
    id: "c16",
    kind: "compound",
    text: "review PR 1063 in acme/api; and can you find out if GitHub's merge queue supports required checks per branch yet",
    presets: ["review", "research"],
  },
  {
    id: "c17",
    kind: "compound",
    text: "give me a summary of what's in acme/api's docs/decisions folder, and run its lint and typecheck on main in a sandbox to see if anything is red",
    presets: ["general", "explore"],
  },
  {
    id: "c18",
    kind: "compound",
    text: "unrelated pair: rename `formatLabel` to `formatLine` across acme/api and open the PR, and tell me who the top committers on acme/platform are",
    presets: ["coding", "general"],
    collapsesTo: "coding",
  },
  {
    id: "c19",
    kind: "compound",
    text: "review PR 1071 in acme/api and PR 88 in acme/cli — separate repos, separate reviews",
    presets: ["review", "review"],
  },
  {
    id: "c20",
    kind: "compound",
    text: "what does the `spawn.maxChildren` knob do in our config (read the spec in acme/api), and also check whether Depot's CI runners support arm64 yet",
    presets: ["general", "research"],
  },
  // Decoys: one ask with several steps — one request on one preset.
  {
    id: "d01",
    kind: "decoy",
    text: "clone acme/api, run the full suite on main, and tell me which tests fail and how long each shard took",
    presets: ["explore"],
  },
  {
    id: "d02",
    kind: "decoy",
    text: "fix the flaky admission test in acme/api: reproduce it first, then patch it, then run the suite to prove it, then open the PR",
    presets: ["coding"],
  },
  {
    id: "d03",
    kind: "decoy",
    text: "review PR 1022 — check the tests first, then the spec changes, then the migration note, and give me one verdict",
    presets: ["review"],
  },
  {
    id: "d04",
    kind: "decoy",
    text: "find out what changed in pnpm 11, compare it with what we pin in package.json, and recommend whether to upgrade",
    presets: ["research"],
  },
  {
    id: "d05",
    kind: "decoy",
    text: "list the open PRs in acme/api, group them by author, and tell me which ones are older than a week",
    presets: ["general"],
  },
];
