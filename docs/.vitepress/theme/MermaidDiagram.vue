<script setup lang="ts">
// A ```mermaid fence, drawn in the site's own palette.
//
// The markdown rule (config.ts) turns a fence into `<Mermaid id graph>`; this
// component renders it. Two things make it ours rather than the plugin's:
//
// - The colours come from the `--sb-diagram-*` tokens in product.css, read at
//   draw time and redrawn when the appearance toggles, so a diagram is in the
//   same light or dark palette as the page around it and the palette is stated
//   once. The plugin's renderer knows only mermaid's built-in `dark` theme.
// - `mermaid` is imported when the first diagram mounts, so a page without a
//   diagram — the landing page — never downloads it. The plugin's renderer
//   imports it statically, which put the whole library in every page's entry.
//
// The label boxes are measured at draw time, so the faces must be loaded
// first: a face that arrives after the measurement re-wraps a label into one
// more line than its box was cut for. `document.fonts.ready` is that wait.
import { useData } from "vitepress";
import { onMounted, ref, watch } from "vue";

const props = defineProps<{ id: string; graph: string; class?: string }>();
const { isDark } = useData();
const svg = ref("");
// Each draw takes a ticket; only the newest draw may publish. Two draws overlap
// when the appearance toggles twice before the first finishes (the import, the
// font wait and the render are all async), and without this the slower of the
// two — in the palette the page has already left — could land last.
let drawEpoch = 0;

const TOKENS = [
  "bg",
  "node",
  "node-alt",
  "node-border",
  "text",
  "line",
  "cluster",
  "cluster-border",
  "note",
  "note-border",
] as const;

/** The `--sb-diagram-*` tokens as they resolve on the page right now. */
function palette(): Record<(typeof TOKENS)[number], string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, style.getPropertyValue(`--sb-diagram-${t}`).trim()])) as Record<
    (typeof TOKENS)[number],
    string
  >;
}

async function draw() {
  const epoch = ++drawEpoch;
  const { default: mermaid } = await import("mermaid");
  await document.fonts.ready;
  const style = getComputedStyle(document.documentElement);
  const c = palette();
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    fontFamily: style.getPropertyValue("--vp-font-family-base").trim(),
    flowchart: { useMaxWidth: true },
    themeVariables: {
      background: c.bg,
      fontSize: "14px",
      // Nodes, edges, text.
      primaryColor: c.node,
      primaryBorderColor: c["node-border"],
      primaryTextColor: c.text,
      secondaryColor: c["node-alt"],
      secondaryBorderColor: c["node-border"],
      secondaryTextColor: c.text,
      tertiaryColor: c.cluster,
      tertiaryBorderColor: c["cluster-border"],
      tertiaryTextColor: c.text,
      lineColor: c.line,
      textColor: c.text,
      nodeTextColor: c.text,
      titleColor: c.text,
      edgeLabelBackground: c.bg,
      clusterBkg: c.cluster,
      clusterBorder: c["cluster-border"],
      // Sequence diagrams.
      actorBkg: c.node,
      actorBorder: c["node-border"],
      actorTextColor: c.text,
      actorLineColor: c.line,
      signalColor: c.line,
      signalTextColor: c.text,
      labelBoxBkgColor: c["node-alt"],
      labelBoxBorderColor: c["node-border"],
      labelTextColor: c.text,
      loopTextColor: c.text,
      activationBkgColor: c["node-alt"],
      activationBorderColor: c["node-border"],
      sequenceNumberColor: c.bg,
      noteBkgColor: c.note,
      noteBorderColor: c["note-border"],
      noteTextColor: c.text,
    },
  });
  const { svg: drawn } = await mermaid.render(props.id, decodeURIComponent(props.graph));
  if (epoch !== drawEpoch) return; // a newer draw has started; its result is the current palette's
  svg.value = drawn;
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html — mermaid's rendering of this tree's own fences -->
  <div :class="props.class ?? 'mermaid'" v-html="svg"></div>
</template>
