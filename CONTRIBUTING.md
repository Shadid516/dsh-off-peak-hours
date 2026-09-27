# Contributing

Thanks for looking. This plugin is small on purpose: the whole feature is one
file, and the schedule data is the part that ages.

## Getting set up

```sh
git clone https://github.com/Shadid516/dsh-off-peak-hours.git
cd dsh-off-peak-hours
npm ci
npm run check     # manifest contract + 97 tests
```

`npm test` runs the suite alone. Node 22 or newer is required.

## How the tests work

The suite loads `client.js` exactly as the browser does — through
`window.__ModuleLoader__.load` — and drives the registered component with a
small React stand-in. That means every expectation is checked against shipped
code rather than a re-implementation of it.

The stand-in is deliberately strict about the things that actually break this
plugin in the browser:

- **Hook order.** It enforces React's positional hook contract. Calling a
  different number of hooks on a later render is what retires a slot entry, and
  a retired entry disappears without an error on screen.
- **Deferred effects.** Effects run after the commit, so an effect sees the
  refs of the tree it just rendered.
- **Event targets.** `document` and `window` are stand-in targets, so
  dismissal behaviour is testable.
- **Geometry.** Refs bind to stand-in nodes with settable rects, so placement
  maths is testable.
- **Portals.** `react-dom`'s `createPortal` records its container.

If you change behaviour, add a test that fails without your change. Negative
controls are welcome in review notes: state which assertion fails when you
revert the fix.

## Changing a schedule

The peak windows, the holiday table, and the campaign windows are all at the
top of `client.js`. Everything about a plan lives in the `PLANS` table; see
[Adding a plan](README.md#adding-a-plan) in the README for the shape of an
entry.

Two rules the existing code holds to:

1. **A window is stated as `[startHour, endHour)` in UTC.** A vendor window
   written in local time converts by a fixed shift, because every zone these
   plans are written in is UTC+8 with no daylight saving. If a future plan is
   not UTC+8, that assumption needs revisiting rather than copying.
2. **Do not silently guess.** An unknown provider renders nothing rather than
   picking a plan, and an unknown holiday year shows a warning rather than
   treating the year as holiday-free.

When you change a window or the holiday table, add a test that probes the
boundary. The existing tests assert the instant *before* and *at* each edge,
because an off-by-one at a boundary is the defect this data actually produces.

## Updating the holiday calendar

`HOLIDAY_RANGES` holds the official days **off**, as continuous blocks, taken
from the State Council General Office notices linked in the README. Extend it
when the next year's arrangement is published (typically early November), and
cite the notice you took it from in the pull request.

Makeup workdays (调休) are deliberately **not** listed: they are ordinary
weekends here, and weekends are off-peak.

## Before you open a pull request

- `npm run check` passes.
- A behaviour change has a test that fails without it.
- A user-visible change has a `CHANGELOG.md` entry under a new version heading
  — including a schedule change, which is behavioural even when no code moved.
- The English and Chinese dictionaries stay in step; the suite asserts it.

## Publishing

Maintainers only. `npm publish` from a clean checkout on `main`, after the
version is bumped in `package.json` and `CHANGELOG.md`:

```sh
npm ci
npm run check
npm publish        # publishConfig.access is already "public"
```

The GitHub release and its `v<version>` tag are created from the same commit.
The `dsh-plugin` topic is what the plugin registries sweep, so it must stay on
the repository.
