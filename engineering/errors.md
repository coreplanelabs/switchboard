## Error handling

- Use the repository's error classes, result types, stable codes, translation boundaries and reporting helpers. Inspect a nearby implementation and its failure behavior. If no pattern exists, define a small explicit contract at the affected boundary.
- Catch only to recover from a specific expected condition, translate into the established error contract, clean up and rethrow, or report failure at the boundary that owns the operation. Let other errors propagate. Preserve the original cause, stable classification and safe diagnostic context.
- Never catch and swallow an error. No empty catches, blanket log-and-continue, or success-shaped defaults after failure. Logging alone is not recovery. An intended fallback must preserve the required failure or degraded-state signal; document why the operation can continue.
- Await asynchronous work, return its promise, or use the existing supervised task mechanism. Detached work needs failure reporting and lifecycle ownership. Preserve cancellation and cleanup semantics. A cleanup failure must not hide the original failure or claim that cleanup succeeded.
