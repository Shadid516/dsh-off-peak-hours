# Off-Peak Hours

[![CI](https://github.com/Shadid516/dsh-off-peak-hours/actions/workflows/ci.yml/badge.svg)](https://github.com/Shadid516/dsh-off-peak-hours/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-off-peak-hours.svg)](https://www.npmjs.com/package/dsh-off-peak-hours)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![tests: 97 passing](https://img.shields.io/badge/tests-97_passing-brightgreen.svg)](#developing)
[![node: >=22](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
bundle that puts one ambient pill under the composer while the Session's model
comes from a provider with a time-of-day price. The pill answers a single
question at a glance: **is the next token billed at peak or off-peak rates?**

![The Off-Peak Hours pill beside the shipped stats pill, with its panel open above them](https://raw.githubusercontent.com/Shadid516/dsh-off-peak-hours/main/docs/preview.png)

<sub>A live session on a Sunday evening. The weekend is off-peak, so the panel
names the change that ends it: Monday's 01:00 UTC window opening, 2h 9m away.
The pill sits beside the shipped stats pill — the one reading `13%`.</sub>

```
● Off-peak · 50% off · starts in 6h 40m
● Peak · full rate · ends in 1h 12m
```

The countdown says how long the current state lasts, but not what it leads to.
Clicking the pill — like the two stats pills beside it — opens a panel that
does.

## Install

Published on npm as
[`dsh-off-peak-hours`](https://www.npmjs.com/package/dsh-off-peak-hours). From a
shell with `dsh` on the `PATH` — a package that declares `dsh.bundle` is added
to the profile's bundle layers as soon as it is installed, so one command
enables it:

```sh
dsh plugin --profile web add dsh-off-peak-hours                    # from npm
dsh plugin --profile web add github:Shadid516/dsh-off-peak-hours   # latest main
```

From a DSH session:

```
plugin_manager install_bundle dsh-off-peak-hours
```

From a checkout, point `install_bundle` at the absolute directory:

```
plugin_manager install_bundle /absolute/path/to/dsh-off-peak-hours
```

The bundle is a client decoration with no config, no service, and no state, so
there is nothing to set afterwards. Reload the page if the pill does not appear
immediately.

## What it shows

| State | Pill |
| --- | --- |
| Off-peak | green dot · `Off-peak` · `50% off` · `starts in …` |
| Peak | amber dot · `Peak` · `full rate` · `ends in …` |

The dot colour is the only difference that survives a glance, so it carries the
whole verdict; the words are there for the times a glance is not enough.

With a provider no plan claims, the entry renders **nothing at all** — no pill,
no placeholder. An unknown provider is hidden rather than guessed at, so a
custom route pointed at one of these vendors under a name the plan does not
claim shows nothing until that plan's `matches` is extended.

## The panel

Clicking the pill opens a panel with the same chrome as the shipped stat
dialogs:

```
DeepSeek                               Off-peak (50% off)
──────────────────────────────────────────────────────────────
Peak begins in 2h 9m, at Mon 01:00 UTC
Peak hours         01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, excluding
                   Chinese public holidays.
Time               Sun 22:50 UTC · Mon 06:50 UTC+8
Holiday calendar   2025-2026
Provider           deepseek-official
```

- The header restates the pill's verdict in words.
- The answer line names the state that *begins*, rather than leaving
  "starts in 2h 9m" to be interpreted.
- A change less than a day away is stamped by weekday (`Mon 01:00 UTC`);
  further out it gains a date, because a weekday alone stops identifying the
  day.

When a holiday or a campaign is in force, it leads the details list, above the
schedule it overrides:

```
Holiday            National Day - off-peak all day
Campaign           50% off all day, 2026-09-25 to 2026-10-07
```

It behaves like the shipped panels: portaled to `document.body`, anchored above
the trigger and clamped into the viewport, dismissed by `Escape` or a
pointerdown outside itself and the trigger. The pill is a `button` carrying
`aria-haspopup="dialog"` and `aria-expanded`; the panel is a `role="dialog"`
labelled with the plan.

## Plans

Each plan owns its own schedule, and the selected provider picks the plan. The
same instant can be peak for one and off-peak for another, so the pill only
ever reports the plan actually in force.

### DeepSeek

| Window | Rate |
| --- | --- |
| 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays | peak (full rate) |
| Every other instant — remaining hours, whole weekends, Chinese public holidays in full | off-peak (half rate) |

Weekends stay off-peak even when a holiday block designates them as makeup
workdays (调休). The Chinese calendar decides "holiday" in China Standard Time
(UTC+8); inside a peak window the UTC date, the China date, and the weekday
always agree, so the two never conflict.

### z.ai (GLM Coding Plan)

| Window | Rate |
| --- | --- |
| 14:00–18:00 Singapore time (UTC+8) = 06:00–10:00 UTC, Monday–Friday | peak (full rate) |
| Every other instant, weekends included | off-peak (half rate) |

The plan documents **no** holiday exclusion, so a weekday inside the window is
peak even on a public holiday — unlike DeepSeek, which yields the whole holiday
block. That asymmetry is deliberate and covered by tests.

**Campaign.** From 2026-09-25 to 2026-10-07 (UTC+8 days, inclusive) all-day
usage is charged at the off-peak rate. While a campaign is active the pill
appends a `campaign` note and the panel names its dates in a `Campaign` row.
Delete the entry from `promotions` once it ends; until then it is applied, not
assumed.

Both routes the pi-ai catalog ships for this plan — `zai` and `zai-coding-cn` —
resolve to the same schedule.

## How the provider is resolved

The pill needs to know which plan is in force before it can say anything, and
at the moment a Session opens there is no model selected yet. It therefore
reads two sources in order:

1. **The model directory**, keyed by session. This is authoritative and covers
   the blank-Session case, because it resolves the provider the next turn will
   use rather than waiting for one to arrive.
2. **The Session's projected model selection**, as a fallback when the
   directory has not answered yet.

When neither yields a provider — the normal state for a Session whose model
comes from somewhere no plan describes — the entry renders nothing.

## Adding a plan

Everything lives in the `PLANS` table at the top of `client.js`. One entry is
enough:

```js
{
  id: 'example',
  labelKey: 'plan.example',          // display name (dictionary key)
  scheduleKey: 'schedule.example',   // the vendor's own wording (dictionary key)
  source: '...',                     // the vendor's wording, kept next to the window
  peakWindowsUtc: [[9, 12]],         // `[startHour, endHour)` in UTC
  usesChinaHolidays: false,
  promotions: [],                    // optional dated all-day off-peak windows
  matches: (provider) => provider === 'example',
}
```

Add the matching `plan.example` and `schedule.example` strings to the `EN` and
`ZH` dictionaries — the test suite asserts the two dictionaries stay in step. A
window stated in a local time zone converts to UTC by a fixed shift, because
every zone these plans are written in is UTC+8 with no daylight saving.

## Layout

| File | Role |
| --- | --- |
| `package.json` | Bundle manifest: `dsh.bundle.patch`, the `dsh.client` browser declaration, `exports["./client"]`, and the display metadata the Plugin Manager card reads. |
| `cordis.patch.yml` | Inserts the single Host row. |
| `index.js` | Host half. Empty on purpose — nothing is computed server-side. |
| `client.js` | The whole feature: plans, holiday table, provider resolution, pill, panel. |
| `locale/en.json`, `locale/zh.json` | Plugin-card title and description. |
| `icon.svg` | Plugin-card artwork. |
| `test/schedule.test.mjs` | 97 tests over the shipped client module. |
| `scripts/check-manifest.mjs` | Validates the install and discovery contract. |

## Updating the holiday calendar

`HOLIDAY_RANGES` in `client.js` is the only part that ages besides campaigns.
It holds the official days **off**, as continuous blocks, from the State Council
General Office notices:

- 2025 — [国办发明电〔2024〕12号](https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm)
- 2026 — [国办发明电〔2025〕7号](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)

The next year's arrangement is published around early November, so 2027 is
absent. Until it is added, years outside the table fall back to the
weekday/weekend rule alone and the pill appends `calendar ends 2026` in the
warning colour rather than silently pretending the holidays are known. The
warning is scoped to the plans that consult the calendar; z.ai never shows it.

Makeup workdays are deliberately **not** listed: they are ordinary weekends
here, and weekends are off-peak.

## Developing

```sh
npm ci
npm run check     # manifest contract, then the test suite
```

`npm test` runs the suite alone. The tests load `client.js` exactly as the
browser does — through `window.__ModuleLoader__.load` — and drive the
registered component with a small React stand-in, so every expectation is
checked against shipped code rather than a re-implementation. The stand-in
supplies what the component actually reaches for: a hook store that defers
effects past the commit and enforces React's positional hook contract (a render
calling a different number of hooks is what retires a slot entry in the
browser), `document`/`window` event targets, refs bound to stand-in nodes with
settable geometry, and a `react-dom` `createPortal` that records where the panel
went.

`npm run check:manifest` validates the contract the ecosystem depends on: that
the patch is a top-level YAML array, that its rows name this package, and that
every file the manifest promises is published. See
[CONTRIBUTING.md](CONTRIBUTING.md) before changing schedule data.

## Compatibility

The bundle needs a `dsh` that ships `conversation.composer.dock` and the
`modelDirectories` service. It is written against DSH `0.1.7-rc.2`, and it
imports **no** Harness client package: a client bundle may not require
`@deepseek-ai/dsh-client-ui-primitives`, so the panel chrome is reimplemented
under this plugin's own `opkh-` prefix using the same theme tokens.

There is no persistent state and no migration, so upgrading is a package
update.

## License

[MIT](LICENSE)
