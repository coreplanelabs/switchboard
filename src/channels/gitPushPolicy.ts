/** The command section of Git smart HTTP receive-pack, before any pack bytes.
 * Only this bounded prefix is inspected by the trusted Git door; an unknown
 * framing is refused rather than sent upstream under the App credential. */
const MAX_COMMAND_BYTES = 64 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface PushCommand {
  old: string;
  next: string;
  ref: string;
}

export type PushPrefix =
  | { kind: "commands"; commands: PushCommand[]; capabilities: string[]; prefixBytes: number }
  | { kind: "need_more" }
  | { kind: "refused"; reason: string };

export function inspectReceivePackPrefix(body: Uint8Array): PushPrefix {
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  while (offset < bytes.length && offset < MAX_COMMAND_BYTES) {
    if (offset + 4 > bytes.length) return { kind: "need_more" };
    const sizeText = bytes.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(sizeText)) return { kind: "refused", reason: "invalid pkt-line length" };
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) {
      if (commands.length === 0) return { kind: "refused", reason: "receive-pack has no ref commands" };
      return { kind: "commands", commands, capabilities, prefixBytes: offset + 4 };
    }
    if (size < 4 || offset + size > MAX_COMMAND_BYTES)
      return { kind: "refused", reason: "invalid receive-pack command length" };
    if (offset + size > bytes.length) return { kind: "need_more" };
    let line = bytes.toString("utf8", offset + 4, offset + size);
    offset += size;
    if (line.startsWith("shallow ")) {
      if (commands.length !== 0 || !SHA.test(line.slice(8).trimEnd()))
        return { kind: "refused", reason: "invalid shallow line" };
      continue;
    }
    if (line.endsWith("\n")) line = line.slice(0, -1);
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (commands.length !== 0 || line.indexOf("\0", nul + 1) >= 0)
        return { kind: "refused", reason: "invalid receive-pack capabilities" };
      capabilities = line
        .slice(nul + 1)
        .split(" ")
        .filter(Boolean);
      if (capabilities.includes("push-options"))
        return { kind: "refused", reason: "receive-pack push options are unavailable" };
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]+) ([0-9a-f]+) (refs\/heads\/[^\s\0]+)$/.exec(line);
    if (!match || !SHA.test(match[1]!) || !SHA.test(match[2]!) || match[1]!.length !== match[2]!.length)
      return { kind: "refused", reason: "invalid or non-branch receive-pack command" };
    commands.push({ old: match[1]!, next: match[2]!, ref: match[3]! });
  }
  return offset >= MAX_COMMAND_BYTES
    ? { kind: "refused", reason: "receive-pack command section exceeds 64 KiB" }
    : { kind: "need_more" };
}

export interface PushPolicy {
  identity: "none" | "read" | "write";
  repo: string;
  boundRepo?: string;
  defaultBranch?: string;
  /** An existing PR's exact head, when the run is updating one. */
  boundRef?: string;
  /** The first push may choose exactly one non-default branch; the door then pins it. */
  firstBranch?: boolean;
}

export function authorizePushRefs(
  prefix: PushPrefix,
  policy: PushPolicy,
): { ok: true } | { ok: false; reason: string } {
  if (prefix.kind !== "commands")
    return { ok: false, reason: prefix.kind === "refused" ? prefix.reason : "incomplete receive-pack command" };
  if (policy.identity !== "write") return { ok: false, reason: "GitHub write identity is absent for this run" };
  if (!policy.boundRepo || policy.repo.toLowerCase() !== policy.boundRepo.toLowerCase())
    return { ok: false, reason: "repository is outside this run's binding" };
  if (!policy.defaultBranch) return { ok: false, reason: "repository default branch is unknown" };
  const defaultRef = `refs/heads/${policy.defaultBranch}`;
  const boundRef = policy.boundRef
    ? policy.boundRef.startsWith("refs/heads/")
      ? policy.boundRef
      : `refs/heads/${policy.boundRef}`
    : undefined;
  if ((!boundRef && !policy.firstBranch) || (policy.firstBranch && prefix.commands.length !== 1))
    return { ok: false, reason: "A single branch is not bound to this run" };
  for (const command of prefix.commands) {
    if (command.ref === defaultRef) return { ok: false, reason: "default branch push refused" };
    if (boundRef && command.ref !== boundRef) return { ok: false, reason: "ref is outside this run's binding" };
    if (policy.firstBranch && !/^0+$/.test(command.old))
      return { ok: false, reason: "first push must create a new branch" };
    if (/^0+$/.test(command.next)) return { ok: false, reason: "branch deletion refused" };
  }
  return { ok: true };
}
