const dispatchContext = Symbol("original-organization-dispatch");
/** Saved media is a read dependency; the enclosing pointer still owns execution. */
export interface SavedNativeMediaSource {
  version: 1;
  kind: "confirmed";
  sourceRunId: string;
  sourceSequence: number;
  sourceDigest: string;
  confirmationId: string;
  intentDigest: string;
}
export function isSavedNativeMediaSource(value: unknown): value is SavedNativeMediaSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as SavedNativeMediaSource;
  return (
    Object.keys(v).every((key) =>
      ["version", "kind", "sourceRunId", "sourceSequence", "sourceDigest", "confirmationId", "intentDigest"].includes(
        key,
      ),
    ) &&
    v.version === 1 &&
    v.kind === "confirmed" &&
    [v.sourceRunId, v.confirmationId].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 2048,
    ) &&
    Number.isSafeInteger(v.sourceSequence) &&
    v.sourceSequence > 0 &&
    [v.sourceDigest, v.intentDigest].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}
export interface OriginalNativeMediaSource extends Omit<SavedNativeMediaSource, "kind" | "confirmationId"> {
  kind: "original";
}
export type NativeMediaSource = SavedNativeMediaSource | OriginalNativeMediaSource;
export function isNativeMediaSource(value: unknown): value is NativeMediaSource {
  if (isSavedNativeMediaSource(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as OriginalNativeMediaSource;
  return (
    Object.keys(v).every((key) =>
      ["version", "kind", "sourceRunId", "sourceSequence", "sourceDigest", "intentDigest"].includes(key),
    ) &&
    v.version === 1 &&
    v.kind === "original" &&
    typeof v.sourceRunId === "string" &&
    v.sourceRunId.length > 0 &&
    v.sourceRunId.length <= 2048 &&
    Number.isSafeInteger(v.sourceSequence) &&
    v.sourceSequence > 0 &&
    [v.sourceDigest, v.intentDigest].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}
export interface OriginalOrganizationDispatch {
  ingressRunId: string;
  organizationSequence: number;
  organizationRepo?: string;
  contextMode?: "request";
  nativeMediaDigest?: string;
  savedNativeMediaSource?: SavedNativeMediaSource;
}
export function withOriginalOrganizationDispatch<T extends object>(
  message: T,
  context: OriginalOrganizationDispatch,
): T {
  if (
    typeof context.ingressRunId !== "string" ||
    !context.ingressRunId ||
    context.ingressRunId.length > 2048 ||
    !Number.isSafeInteger(context.organizationSequence) ||
    context.organizationSequence < 1 ||
    (context.contextMode !== undefined && context.contextMode !== "request") ||
    (context.organizationRepo !== undefined &&
      (typeof context.organizationRepo !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.organizationRepo))) ||
    (context.nativeMediaDigest !== undefined && !/^[a-f0-9]{64}$/.test(context.nativeMediaDigest)) ||
    (context.savedNativeMediaSource !== undefined &&
      (!isSavedNativeMediaSource(context.savedNativeMediaSource) ||
        context.savedNativeMediaSource.sourceRunId === context.ingressRunId ||
        context.nativeMediaDigest !== undefined))
  )
    throw new Error("Invalid original input owner");
  const prior = originalOrganizationDispatchOf(message);
  const contextMode =
    context.contextMode ??
    (prior?.ingressRunId === context.ingressRunId && prior.organizationSequence === context.organizationSequence
      ? prior.contextMode
      : undefined);
  const mediaDigest =
    context.nativeMediaDigest ??
    (prior?.ingressRunId === context.ingressRunId && prior.organizationSequence === context.organizationSequence
      ? prior.nativeMediaDigest
      : undefined);
  const saved =
    context.savedNativeMediaSource ??
    (prior?.ingressRunId === context.ingressRunId && prior.organizationSequence === context.organizationSequence
      ? prior.savedNativeMediaSource
      : undefined);
  if (mediaDigest && saved) throw new Error("Invalid original input owner");
  return {
    ...message,
    [dispatchContext]: {
      ingressRunId: context.ingressRunId,
      organizationSequence: context.organizationSequence,
      ...(context.organizationRepo ? { organizationRepo: context.organizationRepo } : {}),
      ...(contextMode ? { contextMode } : {}),
      ...(mediaDigest ? { nativeMediaDigest: mediaDigest } : {}),
      ...(saved ? { savedNativeMediaSource: { ...saved } } : {}),
    },
  };
}
export function originalOrganizationDispatchOf(message: object): OriginalOrganizationDispatch | undefined {
  return (message as { [dispatchContext]?: OriginalOrganizationDispatch })[dispatchContext];
}

export function withoutOriginalOrganizationDispatch<T extends object>(message: T): T {
  const copy = { ...message } as T & { [dispatchContext]?: OriginalOrganizationDispatch };
  delete copy[dispatchContext];
  return copy;
}
