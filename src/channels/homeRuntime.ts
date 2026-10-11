import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Actor } from "../core/authz/types.js";
import { CONFIRMATION_TTL_MS, RUN_VIEW_POLL_MS } from "../core/budgets.js";
import type { PersonDirectory } from "../core/identity/contract.js";
import { identityKey } from "../core/identity/engine.js";
import {
  envelopeSchema,
  type OrganizationResult,
  type OrganizationStreamEntry,
} from "../core/organization/contract.js";
import type {
  OrganizationAdmissionInput,
  OrganizationAuthentication,
  OrganizationService,
} from "../core/organization/service.js";
import type { HomeConfirmationOffer, HomeConversationEntry, HomeDestination, HomeSession } from "./homeSeed.js";
import type { HomeCommandSeed, HomeSeed } from "./webSeed.js";
import type { HomeRepositories } from "./homeRepositories.js";
import { originAllowed } from "./commandHttp.js";
import { MAX_BODY_BYTES, readBody } from "./http.js";
import { SSE_HEADERS, SSE_PRELUDE } from "./liveView/sse.js";

/** The host verified this credential and resolved its current policy before routing. */
export interface HomeRuntimeContext {
  actor: Actor;
  authentication: OrganizationAuthentication;
}
export interface HomeThreadProjection {
  revision: number;
  label: string;
  canWrite: boolean;
  primaryAction?: { label: string; text: string };
  entries: HomeConversationEntry[];
  history: NonNullable<HomeSession["history"]>;
  turns?: HomeSeed["turns"];
  /** A current shared act, selected by its existing owner, never by the browser. */
  target?: NonNullable<OrganizationAdmissionInput["target"]>;
  offer?: HomeConfirmationOffer;
}
export type HomeReplayInput = Pick<
  OrganizationAdmissionInput,
  "key" | "content" | "context" | "destination" | "continuation"
> & { revision: number };
export interface HomeRuntimeOptions {
  organization: OrganizationService;
  directory: PersonDirectory;
  now: () => number;
  refresh: (context: HomeRuntimeContext) => Promise<HomeRuntimeContext | undefined>;
  currentEpoch: (context: HomeRuntimeContext) => Promise<string | undefined>;
  readThread: (context: HomeRuntimeContext, thread: string) => Promise<HomeThreadProjection | undefined>;
  submit: (context: HomeRuntimeContext, input: OrganizationAdmissionInput) => Promise<OrganizationResult>;
  replay?: (context: HomeRuntimeContext, input: HomeReplayInput) => Promise<OrganizationResult | undefined>;
  /** Success includes the original owner's private-content cleanup, not just a receipt tombstone. */
  deleteContent?: (context: HomeRuntimeContext, receiptId: string) => Promise<OrganizationResult>;
  commands: (context: HomeRuntimeContext) => HomeCommandSeed[];
  repositories?: (context: HomeRuntimeContext) => Promise<HomeRepositories>;
  currentOffer?: (
    context: HomeRuntimeContext,
    destination: HomeDestination,
  ) => Promise<HomeConfirmationOffer | undefined>;
  onAdmitted?: (organization: string) => void;
  subscribe?: (changed: (organization: string) => void) => () => void;
  publicBaseUrl?: string;
  keyTtlMs?: number;
  pollMs?: number;
  maxBodyBytes?: number;
}

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const focusSchema = z.object({ thread: z.string().min(1).max(2048) }).strict();
const sendSchema = z
  .object({
    key: z.string().min(1).max(2048),
    destination: envelopeSchema.shape.destination,
    revision,
    context: envelopeSchema.shape.context,
    text: z.string().min(1).max(32_768).optional(),
    confirmation: envelopeSchema.shape.continuation,
  })
  .strict()
  .refine(
    (value) =>
      (value.text !== undefined) !== (value.confirmation !== undefined) &&
      (!value.confirmation || value.context.length === 0),
  );
const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
type Issued = { key: string; expiresAt: number };

/** The caller owns authentication; browser arguments never select authority. */
export function createHomeRuntimeHandler(options: HomeRuntimeOptions) {
  const active = new Set<() => void>();
  let disposed = false;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  async function current(context: HomeRuntimeContext | undefined) {
    if (
      disposed ||
      !context ||
      context.actor.kind !== "user" ||
      context.authentication.source !== "browser" ||
      context.authentication.kind !== "human"
    )
      return;
    const refreshed = await options.refresh(context);
    if (
      !refreshed ||
      refreshed.actor.kind !== "user" ||
      refreshed.authentication.source !== "browser" ||
      refreshed.authentication.kind !== "human"
    )
      return;
    const resolved = await options.organization.resolve(refreshed.authentication);
    const epoch = await options.currentEpoch(refreshed);
    return !disposed && resolved?.actor.stream && typeof epoch === "string" && epoch.length > 0
      ? { context: refreshed, resolved, epoch }
      : undefined;
  }
  type Current = NonNullable<Awaited<ReturnType<typeof current>>>;
  const privacy = ({ context, resolved, epoch }: Current) =>
    JSON.stringify([
      context.actor.id,
      identityKey(context.authentication.identity),
      context.actor.viewingAs?.id ?? null,
      resolved.organization,
      resolved.actor.stream,
      resolved.actor.bindingRevision,
      epoch,
    ]);
  async function key(context: HomeRuntimeContext): Promise<Issued | undefined> {
    if (context.actor.viewingAs) return;
    const issued = await options.organization.issue(context.authentication, options.keyTtlMs ?? CONFIRMATION_TTL_MS);
    return issued.status === "key" ? issued : undefined;
  }
  function sendResult(res: ServerResponse, result: OrganizationResult, organization: string) {
    if (result.status === "receipt") {
      const receipt = result.receipt;
      if (receipt.status === "pending") options.onAdmitted?.(organization);
      reply(res, ["accepted", "pending"].includes(receipt.status) ? 200 : receipt.status === "throttled" ? 429 : 409, {
        status: receipt.status,
        revision: receipt.revision,
        duplicate: result.duplicate,
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      });
    } else
      reply(
        res,
        result.status === "not_found"
          ? 404
          : result.status === "invalid"
            ? 400
            : result.status === "unavailable"
              ? 503
              : 409,
        { status: result.status },
      );
  }
  async function privateEntries(entries: OrganizationStreamEntry[], viewer: Current): Promise<HomeConversationEntry[]> {
    return Promise.all(
      entries.map(async (entry) => {
        let isViewer = false;
        if (entry.role === "user" && !entry.onBehalfOf) {
          if (identityKey(entry.identity) === identityKey(viewer.context.authentication.identity)) isViewer = true;
          else {
            const binding = await options.directory.resolve(entry.identity);
            isViewer = binding.status === "bound" && binding.binding.personId === viewer.resolved.actor.stream;
          }
        }
        return {
          id: `${entry.receiptId}:${entry.sequence}`,
          role: entry.role,
          content: entry.content,
          isViewer,
          authorLabel: isViewer
            ? "You"
            : entry.role === "assistant"
              ? "Switchboard"
              : entry.role === "receipt"
                ? "Receipt"
                : entry.onBehalfOf
                  ? "Automation on your behalf"
                  : "Unknown author",
          source: entry.source,
          at: entry.createdAt,
          ...(options.deleteContent &&
          entry.source === "browser" &&
          identityKey(entry.identity) === identityKey(viewer.context.authentication.identity) &&
          !viewer.context.actor.viewingAs
            ? { deleteUrl: `/home/messages/${encodeURIComponent(entry.receiptId)}` }
            : {}),
        };
      }),
    );
  }
  async function load(
    initial: HomeRuntimeContext,
    thread: string | null,
    issued?: Issued,
    before?: number,
    observe = false,
  ) {
    const viewer = await current(initial);
    if (!viewer) return;
    if (!thread && viewer.context.actor.viewingAs) return;
    let projection: HomeThreadProjection | undefined;
    let entries: HomeConversationEntry[];
    let coverage: NonNullable<HomeSession["history"]>;
    let projectionRevision: number;
    if (thread) {
      projection = await options.readThread(viewer.context, thread);
      if (!projection) return;
      entries = projection.entries;
      coverage = projection.history;
      projectionRevision = projection.revision;
    } else {
      // A fresh tail rechecks every retained entry. A cached forward history
      // would retain content after another proved source loses its binding.
      const last = await options.organization.streamTail(viewer.context.authentication, 100, before);
      if (last.status !== "stream_tail") return;
      const window = [...last.entries];
      let bytes = window.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0);
      let clipped = false;
      while (bytes > maxBodyBytes && window.length > 1) {
        bytes -= Buffer.byteLength(window.shift()!.content);
        clipped = true;
      }
      projectionRevision = last.revision;
      entries = await privateEntries(window, viewer);
      coverage = {
        cursor: clipped ? window[0].sequence : last.beforeCursor,
        hasMore: clipped || last.hasMore || before !== undefined,
        status: clipped || last.hasMore || before !== undefined ? "partial" : "complete",
        ...(clipped || last.hasMore
          ? { previousUrl: `/home/session?before=${clipped ? window[0].sequence : last.beforeCursor}` }
          : {}),
        ...(before !== undefined ? { latestUrl: "/home/session" } : {}),
      };
    }
    const fresh = await current(viewer.context);
    if (!fresh || privacy(fresh) !== privacy(viewer)) return;
    if (!issued || issued.expiresAt <= options.now()) issued = await key(fresh.context);
    const destination: HomeDestination = {
      kind: thread ? "thread" : "broad",
      thread,
      label: projection?.label ?? "Your messages to Switchboard",
      revision: projection?.revision ?? fresh.resolved.actor.bindingRevision,
      canWrite: !fresh.context.actor.viewingAs && !!issued && (projection?.canWrite ?? true),
      ...(projection?.primaryAction ? { primaryAction: projection.primaryAction } : {}),
    };
    const offer = destination.canWrite
      ? (projection?.offer ?? (await options.currentOffer?.(fresh.context, destination)))
      : undefined;
    const checked = await current(fresh.context);
    if (!checked || privacy(checked) !== privacy(fresh)) return;
    if (thread) {
      const latest = await options.readThread(checked.context, thread);
      if (
        !latest ||
        latest.revision !== projection!.revision ||
        latest.canWrite !== projection!.canWrite ||
        latest.target?.key !== projection!.target?.key
      )
        return;
      const final = await current(checked.context);
      if (!final || privacy(final) !== privacy(checked)) return;
    }
    const repositories = !thread && destination.canWrite ? await options.repositories?.(fresh.context) : undefined;
    if (repositories) {
      const final = await current(fresh.context);
      if (!final || privacy(final) !== privacy(fresh)) return;
    }
    const value: HomeSession = {
      version: 1,
      organization: fresh.resolved.organization,
      actor: fresh.context.actor.id,
      stream: fresh.resolved.actor.stream!,
      bindingRevision: fresh.resolved.actor.bindingRevision,
      accessEpoch: fresh.epoch,
      revision: projectionRevision,
      entries,
      history: coverage,
      destination,
      sendUrl: "/home/send",
      eventsUrl: `/home/events${thread ? `?thread=${encodeURIComponent(thread)}${observe || !destination.canWrite ? "&observe=1" : ""}` : before !== undefined ? `?before=${before}` : ""}`,
      commands: options.commands(fresh.context),
      submissionKey: issued?.key ?? "read-only",
      ...(projection?.turns ? { turns: projection.turns } : {}),
      ...(offer ? { offer } : {}),
      ...(repositories ? { repositories } : {}),
    };
    return { value, viewer: fresh, issued, projection };
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (
      !(
        String(req.headers["content-type"] ?? "")
          .toLowerCase()
          .split(";")[0]
          .trim() === "application/json"
      )
    )
      return undefined;
    const read = await readBody(req, maxBodyBytes);
    if (!read.ok) return undefined;
    try {
      return JSON.parse(read.body);
    } catch {
      return undefined;
    }
  }
  async function serve(req: IncomingMessage, res: ServerResponse, context: HomeRuntimeContext | undefined, url: URL) {
    const selected = url.pathname.slice("/home/".length);
    let disconnected = req.destroyed;
    if (selected === "events")
      req.once("close", () => {
        disconnected = true;
      });
    const removal = selected.startsWith("messages/");
    const writing = removal || selected === "focus" || selected === "send";
    if (req.method !== (removal ? "DELETE" : writing ? "POST" : "GET")) {
      reply(res, 405, { status: "invalid" });
      return;
    }
    const viewer = await current(context);
    if (!viewer) {
      reply(res, 404, { status: "not_found" });
      return;
    }
    if (writing && (!originAllowed(req, options) || viewer.context.actor.viewingAs)) {
      reply(res, 403, { status: "not_found" });
      return;
    }
    if (removal) {
      const incoming = await readBody(req, maxBodyBytes);
      if (!incoming.ok || incoming.body.trim()) {
        reply(res, 400, { status: "invalid" });
        return;
      }
      let receiptId: string;
      try {
        receiptId = decodeURIComponent(selected.slice("messages/".length));
      } catch {
        reply(res, 400, { status: "invalid" });
        return;
      }
      if (!receiptId || receiptId.length > 2048 || /[\s\p{Cc}]/u.test(receiptId)) {
        reply(res, 400, { status: "invalid" });
        return;
      }
      const fresh = await current(viewer.context);
      if (!fresh || privacy(fresh) !== privacy(viewer)) {
        reply(res, 403, { status: "not_found" });
        return;
      }
      const outcome = await options.deleteContent?.(fresh.context, receiptId);
      const status = outcome?.status ?? "unavailable";
      reply(res, status === "ok" ? 200 : status === "not_found" ? 404 : 503, { status });
      return;
    }
    if (selected === "key") {
      if (!originAllowed(req, options)) {
        reply(res, 403, { status: "not_found" });
        return;
      }
      const issued = await key(viewer.context);
      reply(res, issued ? 200 : 403, issued ? { key: issued.key } : { status: "not_found" });
      return;
    }
    if (selected === "send") {
      const parsed = sendSchema.safeParse(await body(req));
      if (!parsed.success || (parsed.data.text !== undefined && !parsed.data.text.trim())) {
        reply(res, 400, { status: "invalid" });
        return;
      }
      const input = parsed.data;
      const replayContext = await current(viewer.context);
      if (!replayContext || privacy(replayContext) !== privacy(viewer)) {
        reply(res, 409, { status: "stale", reason: "Your access changed." });
        return;
      }
      const reference = replayContext.context.authentication.sourceReference;
      if (!reference || reference.actorId !== replayContext.context.actor.id) {
        reply(res, 403, { status: "not_found" });
        return;
      }
      const replayInput: HomeReplayInput = {
        key: input.key,
        content: input.text ?? "",
        context: input.context,
        destination: input.destination,
        revision: input.revision,
        ...(input.confirmation ? { continuation: input.confirmation } : {}),
      };
      const previous = options.replay
        ? await options.replay(replayContext.context, replayInput)
        : await options.organization.replay(replayContext.context.authentication, replayInput);
      if (previous) {
        const checked = await current(replayContext.context);
        if (!checked || privacy(checked) !== privacy(replayContext)) {
          reply(res, 404, { status: "not_found" });
          return;
        }
        sendResult(res, previous, checked.resolved.organization);
        return;
      }
      const projection =
        input.destination.kind === "thread"
          ? await options.readThread(replayContext.context, input.destination.thread)
          : undefined;
      if (input.destination.kind === "thread" && (!projection || !projection.canWrite)) {
        reply(res, 404, { status: "not_found" });
        return;
      }
      if (!input.confirmation && input.revision !== (projection?.revision ?? viewer.resolved.actor.bindingRevision)) {
        reply(res, 409, { status: "stale", reason: "The destination changed." });
        return;
      }
      const fresh = await current(viewer.context);
      if (!fresh || privacy(fresh) !== privacy(viewer)) {
        reply(res, 409, { status: "stale", reason: "Your access changed." });
        return;
      }
      if (input.confirmation) {
        const destination: HomeDestination = {
          kind: input.destination.kind,
          thread: input.destination.kind === "thread" ? input.destination.thread : null,
          label: projection?.label ?? "Your messages to Switchboard",
          revision: projection?.revision ?? fresh.resolved.actor.bindingRevision,
          canWrite: true,
          ...(projection?.primaryAction ? { primaryAction: projection.primaryAction } : {}),
        };
        const offered = projection?.offer ?? (await options.currentOffer?.(fresh.context, destination));
        if (
          !offered ||
          offered.id !== input.confirmation.id ||
          (offered.expiresAt !== undefined && offered.expiresAt <= options.now())
        ) {
          reply(res, 404, { status: "not_found" });
          return;
        }
        const checked = await current(fresh.context);
        if (!checked || privacy(checked) !== privacy(fresh)) {
          reply(res, 404, { status: "not_found" });
          return;
        }
      }
      const actual = {
        ...fresh.context,
        authentication: {
          ...fresh.context.authentication,
          sourceReference: {
            ...reference,
            messageId: `browser:${input.key}`,
            browserRevision: input.confirmation
              ? input.revision
              : (projection?.revision ?? fresh.resolved.actor.bindingRevision),
            threadKey: input.destination.kind === "thread" ? input.destination.thread : reference.threadKey,
          },
        },
      };
      const admitted = await options.submit(actual, {
        sourceEvent: input.key,
        key: input.key,
        destination: input.destination,
        workload: input.confirmation || projection?.target ? "act" : "message",
        target: !input.confirmation && projection?.target ? projection.target : null,
        content: input.text ?? "",
        context: input.context,
        ...(input.confirmation ? { continuation: input.confirmation } : {}),
      });
      sendResult(res, admitted, fresh.resolved.organization);
      return;
    }
    const focused = selected === "focus" ? focusSchema.safeParse(await body(req)) : undefined;
    if (focused && !focused.success) {
      reply(res, 400, { status: "invalid" });
      return;
    }
    const thread = focused?.success
      ? focused.data.thread
      : selected === "events" || selected === "session"
        ? url.searchParams.get("thread")
        : null;
    const rawBefore = url.searchParams.get("before");
    const before =
      rawBefore === null
        ? undefined
        : /^\d+$/.test(rawBefore) && revision.safeParse(Number(rawBefore)).success
          ? Number(rawBefore)
          : null;
    if (before === null) {
      reply(res, 400, { status: "invalid" });
      return;
    }
    const observe = url.searchParams.get("observe") === "1";
    let loaded = await load(viewer.context, thread, undefined, before, observe);
    if (selected === "events" && disconnected) {
      res.end();
      return;
    }
    if (!loaded || (selected === "focus" && !loaded.value.destination.canWrite)) {
      reply(res, 404, { status: "not_found" });
      return;
    }
    if (selected !== "events") {
      reply(res, 200, loaded.value);
      return;
    }
    const initialPrivacy = privacy(loaded.viewer);
    let closed = false,
      refreshing = false,
      dirty = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      unsubscribe();
      active.delete(close);
      res.end();
    };
    const revoke = () => {
      if (closed) return;
      res.write("event: revoked\ndata: {}\n\n");
      close();
    };
    let serialized = JSON.stringify(loaded.value);
    res.writeHead(200, { ...SSE_HEADERS, "cache-control": "no-store, no-transform" });
    res.write(SSE_PRELUDE);
    res.write(`data: ${serialized}\n\n`);
    const refresh = async () => {
      if (closed) return;
      if (refreshing) {
        dirty = true;
        return;
      }
      refreshing = true;
      try {
        const next = await load(loaded!.viewer.context, thread, loaded!.issued, before, observe);
        if (closed) return;
        if (
          !next ||
          privacy(next.viewer) !== initialPrivacy ||
          (thread && !observe && !next.value.destination.canWrite)
        ) {
          revoke();
          return;
        }
        loaded = next;
        const frame = JSON.stringify(next.value);
        if (frame !== serialized) {
          res.write(`data: ${frame}\n\n`);
          serialized = frame;
        } else res.write(": hb\n\n");
      } catch {
        if (!closed) {
          res.write("event: unavailable\ndata: {}\n\n");
          close();
        }
      } finally {
        refreshing = false;
        if (dirty && !closed) {
          dirty = false;
          void refresh();
        }
      }
    };
    active.add(close);
    req.on("close", close);
    unsubscribe =
      options.subscribe?.((organization) => {
        if (organization === loaded!.viewer.resolved.organization) void refresh();
      }) ?? (() => {});
    timer = setInterval(() => {
      void refresh();
    }, options.pollMs ?? RUN_VIEW_POLL_MS);
    timer.unref?.();
  }
  const handler = (req: IncomingMessage, res: ServerResponse, context?: HomeRuntimeContext): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!/^\/home\/(session|key|focus|send|events|messages\/[^/]+)$/.test(url.pathname)) return false;
    void serve(req, res, context, url).catch(() => {
      if (!res.headersSent) reply(res, 503, { status: "unavailable" });
      else res.end();
    });
    return true;
  };
  return Object.assign(handler, {
    dispose: () => {
      disposed = true;
      for (const close of [...active]) close();
    },
  });
}
