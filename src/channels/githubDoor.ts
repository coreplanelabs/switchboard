import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { bearerHashOf, type RunBearerStore } from "../core/modelProxy/runBearers.js";
import { GIT_RECEIVE_PACK_FORWARD_TIMEOUT_MS } from "../core/budgets.js";
import type { GitBinding, GitBindings, GitPublicationClaim } from "../core/modelProxy/gitBindings.js";
import { authorizePushRefs, inspectReceivePackPrefix, type PushPrefix } from "./gitPushPolicy.js";
import { GIT_DOOR_PATH, isGithubDoorPath } from "./githubDoorPaths.js";
import { scopedGraphqlRead, scopedRestRead } from "./githubDoorApiScope.js";
export { isGithubDoorPath } from "./githubDoorPaths.js";

type Scope = "read" | "write";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
// `gh repo clone` emits /owner/repo.git; provisioned checkouts and
// GIT_DOOR_REMOTE use /git/owner/repo.git. Both reach one policy.
const COMMAND_LIMIT = 64 * 1024;
const RECEIVE_REPORT_LIMIT = 1024 * 1024;

export interface GithubDoorDeps {
  bearers: RunBearerStore;
  bindings?: GitBindings;
  /** Public origin of this door; the CLI may omit it for its loopback server. */
  baseUrl?: string;
  /** The trusted side mints an installation token; write is repository-pinned. */
  token: (scope: Scope, repo?: string) => Promise<string>;
  fetcher?: Fetcher;
}

function runBearer(header: string | undefined): string | undefined {
  if (!header || header.length > 2048) return undefined;
  const separator = header.indexOf(" ");
  if (separator < 0) return undefined;
  const scheme = header.slice(0, separator).toLowerCase();
  const value = header.slice(separator + 1).trim();
  if (!value) return undefined;
  if (scheme === "token" || scheme === "bearer") return value;
  if (scheme !== "basic" || !/^[A-Za-z0-9+/=]+$/.test(value)) return undefined;
  const pair = Buffer.from(value, "base64").toString("utf8");
  return pair.startsWith("x-access-token:") ? pair.slice("x-access-token:".length) : undefined;
}

function sameBinding(left: GitBinding | undefined, right: GitBinding | undefined): boolean {
  return (
    !!left && !!right && left.repo === right.repo && left.ref === right.ref && left.refConfirmed === right.refConfirmed
  );
}

/** The request path may vary; its upstream scheme and host never do. */
function githubUrl(host: "api.github.com" | "github.com", path: string, search = ""): string {
  const url = new URL(`https://${host}`);
  url.pathname = path;
  url.search = search;
  if (url.protocol !== "https:" || url.host !== host) throw new Error("invalid GitHub upstream");
  return url.toString();
}

function answer(res: ServerResponse, status: number, reason: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...(status === 401 ? { "www-authenticate": 'Basic realm="Switchboard Git door"' } : {}),
  });
  res.end(reason);
}

function upstreamHeaders(req: IncomingMessage, token: string, git: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: git ? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` : `Bearer ${token}`,
    "user-agent": "switchboard-github-door",
  };
  for (const name of ["accept", "content-type", "git-protocol", "x-github-api-version"] as const) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

async function proxyResponse(res: ServerResponse, upstream: Response, doorOrigin?: string): Promise<void> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  const type = upstream.headers.get("content-type");
  if (type) headers["content-type"] = type;
  const link = upstream.headers.get("link");
  if (link && doorOrigin && /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(doorOrigin))
    headers.link = link.replaceAll("https://api.github.com/", `${doorOrigin}/api/v3/`);
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return void res.end();
  for await (const chunk of Readable.fromWeb(upstream.body as never)) {
    if (!res.write(chunk)) await once(res, "drain");
  }
  res.end();
}

async function receivePrefix(req: IncomingMessage): Promise<{
  parsed: PushPrefix;
  body?: Readable;
}> {
  const iterator = req[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { parsed: { kind: "refused", reason: "receive-pack ended before its command flush" } };
    const chunk = Buffer.from(next.value as Uint8Array);
    chunks.push(chunk);
    size += chunk.length;
    const parsed = inspectReceivePackPrefix(Buffer.concat(chunks, size));
    if (parsed.kind === "commands") {
      async function* remaining(): AsyncGenerator<Buffer> {
        yield* chunks;
        for (;;) {
          const item = await iterator.next();
          if (item.done) break;
          yield Buffer.from(item.value as Uint8Array);
        }
      }
      return { parsed, body: Readable.from(remaining()) };
    }
    if (parsed.kind === "refused" || size > COMMAND_LIMIT) {
      return {
        parsed:
          parsed.kind === "refused"
            ? parsed
            : { kind: "refused", reason: "receive-pack command section exceeds 64 KiB" },
      };
    }
  }
}

async function limitedBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > COMMAND_LIMIT) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function pkt(line: string | Buffer): Buffer {
  const content = typeof line === "string" ? Buffer.from(line) : line;
  return Buffer.concat([Buffer.from((content.length + 4).toString(16).padStart(4, "0")), content]);
}

function refusePush(res: ServerResponse, parsed: PushPrefix, reason: string): void {
  if (parsed.kind !== "commands") return answer(res, 400, reason);
  const lines = ["unpack ok\n", ...parsed.commands.map((command) => `ng ${command.ref} ${reason}\n`)];
  const sideband = parsed.capabilities.includes("side-band-64k") || parsed.capabilities.includes("side-band");
  const report = Buffer.concat([...lines.map(pkt), Buffer.from("0000")]);
  const limit = parsed.capabilities.includes("side-band-64k") ? 65_515 : 995;
  const body = sideband
    ? Buffer.concat([
        ...Array.from({ length: Math.ceil(report.length / limit) }, (_, index) =>
          pkt(Buffer.concat([Buffer.from([1]), report.subarray(index * limit, (index + 1) * limit)])),
        ),
        Buffer.from("0000"),
      ])
    : report;
  res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" });
  res.end(body);
}

/** GitHub advertises push-options; withholding it prevents a normal client
 * from adding an unexamined option section after the pack. */
function stripPushOptions(advertisement: Buffer): Buffer {
  let offset = 0;
  while (offset + 4 <= advertisement.length) {
    const length = Number.parseInt(advertisement.toString("ascii", offset, offset + 4), 16);
    if (!Number.isFinite(length) || length < 0 || offset + length > advertisement.length) break;
    if (length === 0) {
      offset += 4;
      continue;
    }
    const content = advertisement.subarray(offset + 4, offset + length);
    const nul = content.indexOf(0);
    if (nul >= 0) {
      const caps = content
        .toString("utf8", nul + 1)
        .trimEnd()
        .split(" ")
        .filter((cap) => cap !== "push-options");
      const tail = content.toString("utf8").endsWith("\n") ? "\n" : "";
      const updated = pkt(`${content.toString("utf8", 0, nul)}\0${caps.join(" ")}${tail}`);
      return Buffer.concat([advertisement.subarray(0, offset), updated, advertisement.subarray(offset + length)]);
    }
    offset += length;
  }
  return advertisement;
}

async function receiveReport(upstream: Response): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!upstream.body) return Buffer.alloc(0);
  for await (const chunk of Readable.fromWeb(upstream.body as never)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > RECEIVE_REPORT_LIMIT) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function packetPayloads(report: Buffer): Buffer[] | undefined {
  let offset = 0;
  const payloads: Buffer[] = [];
  let flushed = false;
  while (offset + 4 <= report.length) {
    const sizeText = report.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(sizeText)) return undefined;
    const size = Number.parseInt(sizeText, 16);
    offset += 4;
    if (size === 0) {
      flushed = true;
      break;
    }
    if (size < 4 || offset + size - 4 > report.length) return undefined;
    payloads.push(report.subarray(offset, offset + size - 4));
    offset += size - 4;
  }
  return flushed && offset === report.length ? payloads : undefined;
}

function pushReportOutcome(report: Buffer, ref: string): "accepted" | "rejected" | "unknown" {
  const outer = packetPayloads(report);
  if (!outer) return "unknown";
  const chunks: Buffer[] = [];
  let sideband = false;
  for (let data of outer) {
    if (data[0] === 2) continue; // progress channel
    if (data[0] === 3) return "unknown"; // fatal channel
    if (data[0] === 1) {
      sideband = true;
      data = data.subarray(1);
    }
    chunks.push(data);
  }
  const payload = Buffer.concat(chunks);
  const inner = sideband ? packetPayloads(payload) : undefined;
  if (sideband && !inner) return "unknown";
  const text = (inner ? Buffer.concat(inner) : payload).toString("utf8");
  const lines = text.trimEnd().split("\n");
  if (lines.length !== 2) return "unknown";
  if (lines[0] === "unpack ok" && lines[1] === `ok ${ref}`) return "accepted";
  if (lines[0]?.startsWith("unpack ") && lines[1]?.startsWith(`ng ${ref} `)) return "rejected";
  return "unknown";
}

function acceptedCreation(report: Buffer, ref: string): boolean {
  return pushReportOutcome(report, ref) === "accepted";
}

export function createGithubDoorHandler(deps: GithubDoorDeps) {
  const fetcher = deps.fetcher ?? fetch;
  const refs = new Map<string, { ref: string; confirmed: boolean }>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://door.invalid");
      if (!isGithubDoorPath(url.pathname)) return answer(res, 404, "not found");
      const presented = runBearer(req.headers.authorization);
      const verdict = deps.bearers.verify(presented ?? "");
      if (!verdict.ok)
        return answer(
          res,
          verdict.reason === "unknown_run"
            ? 404
            : verdict.reason === "unknown_bearer" || verdict.reason === "malformed"
              ? 401
              : 403,
          verdict.reason,
        );
      const gitGrant = verdict.grant.github;
      if (!gitGrant || gitGrant.identity === "none") return answer(res, 403, "GitHub identity is absent for this run");
      const recorded = deps.bindings?.get(verdict.grant.runId);
      const bindingGeneration = deps.bindings?.generationOf(verdict.grant.runId);
      const publication = deps.bindings?.publicationOf(verdict.grant.runId);
      if (deps.bindings && !recorded) return answer(res, 403, "GitHub binding is absent for this run");
      // The run grant comes from dispatch's resolved repository. A model may
      // never choose an installed repository by asking for Git discovery.
      const boundRepo = gitGrant.repo;
      if (!boundRepo || (recorded?.repo && recorded.repo.toLowerCase() !== boundRepo.toLowerCase()))
        return answer(res, 403, "repository binding is required for GitHub access");
      const stillAuthorized = (binding: GitBinding | undefined): boolean => {
        const current = deps.bearers.verify(presented ?? "");
        if (!current.ok || current.grant.runId !== verdict.grant.runId) return false;
        const github = current.grant.github;
        if (
          !github ||
          github.identity !== gitGrant.identity ||
          github.repo !== gitGrant.repo ||
          github.ref !== gitGrant.ref
        )
          return false;
        if (!deps.bindings) return true;
        return (
          bindingGeneration === deps.bindings.generationOf(verdict.grant.runId) &&
          sameBinding(binding, deps.bindings.get(verdict.grant.runId))
        );
      };
      const method = req.method ?? "GET";
      if (url.pathname.startsWith("/api/")) {
        const graphql = url.pathname === "/api/graphql";
        if (graphql ? method !== "POST" : method !== "GET" && method !== "HEAD")
          return answer(res, 405, "GitHub API writes are unavailable to model commands");
        const path = graphql ? "/graphql" : url.pathname.slice("/api/v3".length);
        const body = graphql ? await limitedBody(req) : undefined;
        if (graphql ? !body || !scopedGraphqlRead(body, boundRepo) : !scopedRestRead(path, boundRepo))
          return answer(res, 403, "API read is outside this run's repository binding");
        const token = await deps.token("read", boundRepo);
        if (!stillAuthorized(recorded)) return answer(res, 403, "GitHub authority is no longer valid for this request");
        const init = {
          method,
          headers: upstreamHeaders(req, token, false),
          redirect: "manual",
          ...(graphql ? { body } : {}),
        } as RequestInit;
        const origin = deps.baseUrl ?? `http://${req.headers.host}`;
        const upstream = await fetcher(githubUrl("api.github.com", path, url.search), init);
        if (upstream.status >= 300 && upstream.status < 400) return answer(res, 502, "GitHub redirect refused");
        return await proxyResponse(res, upstream, origin);
      }
      const match = GIT_DOOR_PATH.exec(url.pathname);
      if (!match) return answer(res, 404, "not found");
      if (match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..")
        return answer(res, 400, "invalid repository path");
      const repo = `${match[1]}/${match[2]}`;
      const action = match[3]!;
      const service = url.searchParams.get("service");
      const receive = action === "git-receive-pack" || (action === "info/refs" && service === "git-receive-pack");
      const upload = action === "git-upload-pack" || (action === "info/refs" && service === "git-upload-pack");
      if (!receive && !upload) return answer(res, 400, "unsupported Git service");
      if (action === "info/refs" ? method !== "GET" : method !== "POST") return answer(res, 405, "invalid Git method");
      if (receive && gitGrant.identity !== "write")
        return answer(res, 403, "GitHub write identity is absent for this run");
      if (receive && publication && "blocked" in publication)
        return answer(res, 403, "existing PR publication is blocked");
      // The model's bearer is not a blanket receive-pack grant in a harness
      // run. An unadmitted request never even asks for repository metadata or
      // a GitHub token; the exact source/ref/old-head check follows the body.
      if (
        receive &&
        deps.bindings?.toolPushIsRequired(verdict.grant.runId) &&
        !deps.bindings.hasToolPush(verdict.grant.runId, bearerHashOf(presented ?? ""))
      )
        return answer(res, 403, "a bound harness push is required");
      if (boundRepo && boundRepo.toLowerCase() !== repo.toLowerCase())
        return answer(res, 403, "repository is outside this run's binding");
      let parsed: PushPrefix | undefined;
      let body: Readable | undefined;
      let defaultBranch: string | undefined;
      let pendingBranchRef: string | undefined;
      let publicationClaim: GitPublicationClaim | undefined;
      if (receive) {
        const readToken = await deps.token("read", repo);
        const metadata = await fetcher(githubUrl("api.github.com", `/repos/${repo}`), {
          headers: { authorization: `Bearer ${readToken}`, "user-agent": "switchboard-github-door" },
          redirect: "manual",
        });
        if (!metadata.ok) return answer(res, 403, "repository metadata unavailable");
        const facts = (await metadata.json()) as { default_branch?: unknown };
        if (typeof facts.default_branch !== "string" || !facts.default_branch)
          return answer(res, 403, "repository default branch unavailable");
        defaultBranch = facts.default_branch;
      }
      if (action === "git-receive-pack") {
        const prefix = await receivePrefix(req);
        parsed = prefix.parsed;
        body = prefix.body;
        const fallbackRef = refs.get(verdict.grant.runId);
        const boundRef = recorded?.ref ?? gitGrant.ref ?? fallbackRef?.ref;
        const firstBranch =
          !gitGrant.ref && (recorded ? recorded.refConfirmed !== true : fallbackRef?.confirmed !== true);
        const decision = authorizePushRefs(parsed, {
          identity: gitGrant.identity,
          repo,
          boundRepo,
          defaultBranch,
          boundRef,
          firstBranch,
          ...(publication && "expectedHeadSha" in publication ? { expectedHeadSha: publication.expectedHeadSha } : {}),
        });
        if (!decision.ok) return refusePush(res, parsed, decision.reason);
        if (
          parsed.kind === "commands" &&
          deps.bindings?.toolPushIsRequired(verdict.grant.runId) &&
          !deps.bindings.takeToolPush(verdict.grant.runId, parsed.commands[0]!, bearerHashOf(presented ?? ""))
        )
          return answer(res, 403, "receive-pack does not match an authorized harness push");
        if (firstBranch && parsed.kind === "commands") pendingBranchRef = parsed.commands[0]!.ref;
        if (!boundRef && parsed.kind === "commands") {
          const first = parsed.commands[0]!.ref;
          if (deps.bindings) {
            if (!(await deps.bindings.bindRef(verdict.grant.runId, first)))
              return refusePush(res, parsed, "branch binding could not be saved");
          } else refs.set(verdict.grant.runId, { ref: first, confirmed: false });
        }
        if (parsed.kind === "commands") {
          if (publication && "expectedHeadSha" in publication) {
            publicationClaim = await deps.bindings?.beginPublication(verdict.grant.runId, parsed.commands[0]!);
            if (!publicationClaim) return answer(res, 403, "trusted existing PR publication receipt is unavailable");
          } else if (deps.bindings) {
            publicationClaim = await deps.bindings.beginBranch(verdict.grant.runId, parsed.commands[0]!);
            if (!publicationClaim) return answer(res, 403, "trusted branch publication receipt is unavailable");
          }
        }
      }
      const forwardBinding = deps.bindings?.get(verdict.grant.runId);
      let token: string;
      try {
        token = await deps.token(receive ? "write" : "read", repo);
      } catch (error) {
        await publicationClaim?.finish("not_forwarded");
        throw error;
      }
      if (!stillAuthorized(forwardBinding)) {
        await publicationClaim?.finish("not_forwarded");
        return answer(res, 403, "GitHub authority is no longer valid for this request");
      }
      let upstream: Response;
      try {
        upstream = await fetcher(githubUrl("github.com", `/${repo}.git/${action}`, url.search), {
          method,
          headers: upstreamHeaders(req, token, true),
          redirect: "manual",
          ...(action === "git-receive-pack"
            ? { signal: AbortSignal.timeout(GIT_RECEIVE_PACK_FORWARD_TIMEOUT_MS) }
            : {}),
          ...(body
            ? { body, duplex: "half" as const }
            : action === "git-upload-pack"
              ? { body: req, duplex: "half" as const }
              : {}),
        } as RequestInit);
      } catch (error) {
        await publicationClaim?.finish("unknown");
        throw error;
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await publicationClaim?.finish("unknown");
        return answer(res, 502, "GitHub redirect refused");
      }
      if (publicationClaim && parsed?.kind === "commands") {
        const report = await receiveReport(upstream).catch(() => undefined);
        if (!report) {
          await publicationClaim.finish("unknown");
          return answer(res, 502, "GitHub receive-pack report is unavailable or exceeds the limit");
        }
        const outcome = upstream.ok ? pushReportOutcome(report, parsed.commands[0]!.ref) : "unknown";
        if (!(await publicationClaim.finish(outcome)))
          return answer(res, 503, "Git publication outcome could not be committed durably");
        if (outcome === "accepted" && pendingBranchRef && deps.bindings) {
          if (!(await deps.bindings.confirmRef(verdict.grant.runId, pendingBranchRef)))
            return answer(res, 503, "branch created but binding confirmation could not be saved");
        }
        return await proxyResponse(
          res,
          new Response(new Uint8Array(report), { status: upstream.status, headers: upstream.headers }),
        );
      }
      if (receive && action === "info/refs" && upstream.ok) {
        const advertisement = stripPushOptions(Buffer.from(await upstream.arrayBuffer()));
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/x-git-receive-pack-advertisement",
          "cache-control": "no-store",
        });
        return void res.end(advertisement);
      }
      if (action === "git-receive-pack" && pendingBranchRef) {
        const report = await receiveReport(upstream);
        if (!report) return answer(res, 502, "GitHub receive-pack report exceeds the limit");
        if (upstream.ok && acceptedCreation(report, pendingBranchRef)) {
          if (deps.bindings) {
            if (!(await deps.bindings.confirmRef(verdict.grant.runId, pendingBranchRef)))
              return answer(res, 503, "branch created but binding confirmation could not be saved");
          } else refs.set(verdict.grant.runId, { ref: pendingBranchRef, confirmed: true });
        }
        return await proxyResponse(
          res,
          new Response(new Uint8Array(report), { status: upstream.status, headers: upstream.headers }),
        );
      }
      return await proxyResponse(res, upstream);
    } catch {
      if (!res.headersSent) answer(res, 502, "GitHub door unavailable");
      else res.destroy();
    }
  };
}
