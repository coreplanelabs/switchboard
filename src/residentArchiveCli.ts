#!/usr/bin/env node
/** Source-checkout operator command. Capture requires the old Worker route,
 * exact binding facts and credentials from this process's environment only.
 * Restore is offline and needs no credential or network access. */
import {
  captureResidentArchive,
  restoreResidentArchive,
  type ResidentArchiveBinding,
  type ResidentArchiveTransport,
} from "./execution/residentArchive.js";
import { processSecrets } from "./secrets.js";

const SHA40 = /^[a-f0-9]{40}$/;
const TOKEN = /^sbr_[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{20,128}$/;

function args(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || parsed.has(key))
      throw new Error("invalid archive arguments");
    parsed.set(key, value);
  }
  return parsed;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function credential(name: string): string {
  const value = processSecrets.named(name)?.reveal();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function endpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid --url");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("--url must be a bare HTTPS origin (or local HTTP origin)");
  return url;
}

async function request(url: URL, route: string, token?: string, body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(route, url), {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(21 * 60_000),
  }).catch(() => {
    throw new Error(`resident ${route} request failed`);
  });
  if (!response.ok) throw new Error(`resident ${route} returned HTTP ${response.status}`);
  const text = await response.text(); // /exec may prefix heartbeat whitespace
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`resident ${route} returned invalid JSON`);
  }
}

async function capture(options: Map<string, string>): Promise<void> {
  const url = endpoint(required(options, "--url"));
  const resource = required(options, "--resource");
  const threadKey = required(options, "--thread-key");
  const expectedRef = required(options, "--ref");
  const expectedSha = required(options, "--sha");
  const expectedUser = required(options, "--user");
  const expectedBoundAt = required(options, "--bound-at");
  const expectedBuild = required(options, "--build");
  const archiveDir = required(options, "--out");
  if (!SHA40.test(expectedSha) || !SHA40.test(expectedBuild)) throw new Error("--sha and --build require full commits");
  if (!/^repo:[a-z0-9][a-z0-9._/-]{2,61}$/.test(resource) || !threadKey || !expectedRef || !expectedUser)
    throw new Error("invalid resident target");
  if (
    [...options.keys()].some(
      (key) =>
        !["--url", "--resource", "--thread-key", "--ref", "--sha", "--user", "--bound-at", "--build", "--out"].includes(
          key,
        ),
    )
  )
    throw new Error("unknown archive option");
  const health = await request(url, "/healthz");
  const build = health.build as Record<string, unknown> | undefined;
  if (build?.commit !== expectedBuild) throw new Error("resident Worker build differs from --build");
  const readToken = credential("RESIDENT_READ_TOKEN");
  const operatorToken = credential("RESIDENT_OPERATOR_TOKEN");
  const binding = async (): Promise<ResidentArchiveBinding> => {
    const view = await request(url, "/debug", readToken, { op: "threads", resource });
    if (!Array.isArray(view.threads)) throw new Error("resident thread inventory unavailable");
    const rows = view.threads.filter(
      (row): row is ResidentArchiveBinding =>
        typeof row === "object" && row !== null && (row as ResidentArchiveBinding).threadKey === threadKey,
    );
    if (rows.length !== 1) throw new Error("exact resident binding unavailable");
    const row = rows[0];
    if (row.user !== expectedUser || row.boundAt !== expectedBoundAt)
      throw new Error("resident user or bound-at differs from requested binding");
    return row;
  };
  const first = await binding();
  let env: Record<string, string> = {};
  if (first.githubDoorHost) {
    const host = credential("GH_HOST");
    const bearer = credential("GH_ENTERPRISE_TOKEN");
    if (host !== first.githubDoorHost || !TOKEN.test(bearer))
      throw new Error("Git Door bearer does not match the binding");
    env = { GH_HOST: host, GH_ENTERPRISE_TOKEN: bearer };
  } else if (!first.readonly) {
    throw new Error("writable binding has no Git Door host");
  }
  const transport: ResidentArchiveTransport = {
    binding,
    async exec(command) {
      const answer = await request(url, "/exec", operatorToken, {
        resource,
        threadKey,
        command,
        env,
        timeoutMs: 20 * 60_000,
      });
      if (typeof answer.error === "string") throw new Error("resident /exec refused archive probe");
      if (
        typeof answer.stdout !== "string" ||
        typeof answer.stderr !== "string" ||
        typeof answer.exitCode !== "number" ||
        typeof answer.truncated !== "boolean"
      )
        throw new Error("resident /exec returned an invalid result");
      return {
        stdout: answer.stdout,
        stderr: answer.stderr,
        exitCode: answer.exitCode,
        truncated: answer.truncated,
      };
    },
  };
  const receipt = await captureResidentArchive({ transport, threadKey, expectedRef, expectedSha, archiveDir });
  process.stdout.write(
    `archive sealed: ${receipt.entryCount} entries, ${receipt.byteCount} bytes, manifest ${receipt.manifestSha256}\n`,
  );
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const options = args(rest);
  if (mode === "capture") return capture(options);
  if (mode === "restore") {
    if ([...options.keys()].some((key) => !["--archive", "--out"].includes(key)))
      throw new Error("unknown restore option");
    const receipt = await restoreResidentArchive({
      archiveDir: required(options, "--archive"),
      restoreDir: required(options, "--out"),
    });
    process.stdout.write(
      `archive restored: ${receipt.entryCount} entries, ${receipt.byteCount} bytes, manifest ${receipt.manifestSha256}\n`,
    );
    return;
  }
  throw new Error(
    "usage: resident:archive capture --url ... --resource ... --thread-key ... --ref ... --sha ... --user ... --bound-at ... --build ... --out ... | restore --archive ... --out ...",
  );
}

main().catch((error: unknown) => {
  // Error messages above contain categories/HTTP status only, never request
  // bodies, response bodies, file paths or credentials.
  process.stderr.write(`${error instanceof Error ? error.message : "resident archive failed"}\n`);
  process.exitCode = 1;
});
