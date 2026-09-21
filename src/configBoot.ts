import { createServer, type Server } from "node:http";

/** The stable public sentence for a production config startup failure. The
 * state Worker URL and document wire details stay in stderr; /healthz gives an
 * operator the failing config fact and the recovery command. */
export function configRefusalReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/no "base" document/.test(raw)) return "missing base document — push one with `deploy config`";
  return raw.replace(/^SWITCHBOARD_CONFIG=state:\/\/[^:]+:\s*/, "").slice(0, 1_000);
}

/** A production process whose base config could not be loaded serves only this
 * refusal probe. It never opens Slack, ingress, commands or model routes, but
 * keeping the port up lets the platform and deploy CLI report why the new
 * generation is not live and lets an authorized restart replace it after the
 * base document is repaired. */
export function createConfigRefusalServer(opts: { problem: string; startedAt: number }): Server {
  const payload = {
    ok: false as const,
    config: opts.problem,
    inFlight: 0,
    draining: false,
    startedAt: new Date(opts.startedAt).toISOString(),
  };
  return createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://switchboard.invalid").pathname === "/healthz") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(503, { "content-type": "text/plain" });
    res.end(`config: ${opts.problem}`);
  });
}
