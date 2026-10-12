import { originalOrganizationDispatchOf } from "../dispatch/originalOrganizationInput.js";
import type { IncomingMessage } from "../types.js";
import type { FollowUpInput } from "../threadAdmission.js";
import { turnContent } from "../dispatch/messages.js";
export class NativeMediaHeldError extends Error {
  constructor() {
    super("The original media input is held because its source could not be verified.");
  }
}
/** Decide synchronously so ordinary text keeps its existing write ordering. */
export function requiresNativeSource(run: {
  nativeMediaDigest?: string;
  sourceContextRequired?: true | (() => boolean);
}): boolean {
  if (run.nativeMediaDigest !== undefined || run.sourceContextRequired === true) return true;
  if (typeof run.sourceContextRequired === "function") {
    try {
      return run.sourceContextRequired() !== false;
    } catch {
      return true;
    }
  }
  return false;
}
export async function guardNativeSource(run: {
  nativeMediaDigest?: string;
  sourceContextRequired?: true | (() => boolean);
  prepareSourceMedia?: () => Promise<boolean>;
}): Promise<void> {
  if (!requiresNativeSource(run)) return;
  try {
    if (
      (run.nativeMediaDigest === undefined || /^[a-f0-9]{64}$/.test(run.nativeMediaDigest)) &&
      run.prepareSourceMedia &&
      (await run.prepareSourceMedia()) === true
    )
      return;
  } catch {
    /* Original owner remains held. */
  }
  throw new NativeMediaHeldError();
}
export function nativeFollowUpText(inputs: readonly FollowUpInput[], text: string): string {
  const documents = inputs
    .filter(requiresNativeMedia)
    .flatMap((input) => input.documents ?? [])
    .filter((document) => document.mediaType !== "application/pdf");
  if (!documents.length) return text;
  return turnContent(text, undefined, documents)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
}
export function requiresNativeMedia(input: FollowUpInput): boolean {
  const message = (input as FollowUpInput & { msg?: IncomingMessage }).msg;
  return !!(
    originalOrganizationDispatchOf(input)?.nativeMediaDigest ||
    originalOrganizationDispatchOf(input)?.savedNativeMediaSource ||
    (message &&
      (originalOrganizationDispatchOf(message)?.nativeMediaDigest ||
        originalOrganizationDispatchOf(message)?.savedNativeMediaSource)) ||
    message?.nativeMediaDigest !== undefined ||
    message?.nativeMedia !== undefined ||
    (input as FollowUpInput & { nativeMediaDigest?: unknown }).nativeMediaDigest !== undefined
  );
}
export function discardNativeMedia(inputs: readonly FollowUpInput[]): void {
  for (const input of inputs)
    if (requiresNativeMedia(input)) {
      delete input.images;
      delete input.documents;
      delete input.staged;
      const message = (input as FollowUpInput & { msg?: IncomingMessage }).msg;
      if (message) {
        delete message.images;
        delete message.documents;
        delete message.staged;
        delete message.nativeMedia;
      }
    }
}
/** A missing capability cannot turn required source media into an ordinary text steer. */
export async function prepareNativeFollowUps(
  inputs: readonly FollowUpInput[],
  prepare?: (inputs: readonly FollowUpInput[]) => Promise<boolean>,
): Promise<boolean> {
  if (!inputs.some(requiresNativeMedia)) return true;
  try {
    if (prepare && (await prepare(inputs)) === true) return true;
  } catch {
    /* Keep the original input unread. */
  }
  discardNativeMedia(inputs);
  return false;
}
