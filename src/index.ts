import { createServer } from "node:http";
import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createSlackApp } from "./channels/slack.js";
import { createIngressHandler, parseIngressTokens } from "./channels/http.js";
import { createMcpHandler } from "./channels/mcp.js";
import { createLiveViewHandler } from "./channels/liveView.js";
import {
  httpJwksFetcher,
  JwksCache,
  parseAccessConfig,
  parseAccessDevBypass,
  requireAccessForRuns,
  type VerifyDeps,
} from "./channels/accessAuth.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";
const OVERRIDES_PATH = process.env.SWITCHBOARD_OVERRIDES ?? "./data/overrides.json";

async function main() {
  for (const v of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
    if (!process.env[v]) {
      console.error(`Missing required env var ${v}`);
      process.exit(1);
    }
  }

  const config = new ConfigStore(CONFIG_PATH, OVERRIDES_PATH);
  const providers = new ProviderRegistry(config.config.providers);
  // Bundled skills (#100): loaded once from the seeded `skills/` dir and shared
  // across all channels via CoreDeps, so review/coding get their scoped skill
  // list in-prompt and can load bodies on demand with use_skill.
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  const app = createSlackApp({ config, providers, skills });

  await app.start();

  // Optional HTTP server. Slack traffic arrives over the outbound Socket Mode
  // websocket, so this port serves (a) a health probe for container platforms
  // (Cloudflare Containers, Fly, k8s) and the two authenticated universal
  // ingress channels, both fed by the SAME SWITCHBOARD_INGRESS_TOKENS token map
  // (one credential set, two surfaces) and both landing in the same dispatch()
  // the Slack/CLI adapters use: (b) HTTP ingress (adapter #3): POST /ingress,
  // and (c) MCP ingress (adapter #4): POST /mcp — a minimal MCP server over
  // streamable-HTTP (JSON-RPC 2.0). With no tokens configured BOTH are
  // fail-closed disabled.
  if (process.env.PORT) {
    const auth = parseIngressTokens(process.env);
    const ingress = createIngressHandler({ config, providers, skills }, { auth });
    const mcp = createMcpHandler({ config, providers, skills }, { auth });
    // Live run view (Area 2 / #43): GET /runs (index) + /runs/:id (page) +
    // /runs/:id/events (SSE). Shares defaultRunRegistry with the dispatcher —
    // the run created during dispatch() is the run this streams. The per-run
    // page/stream are token-gated (capability token in the URL, not
    // SWITCHBOARD_INGRESS_TOKENS); the bare index is instead Access-gated
    // (Cloudflare Access fronts it) and must only be exposed behind it, since it
    // renders the per-run capability links.
    const liveView = createLiveViewHandler(defaultRunRegistry);
    const tokenCount = Object.keys(auth.tokens).length;
    const liveViewState = process.env.PUBLIC_BASE_URL
      ? "GET /runs (index) + /runs/:id (live view)"
      : "GET /runs (index) + live view (no PUBLIC_BASE_URL — per-run links omitted)";

    // The whole /runs* surface sits behind Cloudflare Access (SSO), enforced
    // fail-closed in our own code: the edge rule injects a signed RS256 JWT in
    // `Cf-Access-Jwt-Assertion`, and we re-verify it here so /runs refuses to
    // serve without a valid Access identity — even if the edge rule is ever
    // misconfigured or a client spoofs the header. With no ACCESS_* config,
    // /runs is DENIED (unless ACCESS_DEV_BYPASS is set for local dev).
    const accessConfig = parseAccessConfig(process.env);
    const accessDevBypass = parseAccessDevBypass(process.env);
    const accessVerify: VerifyDeps = { fetchJwks: httpJwksFetcher, now: () => Date.now(), cache: new JwksCache() };
    const accessState = accessConfig
      ? `Access SSO configured (${accessConfig.teamDomain})`
      : accessDevBypass
        ? "Access DEV BYPASS (/runs open — LOCAL DEV ONLY)"
        : "Access FAIL-CLOSED (/runs denied — no ACCESS_* configured)";

    createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/ingress") {
        ingress(req, res);
        return;
      }
      if (path === "/mcp") {
        mcp(req, res);
        return;
      }
      // /runs* SSO gate: identity FIRST (fail-closed), before the live-view
      // dispatch. The gate is async (it may fetch the JWKS), so we resolve the
      // promise here; a rejection is a 403, never a 500 that serves the page.
      // On allow, dispatch to the live-view handler (which owns the /runs index,
      // /runs/:id, and /runs/:id/events, and still applies its own per-run
      // capability-token check — defense in depth). Non-/runs paths below are
      // unchanged and not gated.
      if (path === "/runs" || path.startsWith("/runs/")) {
        requireAccessForRuns(req.headers, { config: accessConfig, verify: accessVerify, devBypass: accessDevBypass })
          .then((gate) => {
            if (!gate.ok) {
              res.writeHead(gate.status, { "content-type": "text/plain; charset=utf-8" });
              res.end(gate.body);
              return;
            }
            if (liveView(req, res)) return;
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
          })
          .catch((err) => {
            console.error(`[access] ${err instanceof Error ? err.message : String(err)}`);
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("forbidden");
          });
        return;
      }
      // Root → dashboard. `/` is NOT Access-gated (only /runs* is), so this 302
      // is public — but it leaks nothing (just "go to /runs"), and /runs itself
      // stays behind Cloudflare Access. This fixes the bare-domain landing (was
      // a plain "ok"). It is an EXACT-path match, so /healthz and everything
      // else still fall through to the health "ok" below — the deploy wake and
      // cron keep-alive hit /healthz, so health probing is unaffected.
      if (path === "/") {
        res.writeHead(302, { location: "/runs" });
        res.end();
        return;
      }
      // Non-/runs paths (health probe, unknown paths). The live-view handler
      // only ever owns /runs*, which the gate above already handled, so there is
      // nothing else for it to serve here.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }).listen(Number(process.env.PORT), () =>
      console.log(
        `http server on :${process.env.PORT} (health + POST /ingress + POST /mcp + ${liveViewState}; ` +
          `${tokenCount > 0 ? `${tokenCount} ingress token(s)` : "ingress + MCP DISABLED — no tokens configured"}; ${accessState})`,
      ),
    );
  }

  console.log(
    `switchboard running (providers: ${providers.names().join(", ")}; default agent: ${config.config.defaults.agent})`,
  );

  // Graceful drain: close the Slack socket (no new events), let in-flight
  // agent runs finish (up to 15 min), then exit. A plain kill mid-run loses
  // the run and leaves a frozen status card in the thread.
  const { activeRunCount } = await import("./core/dispatcher.js");
  let draining = false;
  const drain = async (signal: string) => {
    if (draining) return;
    draining = true;
    console.log(`[drain] ${signal}: closing Slack socket, ${activeRunCount()} run(s) in flight`);
    await app.stop().catch(() => {});
    const deadline = Date.now() + 15 * 60_000;
    while (activeRunCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`[drain] exiting (${activeRunCount()} run(s) abandoned)`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void drain("SIGTERM"));
  process.on("SIGINT", () => void drain("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
