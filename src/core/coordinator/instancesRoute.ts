// The pure halves of the shim's `POST /admin/coordinator/instances`
// (docs/reference/specs/http-ingress.md item 9): what the bot's shim Worker
// decides without the platform — the body it accepts, how it reads the bot's
// answer to "does this bearer hold `coordinator:step`?", and the wire shape of
// each outcome — so `deploy/cloudflare/worker.ts` is one `create` call between
// three tested functions, the way `src/deploy/restart.ts` is for the restart.
// Node-free: the shim imports this by relative path.
//
// Why the shim asks the bot: the Worker holds the token map (WHO), the grants
// live in the container's config (WHETHER). The shim relays the caller's own
// bearer to `POST /admin/coordinator/authorize`, where the bot runs the whole
// check against the policy table, and creates the instance only on a 200.

import { INSTANCE_ID_PATTERN } from "./contract.js";

export const COORDINATOR_INSTANCES_PATH = "/admin/coordinator/instances";
/** The bot's question route: 200 `{ ok, subject }` when the bearer's actor holds `coordinator:step`. */
export const COORDINATOR_AUTHORIZE_PATH = "/admin/coordinator/authorize";

export type ParsedCreateInstance =
  { ok: true; id: string; params: Record<string, unknown> } | { ok: false; reason: string };

/** The body: `{ id, params? }` — the instance's id in the platform's alphabet,
 *  the params the Workflow is created with (ids only by the coordinator's
 *  contract; what they are is the Workflow's to type). */
export function parseCreateInstanceRequest(text: string): ParsedCreateInstance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, reason: "body must be a JSON object" };
  const b = parsed as Record<string, unknown>;
  if (typeof b.id !== "string" || !INSTANCE_ID_PATTERN.test(b.id))
    return { ok: false, reason: "`id` must be a Workflow instance id: letters, digits, `_` and `-`, at most 100" };
  if (b.params !== undefined && (typeof b.params !== "object" || b.params === null || Array.isArray(b.params)))
    return { ok: false, reason: "`params` must be an object" };
  return { ok: true, id: b.id, params: (b.params as Record<string, unknown> | undefined) ?? {} };
}

export type SubjectAuthorization =
  { ok: true; subject: string } | { ok: false; status: 401 | 403 | 503; reason: string };

/** The bot's `POST /admin/coordinator/authorize` answer, as the shim reads it:
 *  200 `{ ok: true, subject }` → allowed; 401 / 403 / 503 `{ ok: false,
 *  error }` → relayed as they are; anything else (a bot without the route, a
 *  non-JSON body) → 503, fail-closed — nothing is created on an answer the shim
 *  cannot read. */
export function parseSubjectAuthorization(status: number, text: string): SubjectAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  if (status === 200 && body?.ok === true && typeof body.subject === "string" && body.subject !== "")
    return { ok: true, subject: body.subject };
  if ((status === 401 || status === 403 || status === 503) && body?.ok === false && typeof body.error === "string")
    return { ok: false, status, reason: body.error };
  return {
    ok: false,
    status: 503,
    reason: `coordinator disabled: the bot did not answer the authorization check (HTTP ${status}) — is it running this version?`,
  };
}

/** How the create ended: the platform's `create`, a duplicate id (the engine
 *  refuses one, and the existing instance's status is read back), or a failure. */
export type CreateInstanceOutcome =
  | { kind: "created"; id: string }
  | { kind: "duplicate"; id: string; status?: string }
  | { kind: "failed"; id: string; reason: string };

export function createInstanceResponse(outcome: CreateInstanceOutcome): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (outcome.kind) {
    case "created":
      return { status: 201, body: { ok: true, id: outcome.id, created: true } };
    case "duplicate":
      return {
        status: 409,
        body: {
          ok: false,
          error: "duplicate_instance",
          id: outcome.id,
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        },
      };
    case "failed":
      return { status: 502, body: { ok: false, error: "create_failed", id: outcome.id, message: outcome.reason } };
  }
}
