import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_CAPABILITIES } from "../core/capabilities.js";
import { SECOND_MS } from "../core/budgets.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { createHomeService, type HomeSnapshot } from "../core/home/service.js";
import { createHomeConditionReader } from "../core/home/conditions.js";
import { systemClock } from "../core/trace/clock.js";
import { createHomeViewHandler } from "../channels/homeView.js";
import { loadWebAssets } from "../channels/webAssets.js";
import { makePageSender, GREEN_PAGE_CSP } from "../channels/webShell.js";
import { resolveCaptures, SURFACES } from "../docs/screenshotManifest.js";
import type { Sample } from "./aggregate.js";
import evidence from "./homeEvidence.fixture.json" with { type: "json" };

export interface HomeLoadOptions {
  units: number;
  pipelines: number;
  iterations: number;
  browser: boolean;
  distDir?: string;
}

function sourceFingerprint() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: PACKAGE_ROOT, maxBuffer: 32 * 1024 * 1024 });
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  return {
    head: git("rev-parse", "HEAD").toString().trim(),
    dirty: git("status", "--porcelain").length > 0,
    diffSha256: createHash("sha256")
      .update(git("diff", "--binary", "HEAD"))
      .digest("hex"),
    untrackedSha256: createHash("sha256")
      .update(
        JSON.stringify(
          untracked.map((name) => [
            name,
            createHash("sha256")
              .update(readFileSync(join(PACKAGE_ROOT, name)))
              .digest("hex"),
          ]),
        ),
      )
      .digest("hex"),
  };
}
function bundleFingerprint(distDir: string) {
  const files = [
    ".vite/manifest.json",
    ...readdirSync(join(distDir, "assets"))
      .sort()
      .filter((name) => statSync(join(distDir, "assets", name)).isFile())
      .map((name) => `assets/${name}`),
  ];
  const hashes = Object.fromEntries(
    files.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(distDir, name)))
        .digest("hex"),
    ]),
  );
  return { fingerprint: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"), files: hashes };
}
/** CSS visibility alone includes virtual overscan and clipped rows. */
export function homeAttentionInViewport(row: Element | null): boolean {
  if (!row?.isConnected) return false;
  const list = row.closest('[tabindex="0"][aria-label]');
  const view = row.ownerDocument.defaultView;
  if (!list || !view) return false;
  const box = row.getBoundingClientRect(),
    container = list.getBoundingClientRect();
  const left = Math.max(0, box.left, container.left),
    right = Math.min(view.innerWidth, box.right, container.right);
  const top = Math.max(0, box.top, container.top),
    bottom = Math.min(view.innerHeight, box.bottom, container.bottom);
  if (left >= right || top >= bottom) return false;
  const hit = row.ownerDocument.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return !!hit && row.contains(hit);
}

/** Synthetic local HTTP and browser proof. No external credentials or work. */
export async function runHomeLoad(options: HomeLoadOptions) {
  const minimum = Math.max(evidence.minimumUnits, 2 * (evidence.observedUnresolvedMax ?? 0));
  const { units, pipelines, iterations } = options;
  if (
    !Number.isSafeInteger(units) ||
    units < minimum ||
    !Number.isSafeInteger(pipelines) ||
    pipelines < 1 ||
    pipelines > units ||
    !Number.isSafeInteger(iterations) ||
    iterations < 20
  )
    throw new Error(`Home load requires at least ${minimum} units, 1..units pipelines and 20 whole iterations.`);
  const distDir = join(PACKAGE_ROOT, "web/dist");
  if (options.browser && options.distDir && resolve(options.distDir) !== distDir)
    throw new Error("Home browser proof requires this checkout's web/dist; unrelated bundles are unqualified.");
  const source = sourceFingerprint();
  if (options.browser) {
    // The existing build binds these assets to this source, outside latency timing.
    execFileSync("npm", ["run", "--silent", "build", "-w", "web"], { cwd: PACKAGE_ROOT, stdio: "pipe" });
    if (JSON.stringify(sourceFingerprint()) !== JSON.stringify(source))
      throw new Error("The source changed during the browser build; repeat on a frozen checkout.");
  }
  const bundle = options.browser ? bundleFingerprint(distDir) : null;
  const instances = new InMemoryCoordinatorInstanceStore();
  for (let p = 0; p < pipelines; p++) {
    const id = `load-${String(p + 1).padStart(6, "0")}`;
    await instances.put({
      id,
      kind: "ship",
      userId: "access:load",
      channelId: "web:load",
      threadKey: `web:load:${p + 1}`,
      repo: "example/app",
      branch: "work",
      createdAt: 1,
    });
    const count = Math.floor(units / pipelines) + (p < units % pipelines ? 1 : 0);
    await instances.putUnits(
      Array.from({ length: count }, (_, i) => ({
        instanceId: id,
        unit: `U${String(i + 1).padStart(6, "0")}`,
        slug: `work-${p + 1}-${i + 1}`,
        branch: `work/p${p + 1}/u${i + 1}`,
        dependsOn: [],
        rounds: [],
        idle: {
          why: "held",
          from: "coding" as const,
          at: 2,
          spendUsd: 0,
          renewalsLeft: 0,
          wakes: 0,
          humanGate: {
            pr: { number: p + 1, url: `https://github.com/example/app/pull/${p + 1}` },
            round: 1,
            verdict: "request_changes" as const,
            askedAt: 2,
            assignedTo: "access:load",
            findings: [],
          },
        },
      })),
    );
  }
  const service = createHomeService({
    organizationId: "load-fixture",
    instances,
    maxUnits: units,
    conditions: createHomeConditionReader(instances),
  });
  const assets = options.browser ? loadWebAssets(distDir, "green/main.ts") : undefined;
  const page = makePageSender(
    assets?.entry ?? { js: "/unused.js", css: [] },
    { ...NO_CAPABILITIES },
    { csp: GREEN_PAGE_CSP },
  );
  const view = createHomeViewHandler(service, page, "load-fixture");
  const server = createServer((req, res) => {
    if (assets?.serve(req, res)) return;
    if (
      !view(req, res, { organization: "load-fixture", actor: { kind: "user", id: "access:load", grants: ALL_GRANTS } })
    )
      res.writeHead(404).end();
  });
  const samples: Sample[] = [];
  let observations = { discoveredUnits: 0, attentionUnits: 0, pipelines: 0, complete: false };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (let i = 0; i < iterations; i++) {
      const startedAt = systemClock();
      const response = await fetch(`${origin}/home/snapshot`);
      const body = await response.text();
      const attentionMs = systemClock() - startedAt;
      const snapshot = JSON.parse(body) as HomeSnapshot;
      const keys = new Set([...snapshot.needsYou, ...snapshot.moving, ...snapshot.waiting].map((row) => row.unit.unit));
      observations = {
        discoveredUnits: keys.size,
        attentionUnits: snapshot.needsYou.length,
        pipelines: snapshot.pipelines.length,
        complete: snapshot.status === "complete",
      };
      const ok =
        response.status === 200 &&
        observations.complete &&
        keys.size === units &&
        observations.attentionUnits === units &&
        observations.pipelines === pipelines;
      samples.push(
        { op: "first-attention", startedAt, ms: attentionMs, ok },
        { op: "complete-list", startedAt, ms: systemClock() - startedAt, ok },
      );
    }
    if (options.browser) {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch();
      try {
        const surface = SURFACES.find((row) => row.name === "green-home");
        if (!surface) throw new Error("The pinned Home browser profiles are unavailable.");
        for (const capture of resolveCaptures([surface])) {
          const context = await browser.newContext(capture.context);
          try {
            await context.route("**/*", (route) =>
              route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
            );
            for (let i = 0; i < iterations; i++) {
              const page = await context.newPage();
              try {
                const startedAt = systemClock();
                await page.goto(`${origin}/home`, { waitUntil: "domcontentloaded" });
                const list = page.locator(`[aria-label="Needs you: ${units} units"]`);
                const first = list.locator('[role="listitem"]').first();
                await first.waitFor({ state: "visible", timeout: 10 * SECOND_MS });
                await page.waitForFunction(homeAttentionInViewport, await first.elementHandle(), {
                  timeout: 10 * SECOND_MS,
                });
                const ms = systemClock() - startedAt;
                const rendered = await list.locator('[role="listitem"]').count();
                const size = await first.getAttribute("aria-setsize");
                await list.evaluate((element) => {
                  element.scrollTop = element.scrollHeight;
                });
                const last = list.locator(`[aria-posinset="${units}"]`);
                await last.waitFor({ state: "visible", timeout: 10 * SECOND_MS });
                await last.scrollIntoViewIfNeeded();
                await page.waitForFunction(homeAttentionInViewport, await last.elementHandle(), {
                  timeout: 10 * SECOND_MS,
                });
                samples.push({
                  op: `browser-${capture.profile}-${capture.theme}`,
                  startedAt,
                  ms,
                  ok: size === String(units) && rendered > 0 && rendered < units,
                });
              } finally {
                await page.close();
              }
            }
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (
    JSON.stringify(sourceFingerprint()) !== JSON.stringify(source) ||
    (bundle && JSON.stringify(bundleFingerprint(distDir)) !== JSON.stringify(bundle))
  )
    throw new Error("Source or browser assets changed during measurement; no receipt qualifies the candidate.");
  return {
    samples,
    observations,
    parameters: {
      units,
      pipelines,
      iterations,
      implementation: "local canonical inventory/render",
      privateSourceAuthentication: "unmeasured",
      source,
      bundle,
      browser: options.browser,
      authorizedLiveFleetSizing: evidence.observationComplete ? "recorded" : "unverified",
    },
    notes: [
      "Synthetic local canonical inventory/render only; private native authentication, source epochs and answer-enrichment costs are unmeasured. No Cloudflare latency or production work is measured.",
      "Browser assets are rebuilt from the frozen current checkout before timing. Source and served-asset fingerprints are checked again after measurement.",
      "Browser mode uses the pinned desktop/phone viewport and theme profiles, including virtualized last-row reachability.",
      ...(evidence.observationComplete
        ? []
        : ["A complete authorized fleet census is still required to qualify the 2x observed-fleet bound."]),
    ],
  };
}
