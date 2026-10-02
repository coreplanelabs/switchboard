import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["deploy/cloudflare-acceptance-source/*.test.ts"] } });
