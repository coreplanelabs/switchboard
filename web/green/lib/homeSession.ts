import { computed, inject, ref, shallowReactive, watch, type InjectionKey } from "vue";
import type { OrganizationEnvelope } from "@core/core/organization/contract.js";
import { ORG_RECEIPT_TTL_MS, ORG_RECONCILE_BATCH_MAX } from "@core/core/budgets.js";
import { browser } from "../../src/lib/browser";
import { wallNow } from "../../src/lib/wallClock";
import { stripSlash } from "../../src/lib/slashCompleter";
import { EVENT_SOURCE_CLOSED, type EventSourceFactory, type EventSourceLike } from "../../src/lib/eventSource";

export type { HomeSession } from "@core/channels/homeSeed.js";
import type {
  HomeSession,
  HomeConfirmationOffer,
  HomeConfirmationChoice,
  HomeAnswerTarget,
  HomePrimaryAction,
} from "@core/channels/homeSeed.js";
export type AttachedContext = OrganizationEnvelope["context"][number] & { label: string };
type EarlierRequest = { key: string; expiresAt: number; message?: string; checking?: boolean };
export type HomeSessionStatus = "loading" | "ready" | "unavailable";
function isPrimaryAction(value: unknown): value is HomePrimaryAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Partial<HomePrimaryAction>;
  return (
    Object.keys(value).every((key) => key === "label" || key === "text") &&
    typeof action.label === "string" &&
    !!action.label.trim() &&
    action.label.length <= 64 &&
    typeof action.text === "string" &&
    !!action.text.trim() &&
    action.text.length <= 4096
  );
}
function isOffer(value: unknown): value is HomeConfirmationOffer {
  if (!value || typeof value !== "object") return false;
  const offer = value as Partial<HomeConfirmationOffer>;
  return (
    typeof offer.id === "string" &&
    offer.id.length > 0 &&
    typeof offer.line === "string" &&
    offer.line.length > 0 &&
    (offer.actionLabel === undefined ||
      (typeof offer.actionLabel === "string" && !!offer.actionLabel.trim() && offer.actionLabel.length <= 64)) &&
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
    (s.repositories === undefined ||
      (!!s.repositories &&
        ["complete", "unavailable"].includes(s.repositories.status) &&
        Array.isArray(s.repositories.repositories) &&
        s.repositories.repositories.length <= 1000 &&
        s.repositories.repositories.every(
          (row) => !!row && typeof row.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repo),
        ) &&
        (s.repositories.status !== "unavailable" || s.repositories.repositories.length === 0))) &&
    typeof s.organization === "string" &&
    typeof s.actor === "string" &&
    typeof s.stream === "string" &&
    typeof s.bindingRevision === "number" &&
    Number.isSafeInteger(s.bindingRevision) &&
    s.bindingRevision >= 0 &&
    typeof s.accessEpoch === "string" &&
    s.accessEpoch.length > 0 &&
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
        (entry.deleteUrl === undefined ||
          (typeof entry.deleteUrl === "string" && /^\/home\/messages\/[^/?#]+$/.test(entry.deleteUrl))) &&
        (entry.at === undefined || (typeof entry.at === "number" && Number.isSafeInteger(entry.at))),
    ) &&
    (s.history === undefined ||
      (!!s.history &&
        Number.isSafeInteger(s.history.cursor) &&
        typeof s.history.hasMore === "boolean" &&
        ["complete", "partial", "unavailable"].includes(s.history.status) &&
        [s.history.previousUrl, s.history.latestUrl].every(
          (url) => url === undefined || (typeof url === "string" && /^\/home\/session(?:\?[^#]*)?$/.test(url)),
        ))) &&
    (s.receiptRetentionMs === undefined || (Number.isSafeInteger(s.receiptRetentionMs) && s.receiptRetentionMs > 0)) &&
    typeof s.sendUrl === "string" &&
    s.sendUrl.startsWith("/home/") &&
    typeof s.eventsUrl === "string" &&
    s.eventsUrl.startsWith("/home/") &&
    !!s.destination &&
    (s.destination.primaryAction === undefined || isPrimaryAction(s.destination.primaryAction)) &&
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
  const scopeChanging = ref(false);
  const revocations = ref(0);
  const contentRemovals = ref(0);
  // An invalidation identity only: no transcript, draft or composing capability.
  const recoveringPrivacy = ref<string | null>(null);
  const text = ref("");
  const scroll = ref(0);
  const context = ref<AttachedContext[]>([]);
  const sending = ref(false);
  const historyLoading = ref(false);
  const removing = ref<string | null>(null);
  const notice = ref("");
  const earlierRequests = ref<EarlierRequest[]>([]);
  const earlierPersistent = ref(true);
  let volatileEarlier: { scope: string; items: EarlierRequest[] } | null = null;
  const earlierStorage = (s: HomeSession) => `switchboard:earlier:${JSON.stringify([s.organization, s.actor])}`;
  function readEarlier(s: HomeSession): EarlierRequest[] {
    const raw = browser.readPref(earlierStorage(s));
    if (!raw)
      return volatileEarlier?.scope === earlierStorage(s)
        ? volatileEarlier.items.filter((item) => item.expiresAt > wallNow())
        : [];
    if (raw.length > ORG_RECONCILE_BATCH_MAX * 4096) return [];
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value) || value.length > ORG_RECONCILE_BATCH_MAX) return [];
      return value.filter(
        (item): item is EarlierRequest =>
          !!item &&
          typeof item === "object" &&
          Object.keys(item).every((key) => key === "key" || key === "expiresAt") &&
          typeof item.key === "string" &&
          item.key.length > 0 &&
          item.key.length <= 2048 &&
          Number.isSafeInteger(item.expiresAt) &&
          item.expiresAt > wallNow(),
      );
    } catch {
      return [];
    }
  }
  function writeEarlier(s: HomeSession, items: EarlierRequest[]) {
    const stored = items.map(({ key, expiresAt }) => ({ key, expiresAt }));
    const raw = JSON.stringify(stored);
    volatileEarlier = { scope: earlierStorage(s), items: stored };
    browser.writePref(earlierStorage(s), raw);
    earlierPersistent.value = browser.readPref(earlierStorage(s)) === raw;
    if (session.value?.organization === s.organization && session.value.actor === s.actor)
      earlierRequests.value = items;
  }
  function rememberEarlier(s: HomeSession, key: string) {
    const items = readEarlier(s);
    if (items.some((item) => item.key === key)) return true;
    if (items.length >= ORG_RECONCILE_BATCH_MAX || key.length > 2048) return false;
    writeEarlier(s, [
      ...items,
      { key, expiresAt: Math.min(Number.MAX_SAFE_INTEGER, wallNow() + (s.receiptRetentionMs ?? ORG_RECEIPT_TTL_MS)) },
    ]);
    return true;
  }
  function forgetEarlierRequest(key: string) {
    const current = session.value;
    if (current)
      writeEarlier(
        current,
        readEarlier(current).filter((item) => item.key !== key),
      );
  }
  async function checkEarlierRequest(key: string) {
    const current = session.value;
    const item = earlierRequests.value.find((item) => item.key === key);
    if (!current || !item || item.checking || status.value !== "ready") return;
    const scope = privacyKey(current);
    item.checking = true;
    try {
      const response = await fetchFn(`/home/submissions/${encodeURIComponent(key)}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const result = (await response.json()) as {
        status?: string;
        admission?: string;
        dispatch?: string;
        nativeEffect?: string;
      };
      if (!session.value || privacyKey(session.value) !== scope || status.value !== "ready") return;
      const target = earlierRequests.value.find((row) => row.key === key);
      if (!target) return;
      target.message =
        !response.ok || result.status !== "known"
          ? "The original request status is unknown. No action was retried."
          : result.admission === "accepted"
            ? result.dispatch === "handler_returned"
              ? "The original request was accepted. Its processing step returned; action and work results are not confirmed here."
              : "The original request was accepted. Its processing result is not confirmed here."
            : result.admission === "pending"
              ? "The original request was recorded. Processing is pending. No action was retried."
              : ["rejected", "stale", "throttled"].includes(result.admission ?? "")
                ? "The original request was refused. No action was retried."
                : "The original request status is unknown. No action was retried.";
    } catch {
      if (session.value && privacyKey(session.value) === scope)
        item.message = "The original request status is unknown. No action was retried.";
    } finally {
      item.checking = false;
    }
  }
  const offer = ref<HomeConfirmationOffer | null>(null);
  const inlineAnswer = ref<(HomeAnswerTarget & { unit: string; title: string }) | null>(null);
  const focused = computed(() => session.value?.destination.kind === "thread");
  const observedRevision = ref<number | null>(null);
  const draftStale = computed(
    () =>
      focused.value &&
      observedRevision.value !== null &&
      observedRevision.value !== session.value?.destination.revision,
  );
  let restoringDraft = false;
  watch(
    [text, context],
    () => {
      if (restoringDraft) return;
      if (!text.value.trim() && !context.value.length) observedRevision.value = null;
      else if (observedRevision.value === null) observedRevision.value = session.value?.destination.revision ?? null;
    },
    { flush: "sync", deep: true },
  );
  const drafts = new Map<
    string,
    { text: string; context: AttachedContext[]; scroll: number; revision: number | null }
  >();
  let broad: HomeSession | null = null;
  let source: EventSourceLike | null = null;
  let generation = 0;
  let loadGeneration = 0;
  let focusGeneration = 0;
  let submissionGeneration = 0;
  let disposed = false;
  let activePrivacy: string | null = null;
  let activeRoute = "";
  const retries = shallowReactive(
    new Map<string, { key: string; body: unknown; rawDraft?: string; savedOffer?: HomeConfirmationOffer }>(),
  );
  const attempted = new Set<string>();
  const privacyKey = (s: HomeSession) =>
    `${s.actor}\u0000${s.organization}\u0000${s.stream}\u0000${s.bindingRevision}\u0000${s.accessEpoch}`;
  const destinationKey = (s: HomeSession) =>
    `${privacyKey(s)}\u0000${s.destination.kind}\u0000${s.destination.thread ?? ""}`;
  const pendingChoice = computed(() =>
    session.value
      ? ((retries.get(destinationKey(session.value))?.body as { confirmation?: HomeConfirmationChoice } | undefined)
          ?.confirmation ?? null)
      : null,
  );
  const pendingSubmission = computed(() => !!session.value && retries.has(destinationKey(session.value)));
  function offerFor(value: HomeSession) {
    return retries.get(destinationKey(value))?.savedOffer ?? value.offer ?? null;
  }
  function keepDraft() {
    if (session.value)
      drafts.set(destinationKey(session.value), {
        text: text.value,
        context: context.value,
        scroll: scroll.value,
        revision: observedRevision.value,
      });
  }
  function adopt(next: HomeSession) {
    scopeChanging.value = false;
    offer.value = null;
    if (activePrivacy !== null && privacyKey(next) !== activePrivacy) {
      inlineAnswer.value = null;
      drafts.clear();
      broad = null;
      retries.clear();
      attempted.clear();
      submissionGeneration++;
      sending.value = false;
    }
    activePrivacy = privacyKey(next);
    restoringDraft = true;
    session.value = next;
    earlierRequests.value = readEarlier(next);
    const draft = drafts.get(destinationKey(next));
    observedRevision.value = draft?.revision ?? null;
    text.value = draft?.text ?? "";
    context.value = draft?.context ?? [];
    scroll.value = draft?.scroll ?? 0;
    restoringDraft = false;
    status.value = "ready";
    offer.value = offerFor(next);
    recoveringPrivacy.value = null;
  }
  function resetPrivate(
    message = "Dashboard scope changed. Personal messages are hidden until the new view is confirmed.",
  ) {
    scopeChanging.value = true;
    unavailable(message);
  }
  function unavailable(message = "Conversation is unavailable with your current access.") {
    inlineAnswer.value = null;
    offer.value = null;
    generation++;
    loadGeneration++;
    submissionGeneration++;
    source?.close();
    source = null;
    session.value = null;
    recoveringPrivacy.value = null;
    earlierRequests.value = [];
    broad = null;
    drafts.clear();
    text.value = "";
    scroll.value = 0;
    context.value = [];
    retries.clear();
    attempted.clear();
    activePrivacy = null;
    sending.value = false;
    historyLoading.value = false;
    removing.value = null;
    status.value = "unavailable";
    notice.value = message;
  }
  async function recoverFocused(previous: HomeSession) {
    if (!session.value || previous.destination.kind !== "thread" || privacyKey(previous) !== activePrivacy) {
      unavailable();
      return;
    }
    const expectedPrivacy = privacyKey(previous);
    const thread = previous.destination.thread;
    const routeUnit = /^\/runs\/unit\/([^/?#]+)/.exec(activeRoute)?.[1];
    let unit = inlineAnswer.value?.unit;
    if (!unit && routeUnit) {
      try {
        unit = decodeURIComponent(routeUnit);
      } catch {
        /* An unproved reference is not matched. */
      }
    }
    const affected = (item: AttachedContext) =>
      (item.kind === "thread" && item.key === thread) || (item.kind === "unit" && item.key === unit);
    const closedDestination = destinationKey(previous);
    drafts.delete(closedDestination);
    retries.delete(closedDestination);
    for (const [key, draft] of drafts) {
      if (key.startsWith(expectedPrivacy + "\u0000"))
        drafts.set(key, { ...draft, context: draft.context.filter((item) => !affected(item)) });
    }
    const requestGeneration = ++loadGeneration;
    generation++;
    focusGeneration++;
    submissionGeneration++;
    source?.close();
    source = null;
    broad = null;
    inlineAnswer.value = null;
    offer.value = null;
    recoveringPrivacy.value = JSON.stringify([
      previous.actor,
      previous.organization,
      previous.stream,
      previous.bindingRevision,
      previous.accessEpoch,
    ]);
    session.value = null;
    text.value = "";
    scroll.value = 0;
    context.value = [];
    earlierRequests.value = [];
    sending.value = false;
    historyLoading.value = false;
    removing.value = null;
    status.value = "loading";
    notice.value = "This thread is unavailable. Checking access to your messages.";
    revocations.value++;
    const current = () =>
      requestGeneration === loadGeneration &&
      !disposed &&
      !scopeChanging.value &&
      recoveringPrivacy.value !== null &&
      activePrivacy === expectedPrivacy;
    try {
      const response = await fetchFn("/home/session", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const value: unknown = await response.json();
      if (!current()) return;
      if (
        !response.ok ||
        !isHomeSession(value) ||
        value.destination.kind !== "broad" ||
        privacyKey(value) !== expectedPrivacy
      ) {
        unavailable();
        return;
      }
      adopt(value);
      broad = value;
      follow(value);
      notice.value = "This thread is unavailable. Your messages have been checked.";
    } catch {
      if (current()) unavailable();
    }
  }
  function follow(next: HomeSession) {
    source?.close();
    const attached = makeSource(next.eventsUrl);
    source = attached;
    const ownGeneration = generation;
    const active = () => ownGeneration === generation && source === attached;
    attached.onmessage = (event) => {
      if (!active()) return;
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
      if (session.value && incoming.destination.kind === "broad" && incoming.revision < session.value.revision) return;
      session.value = incoming;
      offer.value = offerFor(incoming);
      if (incoming.destination.kind === "broad") broad = incoming;
    };
    attached.addEventListener("revoked", () => {
      if (active()) {
        if (next.destination.kind === "thread") void recoverFocused(session.value ?? next);
        else {
          unavailable();
          revocations.value++;
        }
      }
    });
    attached.addEventListener("unavailable", () => {
      if (active()) unavailable();
    });
    attached.onerror = () => {
      if (!active()) return;
      if (attached.readyState === EVENT_SOURCE_CLOSED) {
        unavailable();
        return;
      }
      notice.value = "Connection lost. The last confirmed conversation is shown.";
    };
    attached.onopen = () => {
      if (!active()) return;
      if (notice.value === "Connection lost. The last confirmed conversation is shown.") notice.value = "";
    };
  }
  async function load() {
    if (disposed || scopeChanging.value) return;
    const requestGeneration = ++loadGeneration;
    inlineAnswer.value = null;
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
      if (destinationGeneration === generation) offer.value = offerFor(value);
      follow(value);
    } catch {
      if (requestGeneration === loadGeneration && !disposed) unavailable("Conversation could not be loaded.");
    }
  }
  /** Read a current target capability without changing the composer or its draft. */
  async function peek(thread: string): Promise<HomeSession | null> {
    try {
      const response = await fetchFn(`/home/session?thread=${encodeURIComponent(thread)}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const value: unknown = await response.json();
      return !disposed &&
        response.ok &&
        isHomeSession(value) &&
        value.destination.kind === "thread" &&
        value.destination.thread === thread
        ? value
        : null;
    } catch {
      return null;
    }
  }
  async function focus(thread: string) {
    if (sending.value || removing.value || status.value !== "ready") return false;
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
      inlineAnswer.value = null;
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
  async function beginInlineAnswer(unit: string, title: string, target: HomeAnswerTarget) {
    if (inlineAnswer.value || sending.value) return false;
    if (!(await focus(target.thread))) return false;
    if (session.value?.destination.revision !== target.revision && !pendingSubmission.value) {
      exitFocus();
      notice.value = "The question changed. Open the original thread to review it.";
      return false;
    }
    inlineAnswer.value = { ...target, unit, title };
    return true;
  }
  function preserveInlineAnswer() {
    if (sending.value) return;
    inlineAnswer.value = null;
    exitFocus();
  }
  async function loadHistory(address: string) {
    const previous = session.value;
    if (
      !previous ||
      status.value !== "ready" ||
      sending.value ||
      removing.value ||
      historyLoading.value ||
      ![previous.history?.previousUrl, previous.history?.latestUrl].includes(address)
    )
      return false;
    const mine = ++loadGeneration;
    const destinationGeneration = generation;
    const scope = privacyKey(previous),
      destination = destinationKey(previous);
    historyLoading.value = true;
    try {
      const response = await fetchFn(address, { credentials: "same-origin", headers: { accept: "application/json" } });
      const value: unknown = await response.json();
      if (
        mine !== loadGeneration ||
        destinationGeneration !== generation ||
        !session.value ||
        destinationKey(session.value) !== destination ||
        activePrivacy !== scope ||
        removing.value ||
        disposed
      )
        return false;
      if (
        !response.ok ||
        !isHomeSession(value) ||
        privacyKey(value) !== scope ||
        destinationKey(value) !== destination
      ) {
        unavailable();
        return false;
      }
      // Historical windows can precede live replies. Only a changed question or access scope invalidates them.
      if (value.destination.kind === "thread" && value.destination.revision !== session.value.destination.revision)
        return false;
      keepDraft();
      const retry = retries.get(destination);
      if (retry) value.submissionKey = retry.key;
      generation++;
      adopt(value);
      if (value.destination.kind === "broad") broad = value;
      follow(value);
      return true;
    } catch {
      if (mine === loadGeneration && destinationGeneration === generation)
        notice.value = "This history page could not be loaded. The current window is shown.";
      return false;
    } finally {
      if (mine === loadGeneration) historyLoading.value = false;
    }
  }
  function exitFocus() {
    if (!focused.value || !broad) return;
    inlineAnswer.value = null;
    offer.value = null;
    generation++;
    keepDraft();
    adopt(broad);
    follow(broad);
    notice.value = "";
  }
  function routeChanged(route: string) {
    if (route !== activeRoute) {
      inlineAnswer.value = null;
      offer.value = null;
      generation++;
      keepDraft();
      if (focused.value && broad) adopt(broad);
      if (session.value && status.value === "ready" && !removing.value) follow(session.value);
      activeRoute = route;
    }
  }
  function attach(value: AttachedContext) {
    if (!session.value || context.value.length >= 8) return;
    if (!context.value.some((v) => v.kind === value.kind && v.key === value.key))
      context.value = [...context.value, value];
  }
  async function submit(explicitText?: string) {
    const current = session.value;
    if (!current || !text.value.trim()) return;
    const rawDraft = text.value;
    await send({ text: explicitText ?? stripSlash(rawDraft.trim(), current.commands) }, rawDraft);
  }
  async function submitConfirmation(choice: HomeConfirmationChoice) {
    if (!offer.value || offer.value.id !== choice.id || !["confirm", "cancel"].includes(choice.kind)) return;
    await send({ confirmation: { kind: choice.kind, id: choice.id } });
  }
  function reviewDraft() {
    if (!draftStale.value || !session.value?.destination.canWrite) return;
    observedRevision.value = session.value.destination.revision;
    notice.value = "Draft reviewed for the current question.";
  }
  async function removePrivate(entryId: string) {
    const current = session.value;
    const entry = current?.entries.find((entry) => entry.id === entryId);
    if (
      !current ||
      current.destination.kind !== "broad" ||
      !current.destination.canWrite ||
      !entry?.deleteUrl ||
      removing.value ||
      sending.value ||
      pendingSubmission.value
    )
      return false;
    const scope = privacyKey(current);
    removing.value = entryId;
    const draft = text.value;
    // Deletion advances the access epoch. Close the old stream before the
    // request so its revocation cannot erase the acknowledged removal result.
    source?.close();
    source = null;
    generation++;
    loadGeneration++;
    historyLoading.value = false;
    const currentRemoval = () =>
      !disposed &&
      !scopeChanging.value &&
      activePrivacy === scope &&
      !!session.value &&
      session.value.actor === current.actor &&
      session.value.organization === current.organization &&
      session.value.stream === current.stream &&
      session.value.bindingRevision === current.bindingRevision;
    const refresh = async (message: string) => {
      if (!currentRemoval()) return false;
      await load();
      const fresh = session.value;
      if (
        !fresh ||
        fresh.actor !== current.actor ||
        fresh.organization !== current.organization ||
        fresh.stream !== current.stream ||
        fresh.bindingRevision !== current.bindingRevision
      )
        return false;
      if (fresh.destination.canWrite) text.value = draft;
      contentRemovals.value++;
      notice.value = message;
      return true;
    };
    try {
      const response = await fetchFn(entry.deleteUrl, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const receipt = (await response.json()) as { status?: string };
      if (!currentRemoval()) return false;
      if (!response.ok || receipt.status !== "ok") {
        await refresh("Content removal could not be confirmed. Current messages were loaded again.");
        return false;
      }
      return await refresh("Saved message text deleted. Existing runs and original messages are unchanged.");
    } catch {
      await refresh("Content removal could not be confirmed. Current messages were loaded again.");
      return false;
    } finally {
      removing.value = null;
    }
  }
  async function send(input: { text: string } | { confirmation: HomeConfirmationChoice }, rawDraft?: string) {
    const s = session.value;
    if (
      !s ||
      status.value !== "ready" ||
      (!s.destination.canWrite && !pendingSubmission.value) ||
      sending.value ||
      removing.value
    )
      return;
    const payload = {
      ...input,
      destination:
        s.destination.kind === "broad" ? { kind: "broad" } : { kind: "thread", thread: s.destination.thread },
      revision: "text" in input ? (observedRevision.value ?? s.destination.revision) : s.destination.revision,
      context: "confirmation" in input ? [] : context.value.map(({ kind, key }) => ({ kind, key })),
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
    const sameRetry =
      !!retry &&
      JSON.stringify(previousIntent) === JSON.stringify(nextIntent) &&
      ("confirmation" in input || (retry.body as { revision: number }).revision === payload.revision);
    if (!s.destination.canWrite && !sameRetry) {
      notice.value = "This destination is read-only. Only the unchanged saved reply can be checked.";
      sending.value = false;
      return;
    }
    if ("text" in input && draftStale.value && !sameRetry) {
      notice.value = "The question changed. Review the current question before sending this draft.";
      sending.value = false;
      return;
    }
    if (!sameRetry) {
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
      retry = {
        key,
        body: { ...payload, key },
        rawDraft,
        ...("confirmation" in input && offer.value ? { savedOffer: offer.value } : {}),
      };
      retries.set(draftKey, retry);
    }
    if (ownGeneration !== generation) {
      if (ownSubmission === submissionGeneration) sending.value = false;
      return;
    }
    if (!retry) {
      sending.value = false;
      return;
    }
    try {
      if (!rememberEarlier(s, retry.key)) {
        notice.value = "Earlier request tracking is full. Check or forget a saved request identifier before sending.";
        return;
      }
      // An uncertain attempt still owns its key; a different intent needs a fresh one.
      attempted.add(retry.key);
      const response = await fetchFn(s.sendUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(retry.body),
      });
      if ([401, 403, 404].includes(response.status)) {
        // The outer auth gate may return text or no body. Definite denial
        // cannot depend on decoding that body or affect a newer destination.
        if (
          ownGeneration !== generation ||
          ownPrivacy !== activePrivacy ||
          !session.value ||
          destinationKey(session.value) !== draftKey
        )
          return;
        if (s.destination.kind === "thread") await recoverFocused(s);
        else {
          unavailable();
          revocations.value++;
        }
        return;
      }
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
      if (response.ok && ["pending", "accepted"].includes(receipt.status ?? ""))
        writeEarlier(
          s,
          readEarlier(s).filter((item) => item.key !== retry.key),
        );
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
      if (response.ok && !accepted) {
        notice.value = "The result could not be confirmed. Retry returns the same submission receipt.";
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
    inlineAnswer,
    resetPrivate,
    scopeChanging,
    revocations,
    contentRemovals,
    recoveringPrivacy,
    beginInlineAnswer,
    preserveInlineAnswer,
    status,
    text,
    scroll,
    context,
    sending,
    historyLoading,
    removing,
    draftStale,
    notice,
    earlierRequests,
    earlierPersistent,
    checkEarlierRequest,
    forgetEarlierRequest,
    offer,
    pendingChoice,
    pendingSubmission,
    focused,
    load,
    loadHistory,
    focus,
    peek,
    exitFocus,
    routeChanged,
    attach,
    submit,
    submitConfirmation,
    reviewDraft,
    removePrivate,
    dispose,
  };
}
export type HomeSessionController = ReturnType<typeof createHomeSession>;
export const HomeSessionKey: InjectionKey<HomeSessionController> = Symbol("home-session");
export function useHomeSession() {
  return inject(HomeSessionKey, null);
}
