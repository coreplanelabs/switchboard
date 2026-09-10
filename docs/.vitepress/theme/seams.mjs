// The four seams and the dispatcher between them — stated once. Everything
// that draws them reads this file: the four-seam diagram (`npm run docs:gen`
// renders it from src/docs/diagrams.ts into README.md, Architecture and How a
// request flows; it finds each seam by id) and the landing page's seam row
// (LandingPage.vue, which shows them in this order). A seam's implementations
// are listed in the order the docs name them everywhere; `general` first
// because it is the default agent. Plain JS with a .d.mts twin, so the bot's
// generator and tests import it without the docs theme entering their program.

/** @type {ReadonlyArray<import("../../../src/docs/diagrams.js").Seam>} */
export const SEAMS = [
  {
    id: "channel",
    name: "Channel",
    role: "how a request arrives",
    lead: "Where a request comes from.",
    body: "An adapter turns a platform event into one message shape and a reply back into that platform's calls. It has no opinion about which agent runs, which model answers, or where a tool executes.",
    implementations: ["Slack", "CLI", "HTTP · MCP"],
    link: "/explanation/how-a-request-flows",
    cta: "How a request flows",
  },
  {
    id: "provider",
    name: "Provider",
    role: "the model",
    lead: "The model behind the agent.",
    body: "One adapter per vendor's API shape; an OpenAI-compatible endpoint is configuration, not code. A model is a provider/model string, resolved through the same layers as every other setting — per request, thread, person, channel.",
    implementations: ["Anthropic", "OpenAI-compatible"],
    link: "/how-to/add-a-provider",
    cta: "Add a provider",
  },
  {
    id: "executor",
    name: "Executor",
    role: "where tools run",
    lead: "Where tools run.",
    body: "The bot's own host, a per-thread sandbox, or an always-warm resident checkout of your repository. Agents call the executor and nothing else reaches the host — the blast radius is a configuration choice.",
    implementations: ["local", "sandbox", "resident"],
    link: "/explanation/execution-and-trust",
    cta: "Execution and trust",
  },
  {
    id: "agent",
    name: "Agent",
    role: "what runs",
    lead: "What runs.",
    body: "A system prompt, a toolset and a budget, kept as data in a registry. Five ship, and a new one is a registry entry — the dispatcher that runs them never changes.",
    implementations: ["general", "coding", "review", "ship", "research"],
    link: "/how-to/add-an-agent",
    cta: "Add an agent",
  },
];

/** The one component that is not a seam: it sits between them and decides. */
export const DISPATCHER = {
  name: "Dispatcher",
  does: ["directives", "config layers", "authorization"],
};

/** `Slack · CLI · HTTP · MCP` — a list as one line, the separator every diagram and card uses. */
export const listed = (items) => items.join(" · ");
