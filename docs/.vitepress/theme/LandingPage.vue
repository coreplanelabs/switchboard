<script setup lang="ts">
// The landing page: a headline, one sentence, two buttons and the install line;
// then the dashboard, large — the run page first, then three statements each
// beside the picture it is about; a thread drawn in CSS; the four seams in one
// row; the three commands that take a reader from a terminal to production.
// Everything it says about the product is also said, with its proof, on the
// page each link opens; this page only arranges it. The docs hub (README.md)
// renders below it.
import { ref } from "vue";
import { useData } from "vitepress";
// The project's facts — its repository and the package it publishes — come
// from the same file config.ts reads, never a copy typed here
// (`check:project-facts`).
import project from "../../../project.json";
// The pictures are rendered from the fixture preview by `npm run
// screenshots:gen` (docs/public/screenshots/, one file per theme); a frame
// shows the one for the site's appearance.
import { SHOTS, shotSrc } from "./screenshots.mjs";
// The seams' one statement — the same file the four-seam diagram in the README
// and the docs is drawn from; the row shows them in the file's order.
import { listed, SEAMS } from "./seams.mjs";

// The product's name is the site title, which the config reads from
// project.json's `displayName` — one fact, no copy here; `check:site` proves
// the built hero carries it.
const { site } = useData();

// The pictures are 1440×900 rendered at 2× (the manifest's viewport), so the
// frames reserve that shape before an image arrives and the layout never moves.
const PICTURE = { width: 2880, height: 1800 };

/** A picture by its file stem, or a build that fails naming the missing one. */
function picture(name: string) {
  const shot = SHOTS.find((s) => s.name === name);
  if (!shot) throw new Error(`landing: no picture named "${name}" in screenshots.mjs`);
  return shot;
}

const hero = picture("run-page");

// One statement per picture: the first clause in ink, the second in grey, and
// the page that proves it. The picture sits right, then left, then right, and
// is cropped from the top to the aspect ratio its content fills — the fixture's
// runs index and residents are a few rows; the spend page runs deeper.
const stories = [
  {
    shot: picture("runs-index"),
    crop: "5 / 2",
    lead: "Every run, accounted for.",
    rest: "Live and finished, with the agent, the duration and a stop button.",
    link: "/how-to/watch-a-run",
    cta: "Watch a run",
    side: "right",
  },
  {
    shot: picture("residents"),
    crop: "5 / 2",
    lead: "Repos kept warm.",
    rest: "Onboard a repository once; every thread works in a checkout that is already there.",
    link: "/how-to/onboard-a-repo",
    cta: "Onboard a repo",
    side: "left",
  },
  {
    shot: picture("costs"),
    crop: "2 / 1",
    lead: "Spend you can see.",
    rest: "Per agent, per model, per day — on the dashboard, not the invoice.",
    link: "/how-to/check-spend",
    cta: "Check spend",
    side: "right",
  },
];

// The thread is drawn, not captured: the fixture's made-up workspace, the
// bot's mention and its status card, so the page carries no real conversation.
// Its statement is data like the pictures' — a literal text node after the
// inked span loses its leading space at hydration; an interpolation keeps it.
const threadStory = {
  lead: "Ask in the thread.",
  rest: "The status card fills in as the agent works; the reply lands beneath it.",
  link: "/tutorials/first-request-in-slack",
  cta: "Your first request",
};
const thread = {
  pr: "acme/web#128",
  steps: ["Cloned acme/web at 3f9c1e2", "Read the diff — 14 files", "Checked the specs the change touches"],
  working: "Writing the review",
  reply: "Review posted: two findings, one minor.",
};

const install = `npx ${project.npmPackage} init`;
const commands = [install, `npx ${project.npmPackage} ask "what can you do?"`, `npx ${project.npmPackage} deploy all`];

const copied = ref(false);
async function copy() {
  await navigator.clipboard.writeText(install);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1600);
}
</script>

<template>
  <!-- The page's main landmark: the default theme's home layout has none of its own. -->
  <main class="landing">
    <section class="hero">
      <div class="wrap">
        <p class="eyebrow">
          <span class="product">{{ site.title }}</span> · open-source agent gateway
        </p>
        <h1 class="title">Your agents,<br class="break" />one mention away.</h1>
        <p class="lead">
          Mention it in Slack or call it over the CLI, HTTP or MCP — an agent answers on the model you choose.
        </p>
        <div class="actions">
          <a class="button brand" href="/tutorials/get-started">Get started</a>
          <a class="button alt" :href="project.repository">GitHub</a>
        </div>
        <div class="install">
          <code class="command">{{ install }}</code>
          <button type="button" class="copy" :class="{ done: copied }" aria-live="polite" @click="copy">
            {{ copied ? "Copied" : "Copy" }}
          </button>
        </div>
      </div>

      <div class="wrap">
        <!-- The one picture above the fold. The two images are one per appearance
             and the site's `dark` class on <html> shows one. Both are lazy: the
             hidden one has no box, never intersects the viewport and is not
             fetched (an eager image is fetched even when hidden); the shown one
             sits in the first viewport, so it loads at first layout, ahead of
             every other image. -->
        <figure class="frame hero-frame">
          <div class="bar" aria-hidden="true"><span class="dots"></span><span class="url">/runs/…</span></div>
          <img
            class="light"
            :src="shotSrc(hero.name, 'light')"
            :alt="hero.alt"
            :width="PICTURE.width"
            :height="PICTURE.height"
            fetchpriority="high"
            loading="lazy"
          />
          <img
            class="dark"
            :src="shotSrc(hero.name, 'dark')"
            :alt="hero.alt"
            :width="PICTURE.width"
            :height="PICTURE.height"
            fetchpriority="high"
            loading="lazy"
          />
        </figure>
        <p class="caption">The run page: the model turns, the tool calls, the reply — every step timed.</p>
      </div>
    </section>

    <section v-for="story in stories" :key="story.shot.name" class="split" :class="story.side">
      <div class="wrap">
        <div class="statement">
          <p class="two-tone">
            <span class="ink">{{ story.lead }}</span> {{ story.rest }}
          </p>
          <a class="more" :href="story.link">{{ story.cta }} →</a>
        </div>
        <figure class="frame picture" :style="{ '--crop': story.crop }">
          <div class="bar" aria-hidden="true"><span class="dots"></span></div>
          <img
            class="light"
            :src="shotSrc(story.shot.name, 'light')"
            :alt="story.shot.alt"
            :width="PICTURE.width"
            :height="PICTURE.height"
            loading="lazy"
          />
          <img
            class="dark"
            :src="shotSrc(story.shot.name, 'dark')"
            :alt="story.shot.alt"
            :width="PICTURE.width"
            :height="PICTURE.height"
            loading="lazy"
          />
        </figure>
      </div>
    </section>

    <section class="split left" aria-label="A request in a thread">
      <div class="wrap">
        <div class="statement">
          <p class="two-tone">
            <span class="ink">{{ threadStory.lead }}</span> {{ threadStory.rest }}
          </p>
          <a class="more" :href="threadStory.link">{{ threadStory.cta }} →</a>
        </div>
        <div
          class="thread"
          role="img"
          aria-label="A thread: a person mentions the bot on a pull request, the bot's status card ticks through its steps, and the bot replies with the review posted."
        >
          <div class="msg">
            <span class="avatar person" aria-hidden="true">a</span>
            <div class="body">
              <p class="meta"><span class="who">alice</span><span class="when">9:41</span></p>
              <p class="text">
                <span class="mention">@{{ project.name }}</span> agent:review <span class="pr">{{ thread.pr }}</span>
              </p>
            </div>
          </div>
          <div class="msg">
            <span class="avatar bot" aria-hidden="true">{{ site.title.slice(0, 1) }}</span>
            <div class="body">
              <p class="meta">
                <span class="who">{{ site.title }}</span
                ><span class="tag">app</span><span class="when">9:41</span>
              </p>
              <div class="card">
                <p class="card-title">review · {{ thread.pr }}</p>
                <ul class="steps">
                  <li v-for="step in thread.steps" :key="step" class="done">
                    <svg class="tick" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 8.5 6.5 12 13 4.5" />
                    </svg>
                    {{ step }}
                  </li>
                  <li class="working"><span class="ring" aria-hidden="true"></span>{{ thread.working }}…</li>
                </ul>
                <p class="card-link">Run page →</p>
              </div>
            </div>
          </div>
          <div class="msg">
            <span class="avatar bot" aria-hidden="true">{{ site.title.slice(0, 1) }}</span>
            <div class="body">
              <p class="meta">
                <span class="who">{{ site.title }}</span
                ><span class="tag">app</span><span class="when">9:44</span>
              </p>
              <p class="text">
                {{ thread.reply }} <span class="pr">{{ thread.pr }}</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="seams" aria-label="The four seams">
      <ul class="wrap row">
        <li v-for="seam in SEAMS" :key="seam.id">
          <a class="seam" :href="seam.link">
            <span class="term">{{ seam.name }}</span>
            <span class="gloss">{{ listed(seam.implementations) }}</span>
          </a>
        </li>
      </ul>
    </section>

    <section class="closing" aria-label="Install">
      <div class="wrap">
        <pre
          class="terminal"
        ><code><span v-for="command in commands" :key="command" class="line"><span class="prompt" aria-hidden="true">$ </span>{{ command }}</span></code></pre>
        <p class="caption">Terminal, Slack, production — the same pipeline.</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* The landing is the full page width; `.wrap` is the measure the hub below
 * shares (VPHomeContent: 1280px, the same paddings). A picture may bleed past
 * the measure toward the viewport edge by `--bleed`; the clip keeps the page
 * from ever scrolling sideways for it. */
.landing {
  --bleed: 0px;
  overflow-x: clip;
}

.wrap {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 24px;
}

@media (min-width: 640px) {
  .wrap {
    padding: 0 48px;
  }
}

@media (min-width: 960px) {
  .wrap {
    padding: 0 64px;
  }

  .landing {
    /* From the measure's content edge (1152px wide) to 32px short of the viewport edge. */
    --bleed: clamp(0px, calc((100vw - 1152px) / 2 - 32px), 160px);
  }
}

/* Hero */
.hero {
  position: relative;
  padding: 64px 0 0;
}

@media (min-width: 960px) {
  .hero {
    padding: 104px 0 0;
  }
}

/* A hairline texture behind the hero: diagonal lines at a few percent of ink,
 * fading out before the picture. */
.hero::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: repeating-linear-gradient(-60deg, var(--sb-c-hairline) 0 1px, transparent 1px 18px);
  mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.9), transparent 80%);
  pointer-events: none;
}

.eyebrow {
  margin: 0 0 20px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

/* The product's name keeps its own casing inside the uppercase eyebrow. */
.eyebrow .product {
  text-transform: none;
  font-weight: 600;
}

.title {
  margin: 0;
  font-family: var(--sb-font-display);
  font-variation-settings: var(--sb-display-settings);
  font-weight: 600;
  font-size: clamp(2.75rem, 1.25rem + 5.6vw, 6.25rem);
  line-height: 0.98;
  letter-spacing: -0.035em;
  color: var(--vp-c-text-1);
}

/* On a phone the headline wraps where it must; from tablet up it is two lines. */
.break {
  display: none;
}

@media (min-width: 640px) {
  .break {
    display: inline;
  }
}

.lead {
  margin: 28px 0 0;
  max-width: 44ch;
  font-size: clamp(1.125rem, 1rem + 0.5vw, 1.375rem);
  line-height: 1.45;
  color: var(--vp-c-text-2);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 36px 0 0;
}

.button {
  display: inline-block;
  padding: 0 24px;
  line-height: 48px;
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

.install {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  margin: 20px 0 0;
  padding: 6px 6px 6px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-elv);
}

.command {
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  white-space: nowrap;
  color: var(--vp-c-text-1);
}

.copy {
  flex: none;
  padding: 0 12px;
  line-height: 30px;
  border: 0;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition:
    background-color 0.2s,
    color 0.2s;
}

.copy:hover {
  color: var(--vp-c-text-1);
}

.copy.done {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

/* Frames: a window bar over the picture, a soft shadow under it. The image
 * keeps its own 16:10 through width/height, so the box is sized before it
 * arrives. The two images are one per appearance; the site's `dark` class on
 * <html> picks. */
.frame {
  position: relative;
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--sb-frame-shadow);
  overflow: hidden;
}

.hero-frame {
  margin-top: 64px;
}

@media (min-width: 960px) {
  .hero-frame {
    margin-top: 88px;
  }
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 16px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.dots {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--vp-c-border);
  box-shadow:
    16px 0 0 var(--vp-c-border),
    32px 0 0 var(--vp-c-border);
  margin-right: 32px;
}

.url {
  flex: 1;
  max-width: 320px;
  padding: 0 12px;
  line-height: 24px;
  border-radius: 6px;
  background: var(--vp-c-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.frame img {
  display: block;
  width: 100%;
  height: auto;
}

.frame img.dark {
  display: none;
}

/* Beside a statement the picture is cropped from the top to the ratio its
 * story sets (`--crop`), and the frame stays sized from it before the image
 * arrives. */
.picture img {
  aspect-ratio: var(--crop);
  object-fit: cover;
  object-position: top;
}

/* Vue scopes a selector as a whole, so the appearance rule — keyed on the
 * `dark` class VitePress stamps on <html>, outside this component — is written
 * global and anchored on the landing's own root class. */
:global(.dark .landing .frame img.light) {
  display: none;
}

:global(.dark .landing .frame img.dark) {
  display: block;
}

.caption {
  margin: 16px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-3);
}

/* Statement + picture. Stacked on a phone; from 960px a 5:7 grid with the
 * picture bleeding toward the viewport edge on its side. */
.split {
  padding: 80px 0 0;
}

@media (min-width: 960px) {
  .split {
    padding: 128px 0 0;
  }

  .split .wrap {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    gap: 64px;
    align-items: center;
  }

  .split.left .wrap {
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  }

  .split.left .statement {
    order: 2;
  }

  .split.right .picture {
    margin-right: calc(-1 * var(--bleed));
  }

  .split.left .picture {
    margin-left: calc(-1 * var(--bleed));
  }
}

.statement {
  margin-bottom: 32px;
}

@media (min-width: 960px) {
  .statement {
    margin-bottom: 0;
  }
}

.two-tone {
  margin: 0;
  font-family: var(--sb-font-display);
  font-variation-settings: var(--sb-display-settings);
  font-weight: 600;
  font-size: clamp(1.75rem, 1.1rem + 1.9vw, 2.75rem);
  line-height: 1.08;
  letter-spacing: -0.03em;
  text-wrap: balance;
  /* The second clause is the paragraph's own grey; only the first is inked. */
  color: var(--vp-c-text-2);
}

.two-tone .ink {
  color: var(--vp-c-text-1);
}

.more {
  display: inline-block;
  margin-top: 24px;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.more:hover {
  color: var(--vp-c-brand-2);
  text-decoration: underline;
}

/* The thread: neutral messages in the site's own tokens, no platform's styling. */
.thread {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 600px;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--sb-frame-shadow);
}

@media (min-width: 960px) {
  .thread {
    justify-self: start;
  }
}

.msg {
  display: flex;
  gap: 12px;
}

.avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  font-family: var(--sb-font-display);
  font-weight: 600;
  font-size: 17px;
  line-height: 36px;
  text-align: center;
}

.avatar.person {
  background: var(--sb-c-accent-soft);
  color: var(--sb-c-accent);
}

.avatar.bot {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.body {
  min-width: 0;
  flex: 1;
}

.meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
}

.who {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.tag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 16px;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}

.when {
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.text {
  margin: 4px 0 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--vp-c-text-1);
}

.mention {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--vp-c-brand-soft);
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.pr {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-decoration-color: var(--vp-c-brand-soft);
  text-underline-offset: 2px;
}

.card {
  margin: 8px 0 0;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.card-title {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.steps {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.tick {
  flex: none;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--vp-c-brand-1);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.working {
  color: var(--vp-c-text-1);
}

.ring {
  flex: none;
  width: 14px;
  height: 14px;
  margin: 0 1px;
  border: 2px solid var(--sb-c-accent-soft);
  border-top-color: var(--sb-c-accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ring {
    animation: none;
  }
}

.card-link {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

/* The four seams: one row, a term and its implementations, no boxes. */
.seams {
  padding: 96px 0 0;
}

@media (min-width: 960px) {
  .seams {
    padding: 144px 0 0;
  }
}

/* The list is the measure itself, so the hairline over it spans the content,
 * not the viewport. */
.row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px 40px;
  padding-top: 40px;
  border-top: 1px solid var(--vp-c-divider);
  list-style: none;
}

@media (min-width: 640px) {
  .row {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 960px) {
  .row {
    grid-template-columns: repeat(4, 1fr);
  }
}

.seam {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-decoration: none;
}

.term {
  font-family: var(--sb-font-display);
  font-variation-settings: var(--sb-display-settings);
  font-weight: 600;
  font-size: 1.5rem;
  letter-spacing: -0.025em;
  line-height: 1.1;
  color: var(--vp-c-text-1);
  transition: color 0.2s;
}

.seam:hover .term {
  color: var(--vp-c-brand-1);
}

.gloss {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--vp-c-text-3);
}

/* Closing: the three commands, then one line. */
.closing {
  padding: 96px 0 0;
}

@media (min-width: 960px) {
  .closing {
    padding: 144px 0 0;
  }
}

.terminal {
  margin: 0;
  padding: 24px 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-code-block-bg);
  overflow-x: auto;
}

.terminal code {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
  line-height: 2;
  color: var(--vp-c-text-1);
}

.line {
  display: block;
  white-space: pre;
}

.prompt {
  color: var(--vp-c-text-3);
}

.closing .caption {
  margin-top: 20px;
  font-size: 15px;
  color: var(--vp-c-text-2);
}
</style>
