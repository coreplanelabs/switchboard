# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's **Report a vulnerability** button on the
repository's Security tab, or email <dev@coreplane.ai> with a description, the
version or commit affected, and steps to reproduce. You will get an
acknowledgement within three business days and a status update at least every
week until the report is resolved.

We ask that you give us reasonable time to fix the issue before disclosing it
publicly. We will credit you in the release notes unless you prefer otherwise.
There is no bug bounty.

## Supported versions

Security fixes land on the latest minor release. Older releases are not patched;
upgrade to the current release to receive fixes.

## What counts

Switchboard runs agents that execute model-generated commands. Where those
commands run, and what they can reach, is decided by the deployment's execution
backend, so the boundaries below define what is and is not a vulnerability.

In scope:

- A message, tool result, or configuration value that lets a caller act with
  authority they were not granted: run an agent or command they are not allowed
  to run, read another channel's runs, see another user's memory, reach a repo
  they are not listed for.
- A run that escapes its executor's isolation into the bot process, another
  thread's workspace, or the hosting account.
- Secrets or credentials appearing in logs, run records, status cards, pages,
  or replies.
- Any way for content the model reads (a web page, a PR, a tool description) to
  alter permissions, configuration, or routing rather than only the model's
  output.
- A dashboard route served without the authentication its configuration
  requires.

Out of scope:

- The model doing something unwise *within* the authority the deployment gave
  it. With `execution.type: local` the agent's shell has the bot process's
  permissions by design; the documentation says so and recommends a container
  or per-thread sandbox.
- Vulnerabilities in the model providers, Slack, GitHub, or the sandbox
  platforms themselves.
- Denial of service by sending the bot many requests; rate limiting is the
  deployment's job.

## Hardening guidance

The documentation's security pages describe the trust model, which execution
backend gives which isolation, how to scope the GitHub credential, and how to
restrict who can run which agent. Read them before exposing the bot to people
you do not fully trust.
