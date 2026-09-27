# Changelog

Notable changes to `dsh-off-peak-hours`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The schedule data is versioned with the code: a change to a peak window, the
holiday table, or a campaign window is a behavioral change and gets an entry
here even when no code changed.

## [Unreleased]

Changes to the repository that do not alter the published package — `files`
excludes the test suite, the security policy, and the workflow, so none of
these require a republish.

### Added

- A regression test for the risk `SECURITY.md` names: a provider name carrying
  markup (`<img onerror>`, `</dd><a href>`, `<svg onload>`) is asserted to reach
  the panel as a single escaped text child and to create no element. The suite
  is 98 tests. The claim was previously unbacked — this closes it rather than
  softening the wording.

### Security

- Pinned `actions/checkout` and `actions/setup-node` by commit SHA instead of
  the mutable `v7` tag, and disabled persisted checkout credentials in CI.
- Enabled Dependabot alerts and automated security fixes on the repository;
  the existing config covered version updates only.

## [1.0.0] - 2026-09-27

First public release.

### Added

- An ambient pill in `conversation.composer.dock`, rendered only while the
  Session's selected model belongs to a provider with a time-of-day price.
- **DeepSeek** plan: peak 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday,
  excluding Chinese public holidays; every other instant off-peak, including
  whole weekends and public holidays in full.
- **z.ai (GLM Coding Plan)**: peak 14:00–18:00 Singapore time (UTC+8) =
  06:00–10:00 UTC, Monday–Friday, with no holiday exclusion, which the plan
  documents as absent.
- The 2026-09-25 → 2026-10-07 all-day off-peak campaign for z.ai, applied as a
  dated window rather than assumed.
- A click-opened panel, matching the shipped `stats` pills: current state, the
  next state change stamped by weekday or date, the plan's own schedule
  wording, both clocks, and the exception (holiday or campaign) that explains a
  long wait. Portaled to `document.body`, viewport-clamped, dismissed by
  `Escape` or an outside pointerdown.
- Provider resolution from the model directory, falling back to the Session's
  projected model selection, so a blank Session resolves the same provider the
  next turn will use.
- The Chinese public holiday calendar for 2025–2026, with a visible
  `calendar ends {year}` warning — scoped to the plans that consult it — rather
  than silently treating an unknown year as holiday-free.
- English and Chinese dictionaries, registered with the locale service and
  falling back to built-in English when it is absent.
- 97 tests driving the shipped client module through a React stand-in, plus a
  manifest check over the discovery and publication contract.

[1.0.0]: https://github.com/Shadid516/dsh-off-peak-hours/releases/tag/v1.0.0
