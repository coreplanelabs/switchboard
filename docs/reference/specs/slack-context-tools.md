# Slack context reads

The main agent can ask tools for bounded Slack context without treating messages or files as instructions. The requesting person and the bot must both be able to read each source. This is a separate, opt-in capability: merely defining the tool does not give any agent access to it.

- **Code**: `src/tools/slackContext.ts`, `src/tools/runnableTool.ts`, `src/channels/slack/context.ts`, `src/channels/slack/references.ts`, `src/core/dispatch/references.ts`, `src/channels/slack/threadTurns.ts`, `src/channels/slack/attachments.ts`.
- **Tests**: `src/tools/slackContext.test.ts`, `src/channels/slack/context.test.ts`.

| Criterion | Proof |
|---|---|
| The tool requires an injected, requester-bound Slack capability; unknown kinds and malformed inputs fail without a read. | `[unit]` `src/tools/slackContext.test.ts::slack_context tool::refuses a missing capability or invalid request before reading`, `src/channels/slack/context.test.ts::Slack context adapter::requires the authenticated Slack requester at capability construction` |
| Current-thread and nearby-channel reads stay on the request's channel, keep a small newest-first window, label the source, and fence its text as data. A private channel requires requester membership and bot membership before the read. | `[unit]` `src/channels/slack/context.test.ts::Slack context adapter::reads bounded current and nearby text only from the origin channel`, `::refuses private-origin reads without requester and bot membership proof` |
| A linked thread must be a permalink from this workspace. The existing reference gate verifies requester standing, bot membership and channel authority. Cross-channel private, shared and DM links are refused; a link in the origin channel remains readable. | `[unit]` `src/channels/slack/context.test.ts::Slack context adapter::uses the existing reference gate and refuses cross-channel private or foreign links` |
| A file read names a message permalink and a file ID found on that authorized message. Secret-shaped, missing, oversized and unsupported files fail before download; accepted text is capped and fenced, and accepted image or PDF bytes retain the attachment caps. | `[unit]` `src/channels/slack/context.test.ts::Slack context adapter::reads only a file attached to the authorized message under caps` |
| The main agent sees these tools only after its dispatcher binds the requester actor, the Slack capability and a source-audience publication gate for the destination. | `[gap]` Tool registration and live destination-audience proof land in the main-agent integration. |
