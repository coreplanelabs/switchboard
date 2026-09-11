import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

// The web app is served by the bot process (src/index.ts) as hashed static
// assets under /assets/*, referenced from server-rendered shells. The build
// manifest is how the server discovers the hashed entry names.
export default defineConfig({
  plugins: [
    vue(),
    ui({
      ui: {
        // The chrome has no hue: both aliases are the zero-chroma neutral, and
        // main.css maps `--ui-primary` itself onto the inverted neutral (ink).
        colors: {
          primary: "neutral",
          neutral: "neutral",
        },
      },
      // Bundle every icon the source uses (plus the theme's defaults) at build
      // time: the CSP allows no runtime fetch from the Iconify API.
      icon: { clientBundle: { scan: true } },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Shared pure modules from the bot source tree (runTimeline, formatters,
      // markdownLite). One fold/format implementation for server and browser.
      "@core": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../src", import.meta.url))],
    },
  },
  build: {
    manifest: true,
    outDir: "dist",
    rollupOptions: {
      input: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
    },
  },
  test: {
    // Also a project of the root vitest.config.ts: `npx vitest run --project web`.
    name: "web",
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
