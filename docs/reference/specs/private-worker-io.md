# Private worker IO

An internal worker thread has its own stable identity and event log. A worker's channel handle can record replies and progress without a Slack handle or thread-open operation. This primitive is separate from the Ship unit's authority and from the main conversation's public replies.

- **Code**: `src/channels/privateWorker.ts`, `src/core/privateWorkerLog.ts`
- **Tests**: `src/channels/privateWorker.test.ts`
- **Docs**: [Thread admission](thread-admission.md), [Ship](agent-ship.md)

## Behavior

| Criterion | Proof |
|---|---|
| The instance and unit derive one internal namespaced thread key after rehost; malformed identities are refused before an event is written. | `[unit]` `src/channels/privateWorker.test.ts::private worker IO — a task thread with no Slack delivery::derives the same internal thread key after rehost and rejects ambiguous identities` |
| An authorized input id is idempotent. Replies and attributed prior inputs rebuild as history after rehost; progress and the triggering input stay out of that history. The handle offers no Slack thread creation. | `[unit]` `src/channels/privateWorker.test.ts::private worker IO — a task thread with no Slack delivery::persists attributed input and worker replies, then rebuilds history without status noise or the current request` |
| A status update is appended in order, and closing it waits for every queued frame. | `[unit]` `src/channels/privateWorker.test.ts::private worker IO — a task thread with no Slack delivery::writes ordered status frames and waits for updates before closing the status` |
| A missing durable log fails by name, so the worker cannot silently claim a delivered reply or progress update. | `[unit]` `src/channels/privateWorker.test.ts::private worker IO — a task thread with no Slack delivery::fails closed when the private log is unavailable` |
| A Worker-backed log survives process replacement; coordinator coding and review children use this handle; the main session consumes reports and alone posts to Slack. | `[gap]` |
