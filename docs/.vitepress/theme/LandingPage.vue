<script setup lang="ts">
// The landing page: the pitch, the request flow, three doors in, the four
// seams, and three pictures of the dashboard. Everything it says about the
// product is also said, with its proof, on the page each link opens; this page
// only arranges it. The docs hub (README.md) renders below it.
import { useData } from "vitepress";
import RequestFlow from "./RequestFlow.vue";

// The product's name is the site title, which the config reads from
// project.json's `displayName` — one fact, no copy here; `check:site` proves
// the built hero carries it.
const { site } = useData();
// The pictures are rendered from the fixture preview by `npm run
// screenshots:gen` (docs/public/screenshots/, one file per theme); a frame
// shows the one for the site's appearance.
import { SHOTS, shotSrc } from "./screenshots.mjs";
// The seams' one statement — the same file the four-seam diagram in the README
// and the docs is drawn from; the cards show it in the file's order.
import { listed, SEAMS } from "./seams.mjs";
</script>

<template>
  <!-- The page's main landmark: the default theme's home layout has none of its own. -->
  <main class="landing">
    <section class="hero">
      <p class="eyebrow">
        <span class="product">{{ site.title }}</span> · an open-source agent gateway
      </p>
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
        <li v-for="seam in SEAMS" :key="seam.id" class="seam">
          <h3 class="seam-name">{{ seam.name }}</h3>
          <p class="seam-body">
            <strong>{{ seam.lead }}</strong> {{ seam.body }}
          </p>
          <p class="seam-has">{{ listed(seam.implementations) }}</p>
          <a class="seam-link" :href="seam.link">{{ seam.cta }} →</a>
        </li>
      </ul>
    </section>

    <section class="shots" aria-labelledby="shots-title">
      <h2 id="shots-title" class="section-title">What it looks like</h2>
      <ul class="strip">
        <li v-for="shot in SHOTS" :key="shot.name">
          <figure class="shot">
            <div class="frame">
              <img class="light" :src="shotSrc(shot.name, 'light')" :alt="shot.alt" loading="lazy" />
              <img class="dark" :src="shotSrc(shot.name, 'dark')" :alt="shot.alt" loading="lazy" />
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

/* The product's name keeps its own casing inside the uppercase eyebrow. */
.eyebrow .product {
  text-transform: none;
  font-weight: 600;
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

/* The pictures. Each frame is a 16:10 box — the pictures' own shape — under a
 * window bar, so the strip's height is fixed before an image arrives. The two
 * images are one per appearance; the site's `dark` class on <html> picks. */
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
  padding: 24px 0 0;
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

.frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top left;
}

.frame img.dark {
  display: none;
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

figcaption {
  margin: 12px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
</style>
