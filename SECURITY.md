# Security Policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability report](https://github.com/Shadid516/dsh-off-peak-hours/security/advisories/new)
rather than a public issue.

Please include what you did, what happened, and what you expected. A small
reproduction is worth more than a long description. Expect an initial reply
within about a week.

## What this plugin does

Worth knowing when judging a report, because the answer is "very little":

- It is a **browser-side decoration**. `index.js` is an empty Host `apply`; the
  Host computes, stores, and serves nothing.
- It makes **no network requests**. There is no telemetry, no update check, and
  no remote schedule feed. The plans, the holiday table, and the campaign
  windows are constants compiled into `client.js`.
- It reads **the selected provider's name** and the local clock. It does not
  read prompts, messages, files, credentials, or the account.
- It renders into one slot, `conversation.composer.dock`, as a sibling of the
  shipped `stats` pills. It does not replace or wrap a shipped entry.

The realistic risk surface is therefore the rendering and dismissal path: a
crafted provider name, or a clock near a window boundary. Both are covered by
the test suite, and a report showing either misbehaving is in scope.

## Scope

A finding in a dependency of this repository is in scope; findings in DSH
itself belong to
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
The schedule data being *wrong* for a vendor — a peak window that does not
match the vendor's current terms — is a correctness bug, not a vulnerability:
open a normal issue with a link to the vendor's page.

## Supported versions

The latest published version receives fixes. This is a client-side decoration
with no persistent state, so upgrading is a package update with no migration.
