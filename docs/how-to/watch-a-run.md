# Watch a run

Find a live run on the dashboard, read its timeline, stop it, and read it back after it finishes.

**You need:**

- A dashboard sign-in: whichever credential the installation's `dashboard.auth` strategy checks.
- The `stop:write` grant for the run.
- A `runHistory` block, to read back finished runs.

## Find the run

Open `/runs` (every active run, newest first) and click a row. The Slack status card links to the same page.

## Read the page

`/runs/<id>` streams the request, each step (files, commands, tool calls and results) and the reply — a review's verdict, a coding run's pull request, the general agent's answer. Leave the tab open while the run is live.

Under the request, **Timeline** is the run's shape. You should see:

```
4m 12s — 34s getting ready · 2m 16s thinking · 1m 10s in tools · 8s finishing up · 4s Switchboard overhead
```

While the run works, the line ends with what is open (`· currently thinking 1m 26s`). `Copy debug JSON` has the raw span names.

The header:

| Header reads | Meaning |
|---|---|
| a running clock | counted from when the message was received |
| `delivering… · <total>` | the agent stopped; the reply is being posted |
| `delivered in 2s` or `reply failed` | the reply landed, or did not |

## Stop a run

Use the page's stop control, or chat (the CLI takes the same words):

```
@switchboard runs stop <id>      # end the turn and keep the stopped result
@switchboard runs kill <id>      # kill the runtime and delete the run row
```

Stop ends the current turn, cleans up its resources, and keeps the final "Stopped by user" result. Kill skips the turn interrupt and deletes the run row and saved events. Kill is destructive. Both controls discard unread follow-ups. Existing `runs stop --mode soft|hard` calls and HTTP `mode=soft|hard` remain supported for compatibility and keep their non-destructive behavior. Omit the mode for the new Stop behavior; use Kill explicitly to delete a row.

## Look back at finished runs

Open `/runs?all=1`. With `runHistory`, finished runs stay for the retention window and the run page is served without a live token. Without it, a run leaves the dashboard about a minute after it finishes; the Slack thread still has the answer.

## Next

- [Dashboard routes](../reference/dashboard-routes.md): every view here plus the Scheduled, Residents and Costs panels, each with its auth.
- [Turn features on and off](turn-features-on-and-off.md): the `runHistory` block.
- [Runs: live, then remembered](../explanation/runs-live-and-history.md): why history is a switch.
