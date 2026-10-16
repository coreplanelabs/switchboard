import { computed, inject, ref, type InjectionKey } from "vue";
import type { OrganizationEnvelope } from "@core/core/organization/contract.js";
import { stripSlash } from "../../src/lib/slashCompleter";
import type { EventSourceFactory, EventSourceLike } from "../../src/lib/eventSource";

export type { HomeSession } from "@core/channels/homeSeed.js";
import type { HomeSession, HomeConfirmationOffer, HomeConfirmationChoice } from "@core/channels/homeSeed.js";
export type AttachedContext = OrganizationEnvelope["context"][number] & { label: string };
export type HomeSessionStatus = "loading" | "ready" | "unavailable";
function isOffer(value: unknown): value is HomeConfirmationOffer {
  if (!value || typeof value !== "object") return false;
  const offer = value as Partial<HomeConfirmationOffer>;
  return (
    typeof offer.id === "string" &&
    offer.id.length > 0 &&
    typeof offer.line === "string" &&
    offer.line.length > 0 &&
    (offer.risk === undefined || typeof offer.risk === "string") &&
    (offer.question === undefined || typeof offer.question === "string") &&
    (offer.expiresAt === undefined || (typeof offer.expiresAt === "number" && Number.isSafeInteger(offer.expiresAt)))
  );
}
export function isHomeSession(value: unknown): value is HomeSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<HomeSession>;
  return (
    s.version === 1 &&
    (s.offer === undefined || isOffer(s.offer)) &&
    typeof s.organization === "string" &&
    typeof s.actor === "string" &&
    typeof s.stream === "string" &&
    typeof s.bindingRevision === "number" &&
    Number.isSafeInteger(s.bindingRevision) &&
    s.bindingRevision >= 0 &&
    Number.isSafeInteger(s.revision) &&
    Array.isArray(s.entries) &&
    s.entries.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.id.length > 0 &&
        typeof entry.content === "string" &&
        typeof entry.isViewer === "boolean" &&
        ["user", "assistant", "receipt"].includes(entry.role) &&
        (entry.authorLabel === undefined || typeof entry.authorLabel === "string") &&
        (entry.source === undefined || typeof entry.source === "string") &&
        (entry.sourceUrl === undefined || typeof entry.sourceUrl === "string") &&
        (entry.at === undefined || (typeof entry.at === "number" && Number.isSafeInteger(entry.at))),
    ) &&
    (s.history === undefined ||
      (!!s.history &&
        Number.isSafeInteger(s.history.cursor) &&
        typeof s.history.hasMore === "boolean" &&
        ["complete", "partial", "unavailable"].includes(s.history.status))) &&
    typeof s.sendUrl === "string" &&
    s.sendUrl.startsWith("/home/") &&
    typeof s.eventsUrl === "string" &&
    s.eventsUrl.startsWith("/home/") &&
    !!s.destination &&
    ["broad", "thread"].includes(s.destination.kind) &&
    typeof s.destination.label === "string" &&
    typeof s.destination.canWrite === "boolean" &&
    Number.isSafeInteger(s.destination.revision) &&
    (s.destination.kind === "broad" ? s.destination.thread === null : typeof s.destination.thread === "string") &&
    Array.isArray(s.commands) &&
    s.commands.every(
      (command) => !!command && typeof command.chat === "string" && typeof command.describe === "string",
    ) &&
    typeof s.submissionKey === "string" &&
    s.submissionKey.length > 0
  );
}

export function createHomeSession(fetchFn: typeof fetch, makeSource: EventSourceFactory) {
  const session = ref<HomeSession | null>(null);
  const status = ref<HomeSessionStatus>("loading");
  const text = ref("");
  const scroll = ref(0);
  const context = ref<AttachedContext[]>([]);
  const sending = ref(false);
  const notice = ref("");
  const offer = ref<HomeConfirmationOffer | null>(null);
  const focused = computed(() => session.value?.destination.kind === "thread");
  const drafts = new Map<string, { text: string; context: AttachedContext[]; scroll: number }>();
  let broad: HomeSession | null = null;
  let source: EventSourceLike | null = null;
  let generation = 0;
  let loadGeneration = 0;
  let focusGeneration = 0;
  let submissionGeneration = 0;
  let disposed = false;
  let activePrivacy: string | null = null;
  let activeRoute = "";
  const retries = new Map<string, { key: string; body: unknown; rawDraft?: string }>();
  const attempted = new Set<string>();
  const privacyKey = (s: HomeSession) => `${s.actor}\u0000${s.organization}\u0000${s.stream}\u0000${s.bindingRevision}`;
  const destinationKey = (s: HomeSession) =>
    `${privacyKey(s)}\u0000${s.destination.kind}\u0000${s.destination.thread ?? ""}`;
  function keepDraft() {
    if (session.value)
      drafts.set(destinationKey(session.value), { text: text.value, context: context.value, scroll: scroll.value });
  }
  function adopt(next: HomeSession) {
    offer.value = null;
    if (activePrivacy !== null && privacyKey(next) !== activePrivacy) {
      drafts.clear();
      broad = null;
      retries.clear();
      attempted.clear();
      submissionGeneration++;
      sending.value = false;
    }
    activePrivacy = privacyKey(next);
    session.value = next;
    const draft = drafts.get(destinationKey(next));
    text.value = draft?.text ?? "";
    context.value = draft?.context ?? [];
    scroll.value = draft?.scroll ?? 0;
    status.value = "ready";
  }
  function unavailable(message = "Conversation is unavailable with your current access.") {
    offer.value = null;
    generation++;
    loadGeneration++;
    submissionGeneration++;
    source?.close();
    source = null;
    session.value = null;
    broad = null;
    drafts.clear();
    text.value = "";
    scroll.value = 0;
    context.value = [];
    retries.clear();
    attempted.clear();
    activePrivacy = null;
    sending.value = false;
    status.value = "unavailable";
    notice.value = message;
  }
  function follow(next: HomeSession) {
    source?.close();
    source = makeSource(next.eventsUrl);
    const ownGeneration = generation;
    source.onmessage = (event) => {
      if (ownGeneration !== generation) return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const incoming =
        frame && typeof frame === "object" && "session" in frame ? (frame as { session: unknown }).session : frame;
      if (!isHomeSession(incoming)) return;
      if (
        privacyKey(incoming) !== privacyKey(next) ||
        incoming.destination.kind !== next.destination.kind ||
        incoming.destination.thread !== next.destination.thread
      ) {
        unavailable();
        return;
      }
      if (session.value && incoming.revision < session.value.revision) return;
      session.value = incoming;
      offer.value = incoming.offer ?? null;
      if (incoming.destination.kind === "broad") broad = incoming;
    };
    source.addEventListener("revoked", () => {
      if (ownGeneration === generation) unavailable();
    });
    source.addEventListener("unavailable", () => {
      if (ownGeneration === generation) unavailable();
    });
    source.onerror = () => {
      if (ownGeneration !== generation) return;
      notice.value = "Connection lost. The last confirmed conversation is shown.";
    };
    source.onopen = () => {
      if (ownGeneration !== generation) return;
      notice.value = "";
    };
  }
  async function load() {
    if (disposed) return;
    const requestGeneration = ++loadGeneration;
    generation++;
    const destinationGeneration = generation;
    offer.value = null;
    submissionGeneration++;
    sending.value = false;
    status.value = "loading";
    source?.close();
    try {
      const response = await fetchFn("/home/session", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const value: unknown = await response.json();
      if (requestGeneration !== loadGeneration || disposed) return;
      if (!response.ok || !isHomeSession(value) || value.destination.kind !== "broad") {
        unavailable();
        return;
      }
      keepDraft();
      adopt(value);
      broad = value;
      if (destinationGeneration === generation) offer.value = value.offer ?? null;
      follow(value);
    } catch {
      if (requestGeneration === loadGeneration && !disposed) unavailable("Conversation could not be loaded.");
    }
  }
  async function focus(thread: string) {
    if (sending.value || status.value !== "ready") return false;
    const route = activeRoute;
    offer.value = null;
    const requestGeneration = ++focusGeneration;
    const destinationGeneration = generation;
    try {
      const response = await fetchFn("/home/focus", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread }),
      });
      const value: unknown = await response.json();
      if (requestGeneration !== focusGeneration || destinationGeneration !== generation || route !== activeRoute)
        return false;
      if (
        !response.ok ||
        !isHomeSession(value) ||
        value.destination.kind !== "thread" ||
        value.destination.thread !== thread ||
        !value.destination.canWrite ||
        !session.value
      ) {
        notice.value = "This thread is unavailable for replies with your current access.";
        if (session.value) follow(session.value);
        return false;
      }
      if (privacyKey(value) !== activePrivacy) {
        unavailable();
        return false;
      }
      keepDraft();
      generation++;
      adopt(value);
      follow(value);
      notice.value = "";
      return true;
    } catch {
      if (requestGeneration === focusGeneration && destinationGeneration === generation) {
        notice.value = "The reply destination could not be verified. Your destination did not change.";
        if (session.value) follow(session.value);
      }
      return false;
    }
  }
  function exitFocus() {
    if (!focused.value || !broad) return;
    offer.value = null;
    generation++;
    keepDraft();
    adopt(broad);
    follow(broad);
    notice.value = "";
  }
  function routeChanged(route: string) {
    if (route !== activeRoute) {
      offer.value = null;
      generation++;
      keepDraft();
      if (focused.value && broad) adopt(broad);
      if (session.value && status.value === "ready") follow(session.value);
      activeRoute = route;
    }
  }
  function attach(value: AttachedContext) {
    if (!session.value || context.value.length >= 8) return;
    if (!context.value.some((v) => v.kind === value.kind && v.key === value.key))
      context.value = [...context.value, value];
  }
  async function submit() {
    const current = session.value;
    if (!current || !text.value.trim()) return;
    const rawDraft = text.value;
    await send({ text: stripSlash(rawDraft.trim(), current.commands) }, rawDraft);
  }
  async function submitConfirmation(choice: HomeConfirmationChoice) {
    if (!offer.value || offer.value.id !== choice.id || !["confirm", "cancel"].includes(choice.kind)) return;
    await send({ confirmation: { kind: choice.kind, id: choice.id } });
  }
  async function send(input: { text: string } | { confirmation: HomeConfirmationChoice }, rawDraft?: string) {
    const s = session.value;
    if (!s || status.value !== "ready" || !s.destination.canWrite || sending.value) return;
    const payload = {
      ...input,
      destination:
        s.destination.kind === "broad" ? { kind: "broad" } : { kind: "thread", thread: s.destination.thread },
      revision: s.destination.revision,
      context: context.value.map(({ kind, key }) => ({ kind, key })),
    };
    const ownGeneration = generation;
    const ownSubmission = ++submissionGeneration;
    const ownPrivacy = privacyKey(s);
    const draftKey = destinationKey(s);
    let retry = retries.get(draftKey);
    sending.value = true;
    notice.value = "";
    const unchangedRaw = typeof rawDraft === "string" && retry?.rawDraft === rawDraft;
    const previousIntent = retry
      ? {
          ...(retry.body as { text: string }),
          key: undefined,
          revision: undefined,
          text: unchangedRaw ? undefined : (retry.body as { text: string }).text,
        }
      : null;
    const nextIntent = {
      ...payload,
      revision: undefined,
      text: unchangedRaw ? undefined : "text" in payload ? payload.text : undefined,
    };
    if (!retry || JSON.stringify(previousIntent) !== JSON.stringify(nextIntent)) {
      let key = s.submissionKey;
      if (retry || attempted.has(key)) {
        try {
          const response = await fetchFn("/home/key", {
            credentials: "same-origin",
            headers: { accept: "application/json" },
          });
          const issued = (await response.json()) as { key?: unknown };
          if (!response.ok || typeof issued.key !== "string" || !issued.key) throw new Error("key unavailable");
          key = issued.key;
        } catch {
          if (ownGeneration === generation && ownPrivacy === activePrivacy)
            notice.value = "A new submission could not be authorized. Your message was not sent.";
          if (ownSubmission === submissionGeneration) sending.value = false;
          return;
        }
      }
      if (ownGeneration !== generation) {
        if (ownSubmission === submissionGeneration) sending.value = false;
        return;
      }
      retry = { key, body: { ...payload, key }, rawDraft };
      retries.set(draftKey, retry);
    }
    if (ownGeneration !== generation) {
      if (ownSubmission === submissionGeneration) sending.value = false;
      return;
    }
    try {
      // An uncertain attempt still owns its key; a different intent needs a fresh one.
      attempted.add(retry.key);
      const response = await fetchFn(s.sendUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(retry.body),
      });
      const receipt = (await response.json()) as {
        status?: string;
        reason?: string;
        revision?: number;
        duplicate?: boolean;
        delivery?: string;
        offer?: unknown;
      };
      const incomingOffer = response.ok && isOffer(receipt.offer) ? receipt.offer : null;
      const accepted =
        response.ok && (["accepted", "pending"].includes(receipt.status ?? "") || incomingOffer !== null);
      if (accepted && ownPrivacy === activePrivacy && retries.get(draftKey)?.key === retry.key) {
        const stored = drafts.get(draftKey);
        const matchesContext = (refs: AttachedContext[]) =>
          JSON.stringify(refs.map(({ kind, key }) => ({ kind, key }))) === JSON.stringify(payload.context);
        if (typeof rawDraft === "string" && stored?.text === rawDraft && matchesContext(stored.context))
          drafts.set(draftKey, { ...stored, text: "", context: [] });
        retries.delete(draftKey);
        if (
          typeof rawDraft === "string" &&
          session.value &&
          destinationKey(session.value) === draftKey &&
          text.value === rawDraft &&
          matchesContext(context.value)
        ) {
          text.value = "";
          context.value = [];
        }
      }
      if (ownGeneration !== generation) return;
      if ([401, 403, 404].includes(response.status)) {
        unavailable();
        return;
      }
      if (response.status >= 500) {
        notice.value = "The result could not be confirmed. Retry returns the same submission receipt.";
        return;
      }
      if (session.value && destinationKey(session.value) === draftKey) {
        if (incomingOffer) {
          offer.value = incomingOffer;
          notice.value = "Review the saved action before choosing.";
          return;
        }
        if ("confirmation" in input && offer.value?.id === input.confirmation.id) offer.value = null;
      }
      if (!accepted) {
        notice.value = receipt.reason ?? "This message was not accepted.";
        retries.delete(draftKey);
        return;
      }
      notice.value = receipt.duplicate
        ? "The original message was already accepted. It was not sent twice."
        : receipt.status === "pending"
          ? "Message accepted. Processing is pending."
          : "Message accepted.";
      if (receipt.delivery === "failed") notice.value += " Source delivery failed; acceptance is unchanged.";
    } catch {
      if (ownGeneration === generation)
        notice.value = "The result could not be confirmed. Retry returns the same submission receipt.";
    } finally {
      if (ownSubmission === submissionGeneration) sending.value = false;
    }
  }
  function dispose() {
    unavailable("Conversation closed.");
    disposed = true;
  }
  return {
    session,
    status,
    text,
    scroll,
    context,
    sending,
    notice,
    offer,
    focused,
    load,
    focus,
    exitFocus,
    routeChanged,
    attach,
    submit,
    submitConfirmation,
    dispose,
  };
}
export type HomeSessionController = ReturnType<typeof createHomeSession>;
export const HomeSessionKey: InjectionKey<HomeSessionController> = Symbol("home-session");
export function useHomeSession() {
  return inject(HomeSessionKey, null);
}
