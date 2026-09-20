// The resident's level reports (record 0064; the orchestration plane's
// resident conditions) — the PURE half, kept free of the Sandbox SDK and DO
// storage so it runs under plain-Node vitest (levels.test.ts) like gc.ts,
// drain.ts and memoryGuard.ts. The Worker owns the readings (the user pool's
// allocation, the memory guard's last sample, its own incarnation) and feeds
// this module the numbers; every `/attach`, `/exec` and `/status` answer
// carries the document, and the bot forwards a change to the plane's
// `POST /plane/level`.
//
// Why an outbox and not a push: the resident never holds a credential for the
// state Worker, so it posts nothing itself — a crossing between calls is kept
// as a post and re-offered on every answer until a newer crossing of the same
// name supersedes it. The plane's level write is idempotent per (resident,
// name), so a post forwarded twice lands once.

import { MEMORY_SOFT_LIMIT_PCT } from "./memoryGuard.js";

/** Which side of its line a level reads: `above` closes the door (an exhausted
 *  pool, the gate's soft side), `below` opens it. */
export type LevelSide = "below" | "above";

/** One level post for the plane: the crossing (or a boot's re-statement) the
 *  bot forwards to `POST /plane/level`. */
export interface LevelPost {
  /** `drain` is the registry's fleet-drain post; the residents post the other two. */
  name: "seat" | "memory" | "drain";
  side: LevelSide;
  generation: string;
  at: string;
}

/** The compact sides of one sample, persisted so the next sample can judge a
 *  crossing; `generation` names the incarnation the sample came from. */
export interface LevelSample {
  seat: LevelSide;
  memory: LevelSide;
  generation: string;
}

/** The document every resident answer carries as `levels` (record 0064). */
export interface ResidentLevelsDoc {
  seat: { side: LevelSide; used: number; total: number };
  memory: { side: LevelSide; percent: number | null };
  generation: string;
  at: string;
  /** The outbox: crossings not yet superseded, re-offered on every answer. */
  posts: LevelPost[];
}

/** The seat's side: the pool is a hard count, so `above` is exactly "no free
 *  user" — the next attach or op would be refused `user-pool-exhausted`. */
export function seatSide(used: number, total: number): LevelSide {
  return used >= total ? "above" : "below";
}

/** The memory side is the gate's soft line (resident-repos item 70): at or
 *  past `MEMORY_SOFT_LIMIT_PCT` a NEW attach is refused, so that is where the
 *  plane's `memory` condition sits. No reading, or no cap, gates nothing. */
export function memorySide(percent: number | null): LevelSide {
  return percent !== null && percent >= MEMORY_SOFT_LIMIT_PCT ? "above" : "below";
}

/** The posts one fresh sample owes the plane: each name whose side crossed
 *  since the previous sample — and, with no previous sample or one from
 *  another generation (a boot, a replaced runtime), both names re-stated
 *  (record 0064: "a boot re-states it"), whatever their sides. */
export function levelPosts(prev: LevelSample | null, next: LevelSample, at: string): LevelPost[] {
  const restate = prev === null || prev.generation !== next.generation;
  const posts: LevelPost[] = [];
  if (restate || prev.seat !== next.seat)
    posts.push({ name: "seat", side: next.seat, generation: next.generation, at });
  if (restate || prev.memory !== next.memory)
    posts.push({ name: "memory", side: next.memory, generation: next.generation, at });
  return posts;
}

/** Merge fresh posts into the outbox: a newer post of a name supersedes the
 *  older one — the plane only needs the current side, and the bot forwarding
 *  a superseded post would only be overwritten by the next. The outbox never
 *  grows past one post per name. */
export function mergeOutbox(outbox: LevelPost[], posts: LevelPost[]): LevelPost[] {
  const superseded = new Set(posts.map((p) => p.name));
  return [...outbox.filter((p) => !superseded.has(p.name)), ...posts];
}
