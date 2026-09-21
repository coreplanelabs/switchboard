// The GitHub webhook's node:http adapter (docs/reference/specs/http-ingress.md
// item 12): `POST /webhooks/github` reads the raw body (the signature is over
// the bytes as GitHub sent them) and hands headers and body to the pure
// intakes — `handleCheckRunIntake` for a check run's settle,
// `handleIssueCommentIntake` for a person's answer to a live unit, and
// `handlePushIntake` for a base push the merge watch reads — each
// owning its whole decision: the signature check, the payload reading, the
// sends. Nothing else lives here.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  handleCheckRunIntake,
  handleIssueCommentIntake,
  handlePushIntake,
  type CheckRunIntakeDeps,
  type IssueCommentIntakeDeps,
  type PushIntakeDeps,
} from "../core/coordinator/checksIntake.js";
import { readBody } from "./http.js";

export const GITHUB_WEBHOOK_PATH = "/webhooks/github";

/** A check_run payload is small; anything past this is not GitHub's. */
const MAX_BODY_BYTES = 1024 * 1024;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function createGithubWebhookHandler(
  deps: CheckRunIntakeDeps & Partial<Pick<PushIntakeDeps, "watch">> & Partial<IssueCommentIntakeDeps>,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const answer = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return answer(405, { error: "method_not_allowed" });
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) return answer(413, { error: "too_large" });
    const headers = {
      event: one(req.headers[GITHUB_EVENT_HEADER]),
      signature: one(req.headers[GITHUB_SIGNATURE_HEADER]),
    };
    // Push, issue-comment and check-run each own one pure intake. Every other
    // event stays the check-run intake's ignored case.
    const result =
      headers.event === "push"
        ? await handlePushIntake(headers, body.body, { secret: deps.secret, watch: deps.watch })
        : headers.event === "issue_comment" &&
            deps.ownerOf !== undefined &&
            deps.instances !== undefined &&
            deps.commenterAuthorized !== undefined &&
            deps.now !== undefined
          ? await handleIssueCommentIntake(headers, body.body, {
              secret: deps.secret,
              ownerOf: deps.ownerOf,
              instances: deps.instances,
              commenterAuthorized: deps.commenterAuthorized,
              workflow: deps.workflow,
              now: deps.now,
            })
          : await handleCheckRunIntake(headers, body.body, deps);
    answer(result.status, result.body);
  };
}
