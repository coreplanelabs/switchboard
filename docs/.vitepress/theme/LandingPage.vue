<script setup lang="ts">
// The landing page: a headline, one sentence, two buttons and the install line;
// then the dashboard, large — the run page first, then three statements each
// beside the picture it is about; a thread drawn in CSS; the four seams in one
// row; the three commands that take a reader from a terminal to production.
// Everything it says about the product is also said, with its proof, on the
// page each link opens; this page only arranges it. The docs hub (README.md)
// renders below it.
import { onMounted, ref, watch } from "vue";
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
const { site, isDark } = useData();

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

// The hero is the page's largest paint, so it is ONE eager image the preload
// scanner sees in the HTML — not the lazy light/dark pair the other frames use,
// which a scanner never starts. Which file the HTML names has to be decided
// before any script runs, and the site's appearance (`isDark`, the toggle or
// the OS) is not known to static HTML; the OS scheme is, so a `<picture>`
// source picks the dark file under `prefers-color-scheme: dark`. A reader who
// has toggled away from the OS scheme gets one swap after mount, and any later
// toggle swaps again; everyone else fetches exactly one hero file.
const heroSrc = ref<string | null>(null);
function followAppearance() {
  const osDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (heroSrc.value !== null || osDark !== isDark.value)
    heroSrc.value = shotSrc(hero.name, isDark.value ? "dark" : "light");
}
onMounted(followAppearance);
watch(isDark, followAppearance);

// One statement per picture: the first clause in ink, the second in grey, and
// the page that proves it. The picture sits right, then left, then right, and
// is cropped from the top to the aspect ratio its content fills — the fixture's
// runs index is a few rows, its residents two, the spend page runs deeper.
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
    crop: "5 / 1",
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
          <!-- The primary door is the system's arrow-chip button: the inverted
               neutral with a canvas-coloured square holding a thin arrow. -->
          <a class="button brand" href="/tutorials/get-started">
            Get started
            <span class="chip" aria-hidden="true">
              <svg viewBox="0 0 16 16"><path d="M4.5 11.5 11.5 4.5M6 4.5h5.5V10" /></svg>
            </span>
          </a>
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
        <!-- The one picture above the fold: one eager image (see `heroSrc`). Until
             the script has run, the source picks the file for the OS scheme; once
             `heroSrc` is set, the image follows the site's appearance instead. -->
        <figure class="frame hero-frame">
          <div class="bar" aria-hidden="true">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">/runs/…</span>
          </div>
          <picture>
            <source v-if="heroSrc === null" media="(prefers-color-scheme: dark)" :srcset="shotSrc(hero.name, 'dark')" />
            <img
              :src="heroSrc ?? shotSrc(hero.name, 'light')"
              :alt="hero.alt"
              :width="PICTURE.width"
              :height="PICTURE.height"
              fetchpriority="high"
            />
          </picture>
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
          <div class="bar" aria-hidden="true">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
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

/* Hero: type on the bare canvas, nothing behind it. */
.hero {
  padding: 64px 0 0;
}

@media (min-width: 960px) {
  .hero {
    padding: 104px 0 0;
  }
}

/* The eyebrow is the system's: mono, small, spaced, faint. */
.eyebrow {
  margin: 0 0 24px;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}

/* The product's name keeps its own casing inside the uppercase eyebrow. */
.eyebrow .product {
  text-transform: none;
  color: var(--vp-c-text-1);
}

/* The headline is the text face, bigger: the house weight, the letters
 * tightened, the leading closed. */
.title {
  margin: 0;
  font-weight: 500;
  font-size: clamp(2.75rem, 1.25rem + 5.6vw, 6.25rem);
  line-height: 0.98;
  letter-spacing: -0.025em;
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
  max-width: 36rem;
  font-size: clamp(1.0625rem, 1rem + 0.35vw, 1.25rem);
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 36px 0 0;
}

.button {
  display: inline-flex;
  align-items: center;
  border-radius: 12px;
  font-size: 14px;
  text-decoration: none;
  transition:
    opacity 0.15s,
    background-color 0.15s;
}

/* Primary: the inverted neutral, lit faintly from above, floating on the one
 * shadow; the canvas-coloured chip holds a thin arrow that nudges on hover. */
.button.brand {
  gap: 16px;
  padding: 6px 6px 6px 20px;
  background: linear-gradient(to bottom, var(--sb-c-accent-from), var(--sb-c-accent-to));
  color: var(--sb-c-on-accent);
  font-weight: 500;
  box-shadow: var(--sb-shadow-float);
}

.button.brand:hover {
  opacity: 0.95;
}

.chip {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--vp-c-bg);
}

.chip svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--vp-c-text-1);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s;
}

.button.brand:hover .chip svg {
  transform: translate(2px, -2px);
}

/* Secondary: the same shape, just a hairline; hover is a 3% fill. */
.button.alt {
  padding: 0 20px;
  line-height: 46px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-1);
}

.button.alt:hover {
  background: var(--vp-c-bg-soft);
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
  background: var(--vp-c-bg-soft);
}

.command {
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  white-space: nowrap;
  color: var(--vp-c-text-1);
}

.copy {
  flex: none;
  padding: 0 12px;
  line-height: 30px;
  border: 0;
  border-radius: 8px;
  background: var(--vp-c-default-3);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.copy:hover,
.copy.done {
  color: var(--vp-c-text-1);
}

/* Frames: a hairline, the frame radius, the canvas behind — no shadow, no
 * bezel — dimmed a little at rest and full on hover. The image keeps its own
 * 16:10 through width/height, so the box is sized before it arrives. The two
 * images are one per appearance; the site's `dark` class on <html> picks. */
.frame {
  position: relative;
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  overflow: hidden;
  opacity: 0.88;
  transition: opacity 0.35s ease;
}

.frame:hover {
  opacity: 1;
}

.hero-frame {
  margin-top: 64px;
}

@media (min-width: 960px) {
  .hero-frame {
    margin-top: 88px;
  }
}

/* The window bar is the terminal mock's: three hollow dots and a faint address. */
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 50%;
  background: var(--vp-c-bg-soft);
}

.url {
  flex: 1;
  max-width: 320px;
  margin-left: 12px;
  padding: 0 10px;
  line-height: 22px;
  border-radius: 6px;
  background: var(--vp-c-default-3);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-2);
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

/* The two-tone sentence: the claim in ink, the qualifier in the faint grey,
 * one size, one weight, inline. */
.two-tone {
  margin: 0;
  font-weight: 500;
  font-size: clamp(1.5rem, 1rem + 1.6vw, 2.25rem);
  line-height: 1.15;
  letter-spacing: -0.025em;
  text-wrap: balance;
  color: var(--vp-c-text-3);
}

.two-tone .ink {
  color: var(--vp-c-text-1);
}

/* A link is strong text with a faint underline that darkens on hover. */
.more,
.pr {
  color: var(--vp-c-text-1);
  text-decoration: underline;
  text-decoration-color: var(--sb-c-ghost);
  text-underline-offset: 3px;
  transition: text-decoration-color 0.15s;
}

.more {
  display: inline-block;
  margin-top: 24px;
  font-size: 15px;
  font-weight: 500;
}

.more:hover {
  text-decoration-color: var(--vp-c-text-1);
}

/* The thread: neutral messages in the site's own tokens, no platform's styling. */
.thread {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 600px;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
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
  border-radius: 8px;
  font-weight: 500;
  font-size: 16px;
  line-height: 36px;
  text-align: center;
}

/* A person is a soft chip; the bot wears the action colour. */
.avatar.person {
  background: var(--vp-c-default-3);
  color: var(--vp-c-text-2);
}

.avatar.bot {
  background: var(--vp-c-brand-3);
  color: var(--sb-c-on-accent);
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
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.tag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--vp-c-default-3);
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 16px;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}

.when {
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.text {
  margin: 4px 0 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--sb-c-body);
}

.mention {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--vp-c-brand-soft);
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.card {
  margin: 8px 0 0;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.card-title {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 500;
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

/* The two data colours on the page: a step that finished, a step in progress. */
.tick {
  flex: none;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--sb-c-ok);
  stroke-width: 1.5;
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
  border: 2px solid var(--sb-c-working-soft);
  border-top-color: var(--sb-c-working);
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
  font-weight: 500;
  color: var(--vp-c-text-2);
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
  transition: opacity 0.15s;
}

.seam:hover {
  opacity: 0.8;
}

.term {
  font-weight: 500;
  font-size: 1.375rem;
  letter-spacing: -0.025em;
  line-height: 1.15;
  color: var(--vp-c-text-1);
}

.gloss {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--vp-c-text-3);
}

/* Closing: the three commands, then one line; below it the section gap before
 * the hub's own hairline (product.css draws that over the hub's title). */
.closing {
  padding: 96px 0 96px;
}

@media (min-width: 960px) {
  .closing {
    padding: 144px 0 112px;
  }
}

.terminal {
  margin: 0;
  padding: 20px 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-code-block-bg);
  overflow-x: auto;
}

.terminal code {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  line-height: 2;
  color: var(--vp-c-text-1);
}

.line {
  display: block;
  white-space: pre;
}

.prompt {
  color: var(--sb-c-ghost);
}

.closing .caption {
  margin-top: 20px;
  font-size: 15px;
  color: var(--vp-c-text-2);
}
</style>
