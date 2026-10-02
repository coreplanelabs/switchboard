import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { digestBearer, newPersonalBearer } from "../mcp/personalTokens.js";
import { MCP_PROTOCOL_VERSION } from "../mcp/client.js";
import { randomBytes } from "node:crypto";
import {
  HOSTED_MCP_CALL_TIMEOUT_MS,
  HOSTED_MCP_CONNECT_POLL_MS,
  HOSTED_MCP_PROBE_TIMEOUT_MS,
} from "../core/budgets.js";

export interface HostedProfile {
  url: string;
  bearer: string;
}
export const hostedProfilePath = (): string =>
  process.env.SWITCHBOARD_CLIENT_CONFIG ?? join(homedir(), ".switchboard", "client.json");

export function hostedUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("The host must be an HTTPS Switchboard origin (HTTP is allowed only for localhost)");
  return url.origin;
}

export function readHostedProfile(path = hostedProfilePath()): HostedProfile | undefined {
  if (!existsSync(path)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error(`hosted profile at ${path} is malformed`);
  const profile = raw as Record<string, unknown>;
  if (typeof profile.url !== "string" || typeof profile.bearer !== "string" || !/^[a-f0-9]{64}$/.test(profile.bearer))
    throw new Error(`hosted profile at ${path} is malformed`);
  return { url: hostedUrl(profile.url), bearer: profile.bearer };
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

export function writeHostedProfile(profile: HostedProfile, path = hostedProfilePath()): void {
  writePrivate(path, `${JSON.stringify(profile, null, 2)}\n`);
}

// An inline parent is immutable in TOML: turn its siblings into dotted assignments before adding a child table.
// Split only at the inline table's top level, not inside server settings, arrays, or quoted strings.
function expandRootInlineMcpServers(line: string): string[] {
  const match = /^(\s*)((?:mcp_servers|"mcp_servers"|'mcp_servers'))\s*=\s*\{/.exec(line);
  if (!match) return [line];
  if (line.includes('"""') || line.includes("'''"))
    throw new Error("Cannot replace a multiline string in the inline mcp_servers table in Codex config");
  const entries: string[] = [];
  let depth = 1;
  let quote = "";
  let escaped = false;
  let start = match[0].length;
  let end = -1;
  for (let index = start; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        entries.push(line.slice(start, index).trim());
        end = index;
        break;
      }
    } else if (char === "," && depth === 1) {
      entries.push(line.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (entries.length === 1 && !entries[0]) entries.pop();
  if (end < 0 || !/^\s*(?:#.*)?$/.test(line.slice(end + 1)) || quote || entries.some((entry) => !entry))
    throw new Error("Cannot replace the inline mcp_servers table in Codex config; check its TOML syntax");
  const siblings = entries
    .filter((entry) => !/^(?:switchboard|"switchboard"|'switchboard')\s*=/.test(entry))
    .map((entry) => {
      if (!/^(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')\s*=/.test(entry))
        throw new Error("Cannot replace the inline mcp_servers table in Codex config; check its TOML keys");
      return `${match[1]}${match[2]}.${entry}`;
    });
  const comment = line.slice(end + 1).trim();
  return comment ? [`${match[1]}${comment}`, ...siblings] : siblings;
}

/** Add one Codex MCP server. Existing unrelated config sections stay byte-for-byte. */
export function installCodexMcp(path = join(homedir(), ".codex", "config.toml")): void {
  const npxScript = npxScriptPath();
  if (!npxScript) throw new Error("Cannot find npx. Install Node.js with npm, then run connect again.");
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const section = "[mcp_servers.switchboard]";
  const lines = old.split("\n");
  // Quoted TOML path segments name the same table; children can be interleaved with other servers.
  const switchboardTable =
    /^\s*\[\[?\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:switchboard|"switchboard"|'switchboard')(?=\s*(?:\.|\]))/;
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!switchboardTable.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    lines.splice(start, end - start);
  }
  const mcpRootTable = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\]\s*(?:#.*)?$/;
  const inlineServer = /^\s*(?:switchboard|"switchboard"|'switchboard')\s*(?:\.|=)/;
  const rootServer =
    /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:switchboard|"switchboard"|'switchboard')\s*(?:\.|=)/;
  let inMcpRoot = false;
  let atDocumentRoot = true;
  const kept = lines
    .flatMap((line) => {
      if (/^\s*\[/.test(line)) {
        inMcpRoot = mcpRootTable.test(line);
        atDocumentRoot = false;
        return [line];
      }
      if ((inMcpRoot && inlineServer.test(line)) || (atDocumentRoot && rootServer.test(line))) return [];
      return atDocumentRoot ? expandRootInlineMcpServers(line) : [line];
    })
    .join("\n")
    .trimEnd();
  const next = `${kept ? `${kept}\n\n` : ""}${section}\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${[npxScript, "--yes", "@coreplane/switchboard@latest", "mcp-proxy"].map((s) => JSON.stringify(s)).join(", ")}]\n`;
  if (next !== old) {
    mkdirSync(dirname(path), { recursive: true });
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, next, { mode, flag: "wx" });
    renameSync(temp, path);
  }
}

function npxScriptPath(): string | undefined {
  const execPath = process.env.npm_execpath;
  const fromNpm = execPath ? join(dirname(execPath), "npx-cli.js") : undefined;
  if (fromNpm && existsSync(fromNpm)) return realpathSync(fromNpm);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, platform() === "win32" ? "npx.cmd" : "npx");
    if (existsSync(path)) {
      const resolved = realpathSync(path);
      if (resolved.endsWith(".js")) return resolved;
    }
  }
  return undefined;
}

export async function hostedMcpCall(
  profile: HostedProfile,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = HOSTED_MCP_PROBE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${profile.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${profile.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new Error(`MCP returned HTTP ${response.status} without JSON`);
  return result as Record<string, unknown>;
}

/** Stdio clients speak one JSON-RPC message per line; forward the envelope unchanged. */
export async function proxyHostedMcp(profile: HostedProfile, line: string): Promise<string | undefined> {
  const message: unknown = JSON.parse(line);
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid JSON-RPC request");
  const expectsReply = "id" in message;
  const response = await fetch(`${profile.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${profile.bearer}`, "content-type": "application/json" },
    body: line,
    signal: AbortSignal.timeout(HOSTED_MCP_CALL_TIMEOUT_MS),
  });
  if (!expectsReply) return undefined;
  const body = await response.text();
  if (!body) throw new Error(`MCP returned HTTP ${response.status} without a response`);
  JSON.parse(body);
  return body;
}

/** A failed forwarded request still receives a JSON-RPC error, so stdio clients do not wait forever. */
export function mcpProxyError(line: string): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC request" } });
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || !("id" in message)) return undefined;
  const id = (message as Record<string, unknown>).id;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: { code: -32603, message: "Switchboard connection failed" },
  });
}

function openBrowser(url: string): void {
  const os = platform();
  const command = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

/** One browser approval, then verify a real read before writing either client config. */
export async function connectHosted(
  urlInput: string,
  opts: {
    output?: (line: string) => void;
    open?: (url: string) => void;
    pollMs?: number;
    attempts?: number;
    profilePath?: string;
    codexPath?: string;
  } = {},
): Promise<void> {
  const url = hostedUrl(urlInput);
  const bearer = newPersonalBearer();
  const challenge = digestBearer(bearer);
  const link = `${url}/settings/connect?challenge=${challenge}`;
  const output = opts.output ?? console.log;
  output(`Open ${link}`);
  output(`Confirm code ${challenge.slice(0, 8).toUpperCase()} in your browser.`);
  (opts.open ?? openBrowser)(link);
  const profile = { url, bearer };
  for (let attempt = 0; attempt < (opts.attempts ?? 120); attempt++) {
    try {
      const initialized = await hostedMcpCall(profile, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION });
      if (!initialized.error && initialized.result) {
        const read = await hostedMcpCall(profile, "tools/call", { name: "runs_list", arguments: { limit: 1 } });
        if (read.error || !read.result)
          throw new Error(`MCP access is missing runs:read: ${JSON.stringify(read.error ?? read)}`);
        writeHostedProfile(profile, opts.profilePath);
        installCodexMcp(opts.codexPath);
        output("Connected. Restart Codex to load Switchboard MCP; use `switchboard ask` for the hosted CLI.");
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MCP access is missing")) throw error;
      // The browser approval may still be pending; poll until the deadline.
    }
    await pause(opts.pollMs ?? HOSTED_MCP_CONNECT_POLL_MS);
  }
  throw new Error("Connection timed out. Run connect again and approve the matching code in your browser.");
}
