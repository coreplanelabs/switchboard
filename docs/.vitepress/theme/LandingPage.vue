<script setup lang="ts">
// The landing page: the pitch, the request flow, three doors in, the four
// seams, and the three pictures the visual pass will fill in. Everything it
// says about the product is also said, with its proof, on the page each link
// opens; this page only arranges it. The docs hub (README.md) renders below it.
import RequestFlow from "./RequestFlow.vue";

const seams = [
  {
    name: "Channel",
    lead: "Where a request comes from.",
    body: "An adapter turns a platform event into one message shape and a reply back into that platform's calls. It has no opinion about which agent runs, which model answers, or where a tool executes.",
    has: "Slack · CLI · HTTP · MCP",
    link: "/explanation/how-a-request-flows",
    cta: "How a request flows",
  },
  {
    name: "Provider",
    lead: "The model behind the agent.",
    body: "One adapter per vendor's API shape; an OpenAI-compatible endpoint is configuration, not code. A model is a provider/model string, resolved through the same layers as every other setting — per request, thread, person, channel.",
    has: "Anthropic · OpenAI-compatible",
    link: "/how-to/add-a-provider-or-agent#add-a-provider",
    cta: "Add a provider",
  },
  {
    name: "Executor",
    lead: "Where tools run.",
    body: "The bot's own host, a per-thread sandbox, or an always-warm resident checkout of your repository. Agents call the executor and nothing else reaches the host — the blast radius is a configuration choice.",
    has: "local · sandbox · resident",
    link: "/explanation/execution-and-trust",
    cta: "Execution and trust",
  },
  {
    name: "Agent",
    lead: "What runs.",
    body: "A system prompt, a toolset and a budget, kept as data in a registry. Five ship, and a new one is a registry entry — the dispatcher that runs them never changes.",
    has: "general · coding · review · ship · research",
    link: "/how-to/add-a-provider-or-agent#add-an-agent",
    cta: "Add an agent",
  },
];

const shots = [
  {
    caption: "A run in Slack: the mention, the status card that ticks while it works, the reply in the thread.",
    alt: "Screenshot of a Slack thread: a mention of the bot, its status card, and its reply.",
  },
  {
    caption: "The run page: every step timed — the model turns, the tool calls, the reply.",
    alt: "Screenshot of a run page on the dashboard: a timeline of the run's steps with their durations.",
  },
  {
    caption: "Residents: the repositories you onboard, kept warm, with the threads working in each.",
    alt: "Screenshot of the residents page on the dashboard: one card per onboarded repository.",
  },
];
</script>

<template>
  <!-- The page's main landmark: the default theme's home layout has none of its own. -->
  <main class="landing">
    <section class="hero">
      <p class="eyebrow">Open-source agent gateway</p>
      <h1 class="title">One gateway for the agents your team runs.</h1>
      <p class="lead">
        A message arrives in Slack, on the CLI, over HTTP or MCP. The dispatcher routes it to an agent, the agent runs
        on the model provider you choose, and its tools execute through an executor it never touches directly. The reply
        lands in the thread — or as a pull request.
      </p>
      <div class="actions">
        <a class="button brand" href="/tutorials/get-started">Get started</a>
        <a class="button alt" href="/how-to/deploy">Deploy</a>
        <a class="button alt" href="/explanation/design-decisions">Read the design</a>
      </div>
      <RequestFlow class="hero-flow" />
    </section>

    <section class="seams" aria-labelledby="seams-title">
      <h2 id="seams-title" class="section-title">Four seams, each with more than one implementation</h2>
      <p class="section-lead">
        Every boundary is an interface. A new capability is a new implementation behind one of them, never a special
        case in the core.
      </p>
      <ul class="grid">
        <li v-for="seam in seams" :key="seam.name" class="seam">
          <h3 class="seam-name">{{ seam.name }}</h3>
          <p class="seam-body">
            <strong>{{ seam.lead }}</strong> {{ seam.body }}
          </p>
          <p class="seam-has">{{ seam.has }}</p>
          <a class="seam-link" :href="seam.link">{{ seam.cta }} →</a>
        </li>
      </ul>
    </section>

    <section class="shots" aria-labelledby="shots-title">
      <h2 id="shots-title" class="section-title">What it looks like</h2>
      <ul class="strip">
        <li v-for="shot in shots" :key="shot.caption">
          <figure class="shot">
            <div class="frame" role="img" :aria-label="shot.alt">
              <span class="bar"></span>
              <span class="bar short"></span>
              <span class="bar"></span>
            </div>
            <figcaption>{{ shot.caption }}</figcaption>
          </figure>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.landing {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 24px;
}

@media (min-width: 640px) {
  .landing {
    padding: 0 48px;
  }
}

@media (min-width: 960px) {
  .landing {
    padding: 0 64px;
  }
}

/* Hero */
.hero {
  padding: 56px 0 24px;
}

@media (min-width: 960px) {
  .hero {
    padding: 88px 0 32px;
  }
}

.eyebrow {
  margin: 0 0 16px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

.title {
  margin: 0;
  max-width: 22ch;
  font-family: var(--sb-font-display);
  font-weight: 400;
  font-size: clamp(2.5rem, 2rem + 3vw, 4.5rem);
  line-height: 1.02;
  letter-spacing: -0.015em;
  color: var(--vp-c-text-1);
}

.lead {
  margin: 24px 0 0;
  max-width: 60ch;
  font-size: 1.125rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 32px 0 0;
}

.button {
  display: inline-block;
  padding: 0 22px;
  line-height: 44px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  transition:
    background-color 0.2s,
    border-color 0.2s,
    color 0.2s;
}

.button.brand {
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
}

.button.brand:hover {
  background: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}

.button.alt {
  border-color: var(--vp-c-border);
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-1);
}

.button.alt:hover {
  border-color: var(--vp-c-brand-3);
  color: var(--vp-c-brand-1);
}

.hero-flow {
  margin-top: 56px;
}

/* Sections */
.seams,
.shots {
  padding: 56px 0 0;
}

.section-title {
  margin: 0;
  font-family: var(--sb-font-display);
  font-weight: 400;
  font-size: clamp(1.75rem, 1.4rem + 1.5vw, 2.5rem);
  line-height: 1.1;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.section-lead {
  margin: 12px 0 0;
  max-width: 60ch;
  font-size: 1.0625rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

/* The seams */
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  margin: 32px 0 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 640px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 960px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

.seam {
  display: flex;
  flex-direction: column;
  padding: 22px 22px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-elv);
}

.seam-name {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.seam-body {
  margin: 12px 0 0;
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.seam-body strong {
  color: var(--vp-c-text-1);
  font-weight: 600;
}

.seam-has {
  margin: 16px 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-3);
}

.seam-link {
  margin-top: auto;
  padding-top: 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.seam-link:hover {
  color: var(--vp-c-brand-2);
  text-decoration: underline;
}

/* The pictures. Each frame keeps its 16:10 box whether or not an image is in
 * it, so the layout is the same before and after the visual pass. */
.strip {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
  margin: 32px 0 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 768px) {
  .strip {
    grid-template-columns: repeat(3, 1fr);
  }
}

.shot {
  margin: 0;
}

.frame {
  position: relative;
  aspect-ratio: 16 / 10;
  padding: 36px 16px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  overflow: hidden;
}

.frame::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 24px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-elv);
}

.frame::after {
  content: "";
  position: absolute;
  top: 8px;
  left: 12px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vp-c-border);
  box-shadow:
    14px 0 0 var(--vp-c-border),
    28px 0 0 var(--vp-c-border);
}

.bar {
  display: block;
  height: 10px;
  margin-top: 10px;
  border-radius: 5px;
  background: var(--vp-c-divider);
  width: 72%;
}

.bar.short {
  width: 44%;
}

figcaption {
  margin: 12px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
</style>
