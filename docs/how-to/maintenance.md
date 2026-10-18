# Bring Switchboard down for maintenance

Connect the CLI to the installation with `switchboard connect <host>`, or use its native MCP connection. Your identity needs `maintenance:write`; status needs `maintenance:read`. The installation needs its durable state Worker. Notices default to `switchboard-dev`; use `--channel` to select another channel.

For immediate maintenance:

```sh
switchboard maintenance start --scopes all --reason "Service maintenance"
switchboard maintenance status --json
```

The command closes new access before posting the notice. Save the episode ID from its response. Existing work can finish. Read status, inspect `repo workload`, and use the existing authorized stop controls as needed before resident repair. An active hold does not prove that residents are idle.

The web page lists unavailable features from the saved scopes. Its optional maintenance note shows the operator's `--reason`; without a reason, the note is omitted. The Slack link appears only after its posting receipt is saved. Thread updates do not change the page's original note. The page does not infer work progress or a recovery time.

To announce a scheduled start:

```sh
switchboard maintenance announce --scopes residents --starts-at "2026-10-19T17:00:00-07:00"
```

The response contains `activationCommand`, `activationTool`, and `schedule.installed: false`. Ask your running client to execute that exact call at the saved time. Switchboard does not schedule it. A missed client wake leaves access open. The notice shows the start in Pacific time and gives no recovery estimate.

For a notice without a scheduled time, omit `--starts-at`. The notice says `in a few minutes`, or uses your `--timing` text. You decide when to run the returned activation call.

```sh
switchboard maintenance start --id <episode-id>
switchboard maintenance update --id <episode-id> --message "Resident work is in progress. Follow this thread for updates."
switchboard maintenance end --id <episode-id>
```

End restores the selected access and posts in the same thread. End also cancels an announced episode. The exact ID prevents an old client wake from starting or ending a later episode. Holds never expire on their own.

| Scope | Unavailable actions |
| --- | --- |
| `all` | New agent work, ordinary user commands, public web pages |
| `agents` | New or continued agent work on Slack, MCP, HTTP, browser and child dispatch |
| `residents` | All new agent work, including fallback executors, plus repository tests and builds |
| `web` | Public web pages; CLI and MCP remain available |

Use comma-separated scopes for a combination, such as `agents,web`. Use `all` alone. Operator recovery retains normal authorization. Maintenance and status, authorized inspection, stop controls, resident administration, and approval of maintenance actions remain available.

Use CLI or MCP for recovery while access is closed. Private Slack requests and approval clicks stay closed during an agent or resident hold.

The MCP tools are `maintenance_announce`, `maintenance_start`, `maintenance_status`, `maintenance_update`, and `maintenance_end`. Their options match the CLI names in camelCase, such as `startsAt`.

Read `episode.notice.status` before reporting that users were notified. `unverified` means delivery or its saved receipt is uncertain. A retry does not repost a start or end notice. Reconcile an uncertain root message in Slack before further notice work. An explicit update posts a new message; do not retry it after an unknown delivery. The access hold remains in place if notification fails.

`sending` means a notice still owns publication. Other phase changes and updates wait for it to finish. If its writer has stopped and you must restore access, run `switchboard maintenance end --id <episode-id> --without-notice`. This sends no completion notice. An earlier notice can still arrive. You must correct the Slack thread yourself after you inspect it.
