/**
 * Off-Peak Hours — Client half.
 *
 * Renders one ambient pill in `conversation.composer.dock` while the Session's
 * selected model belongs to a provider with a time-of-day price. The pill
 * reports whether the current instant is inside that plan's peak window (full
 * price) or outside every window (off-peak, half price), plus how long the
 * state lasts. With any other provider selected the entry renders nothing.
 *
 * Plans carried here:
 *
 *   DeepSeek   peak 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding
 *              Chinese public holidays; everything else off-peak, holidays in
 *              full included (weekends stay off-peak even when a holiday block
 *              designates them as makeup workdays).
 *
 *   z.ai       peak 14:00-18:00 Singapore time (UTC+8) = 06:00-10:00 UTC,
 *   (GLM       Monday-Friday, with the plan documenting no holiday exclusion.
 *   Coding     A dated all-day off-peak campaign is listed separately.
 *   Plan)
 *
 * The holiday table and the campaign window are the only parts that age:
 * extend the table when the State Council publishes the next year's
 * arrangement (typically early November), and drop a campaign once it ends.
 */
window.__ModuleLoader__.load({
  id: 'dsh-off-peak-hours',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // The panel is portaled to `document.body`, exactly as the shipped stat
    // dialogs are, so it escapes the composer's stacking and overflow context.
    const createPortal = require('react-dom').createPortal;

    // ---------------------------------------------------------------------
    // Shared constants
    // ---------------------------------------------------------------------

    const MS_PER_MINUTE = 60000;
    const MS_PER_HOUR = 3600000;
    const MS_PER_DAY = 86400000;
    /**
     * Both plans are written in UTC+8 — China Standard Time and Singapore
     * Standard Time are the same offset, and neither observes daylight saving —
     * so one shift serves the holiday calendar and the campaign window alike.
     */
    const UTC8_OFFSET_MS = 8 * MS_PER_HOUR;
    /**
     * Hours at which the peak/off-peak answer can change: every window edge,
     * plus 16:00 UTC, where a UTC+8 calendar day turns over. No plan here has a
     * window straddling that hour, so today it only costs a few extra
     * evaluations; it is listed so a plan whose window does straddle it — or a
     * campaign that ends mid-window — is answered correctly without the search
     * having to be revisited.
     */
    const BOUNDARY_HOURS = [0, 1, 4, 6, 10, 16];
    /** How far ahead a state change is searched for before giving up. */
    const BOUNDARY_LOOKAHEAD_DAYS = 16;

    // ---------------------------------------------------------------------
    // Provider plans
    // ---------------------------------------------------------------------
    //
    // One entry per subscription whose price depends on the time of day. The
    // Session's selected provider picks the plan; a provider no plan claims
    // renders nothing at all, so an unlisted route never shows a wrong answer.
    //
    // Every window is stated in UTC hours as `[startHour, endHour)`, because
    // that is what the comparison runs on. `source` keeps the vendor's own
    // wording next to it so the translation stays checkable.

    const PLANS = [
      {
        id: 'deepseek',
        labelKey: 'plan.deepseek',
        scheduleKey: 'schedule.deepseek',
        source: '01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public holidays',
        peakWindowsUtc: [
          [1, 4],
          [6, 10],
        ],
        /** Chinese public holidays are off-peak in full. */
        usesChinaHolidays: true,
        promotions: [],
        matches: function (provider) {
          return (
            provider === 'deepseek' ||
            provider.indexOf('deepseek-') === 0 ||
            provider.indexOf('deepseek_') === 0
          );
        },
      },
      {
        id: 'zai',
        labelKey: 'plan.zai',
        scheduleKey: 'schedule.zai',
        source: '14:00-18:00 Singapore Standard Time (UTC+8), Monday to Friday',
        // 14:00-18:00 UTC+8 is exactly 06:00-10:00 UTC.
        peakWindowsUtc: [[6, 10]],
        /**
         * The plan documents no holiday exclusion: a weekday inside the window
         * is peak even when it is a public holiday.
         */
        usesChinaHolidays: false,
        promotions: [
          {
            from: '2026-09-25',
            to: '2026-10-07',
          },
        ],
        // The pi-ai catalog ships `zai` and `zai-coding-cn`; both point at a
        // coding-plan endpoint.
        matches: function (provider) {
          return (
            provider === 'zai' ||
            provider.indexOf('zai-') === 0 ||
            provider.indexOf('zai_') === 0 ||
            provider === 'z-ai' ||
            provider.indexOf('z-ai-') === 0
          );
        },
      },
    ];

    // ---------------------------------------------------------------------
    // Chinese public holidays
    // ---------------------------------------------------------------------
    //
    // Official days OFF, as continuous blocks, from the State Council General
    // Office notices (国办发明电〔2024〕12号 for 2025, 国办发明电〔2025〕7号
    // for 2026). Makeup workdays (调休) are deliberately absent: they are
    // ordinary weekends here and therefore off-peak.
    //
    // Each entry is `[firstDay, lastDay, [holidayNameKey, ...]]` with inclusive
    // ISO dates. 2027 is published around November 2026; until it is added,
    // years outside this table fall back to the weekday/weekend rule alone and
    // the pill says so.

    const HOLIDAY_RANGES = {
      2025: [
        ['2025-01-01', '2025-01-01', ['newYear']],
        ['2025-01-28', '2025-02-04', ['springFestival']],
        ['2025-04-04', '2025-04-06', ['qingming']],
        ['2025-05-01', '2025-05-05', ['labourDay']],
        ['2025-05-31', '2025-06-02', ['dragonBoat']],
        ['2025-10-01', '2025-10-08', ['nationalDay', 'midAutumn']],
      ],
      2026: [
        ['2026-01-01', '2026-01-03', ['newYear']],
        ['2026-02-15', '2026-02-23', ['springFestival']],
        ['2026-04-04', '2026-04-06', ['qingming']],
        ['2026-05-01', '2026-05-05', ['labourDay']],
        ['2026-06-19', '2026-06-21', ['dragonBoat']],
        ['2026-09-25', '2026-09-27', ['midAutumn']],
        ['2026-10-01', '2026-10-07', ['nationalDay']],
      ],
    };

    /** Whole UTC days since the epoch — a stable, DST-free day identity. */
    function epochDay(ms) {
      return Math.floor(ms / MS_PER_DAY);
    }

    /** Whole days since the epoch on the UTC+8 calendar both plans are written in. */
    function utc8Day(ms) {
      return Math.floor((ms + UTC8_OFFSET_MS) / MS_PER_DAY);
    }

    /** The epoch day an inclusive `YYYY-MM-DD` calendar date starts on. */
    function dayOfIsoDate(iso) {
      const parsed = Date.parse(String(iso) + 'T00:00:00Z');
      return Number.isFinite(parsed) ? epochDay(parsed) : null;
    }

    /** Build the flat `epochDay -> holidayNameKeys` calendar once, at load. */
    function buildCalendar(ranges) {
      const days = new Map();
      const years = [];
      for (const year of Object.keys(ranges)) {
        years.push(Number(year));
        const blocks = ranges[year];
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
          if (!Array.isArray(block) || block.length < 3) continue;
          const first = dayOfIsoDate(block[0]);
          const last = dayOfIsoDate(block[1]);
          if (first === null || last === null) continue;
          const names = Array.isArray(block[2]) ? block[2] : [block[2]];
          for (let day = first; day <= last; day += 1) days.set(day, names);
        }
      }
      years.sort(function (left, right) {
        return left - right;
      });
      return { days: days, years: years };
    }

    const CALENDAR = buildCalendar(HOLIDAY_RANGES);
    const COVERED_FROM = CALENDAR.years.length > 0 ? CALENDAR.years[0] : null;
    const COVERED_TO =
      CALENDAR.years.length > 0 ? CALENDAR.years[CALENDAR.years.length - 1] : null;

    /**
     * Resolve each plan's campaign dates once, at load, so the comparison path
     * stays arithmetic. An unparseable date drops just that campaign.
     */
    function preparePlan(plan) {
      const promotions = [];
      for (const promotion of plan.promotions) {
        const fromDay = dayOfIsoDate(promotion.from);
        const toDay = dayOfIsoDate(promotion.to);
        if (fromDay === null || toDay === null) continue;
        promotions.push({
          from: promotion.from,
          to: promotion.to,
          fromDay: fromDay,
          toDay: toDay,
        });
      }
      plan.preparedPromotions = promotions;
      return plan;
    }

    PLANS.forEach(preparePlan);

    /** Holiday name keys for an instant, or null on an ordinary day. */
    function holidayAt(ms) {
      const names = CALENDAR.days.get(utc8Day(ms));
      return names === undefined ? null : names;
    }

    /** The plan owning a provider id, or null when no plan claims it. */
    function planFor(provider) {
      if (typeof provider !== 'string' || provider.length === 0) return null;
      const id = provider.toLowerCase();
      for (const plan of PLANS) {
        if (plan.matches(id)) return plan;
      }
      return null;
    }

    /** The campaign covering an instant, or null outside every campaign. */
    function promotionAt(plan, ms) {
      if (plan.preparedPromotions.length === 0) return null;
      const day = utc8Day(ms);
      for (const promotion of plan.preparedPromotions) {
        if (day >= promotion.fromDay && day <= promotion.toDay) return promotion;
      }
      return null;
    }

    /**
     * Whether the instant is inside one of the plan's peak windows.
     *
     * The window and weekday are read in UTC, the holiday calendar in UTC+8.
     * Both plans' windows run 01:00-10:00 UTC, i.e. 09:00-18:00 in UTC+8, so
     * the UTC date, the UTC+8 date, and the weekday always agree inside a
     * window and the two lookups cannot disagree.
     */
    function isPeakAt(plan, ms) {
      if (promotionAt(plan, ms) !== null) return false;
      const date = new Date(ms);
      const weekday = date.getUTCDay();
      if (weekday === 0 || weekday === 6) return false;
      const hour = date.getUTCHours();
      let inWindow = false;
      for (const window of plan.peakWindowsUtc) {
        if (hour >= window[0] && hour < window[1]) {
          inWindow = true;
          break;
        }
      }
      if (!inWindow) return false;
      if (!plan.usesChinaHolidays) return true;
      return holidayAt(ms) === null;
    }

    /**
     * The next instant at which {@link isPeakAt} returns a different answer.
     *
     * Only window edges, UTC midnights, and UTC+8 day turns can flip the
     * answer, so the search walks those candidates instead of every minute.
     */
    function nextChangeAt(plan, ms) {
      const current = isPeakAt(plan, ms);
      const todayUtcMidnight = epochDay(ms) * MS_PER_DAY;
      for (let offset = 0; offset <= BOUNDARY_LOOKAHEAD_DAYS; offset += 1) {
        const dayStart = todayUtcMidnight + offset * MS_PER_DAY;
        for (const hour of BOUNDARY_HOURS) {
          const candidate = dayStart + hour * MS_PER_HOUR;
          if (candidate <= ms) continue;
          if (isPeakAt(plan, candidate) !== current) return candidate;
        }
      }
      return null;
    }

    // ---------------------------------------------------------------------
    // Presentation helpers
    // ---------------------------------------------------------------------

    const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    function pad2(value) {
      return value < 10 ? '0' + String(value) : String(value);
    }

    /** `Mon 01:00 UTC` */
    function formatUtcClock(ms) {
      const date = new Date(ms);
      return (
        WEEKDAY_NAMES[date.getUTCDay()] +
        ' ' +
        pad2(date.getUTCHours()) +
        ':' +
        pad2(date.getUTCMinutes()) +
        ' UTC'
      );
    }

    /** `Mon 03:03 UTC+8`. */
    function formatUtc8Clock(ms) {
      const date = new Date(ms + UTC8_OFFSET_MS);
      return (
        WEEKDAY_NAMES[date.getUTCDay()] +
        ' ' +
        pad2(date.getUTCHours()) +
        ':' +
        pad2(date.getUTCMinutes()) +
        ' UTC+8'
      );
    }

    /**
     * The stamp for a state change: `Mon 04:00 UTC`, widened to
     * `Mon 2026-10-12 04:00 UTC` once the change is more than a day away, when
     * a weekday alone no longer identifies the date.
     */
    function formatChangeStamp(ms, fromMs) {
      const date = new Date(ms);
      const clock =
        pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ' UTC';
      const day = WEEKDAY_NAMES[date.getUTCDay()];
      if (ms - fromMs < MS_PER_DAY) return day + ' ' + clock;
      return day + ' ' + formatUtcDate(ms) + ' ' + clock;
    }

    /** `2026-10-12` in UTC. */
    function formatUtcDate(ms) {
      const date = new Date(ms);
      return (
        String(date.getUTCFullYear()) +
        '-' +
        pad2(date.getUTCMonth() + 1) +
        '-' +
        pad2(date.getUTCDate())
      );
    }

    /** `2h 41m`, `43m`, `3d 5h`, `<1m`. */
    function formatDuration(ms) {
      const minutes = Math.max(0, Math.floor(ms / MS_PER_MINUTE));
      if (minutes < 1) return '<1m';
      if (minutes < 60) return String(minutes) + 'm';
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      if (hours < 24) {
        return restMinutes === 0
          ? String(hours) + 'h'
          : String(hours) + 'h ' + String(restMinutes) + 'm';
      }
      const days = Math.floor(hours / 24);
      const restHours = hours % 24;
      return restHours === 0
        ? String(days) + 'd'
        : String(days) + 'd ' + String(restHours) + 'h';
    }

    // ---------------------------------------------------------------------
    // Copy
    // ---------------------------------------------------------------------

    const NS = 'offPeakHours';

    const EN = {
      'state.peak': 'Peak',
      'state.offPeak': 'Off-peak',
      'rate.full': 'full rate',
      'rate.half': '50% off',
      'countdown.ends': 'ends in {time}',
      'countdown.starts': 'starts in {time}',
      'note.calendar': 'calendar ends {year}',
      'note.promotion': 'campaign',
      'plan.deepseek': 'DeepSeek',
      'plan.zai': 'z.ai Coding Plan',
      'panel.title': '{plan} peak / off-peak pricing',
      'panel.state': '{state} ({rate})',
      'panel.next': '{next} begins in {time}, at {when}',
      'schedule.deepseek':
        '01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, excluding Chinese public holidays.',
      'schedule.zai': '14:00-18:00 Singapore time (UTC+8), Mon-Fri.',
      'panel.clock': '{utc} · {utc8}',
      'panel.holiday': '{name} - off-peak all day',
      'panel.promotion': '50% off all day, {from} to {to}',
      'panel.calendar': '{years}',
      'panel.calendarMissing': 'None for {year} - only weekends count as off-peak',
      'panel.label.holiday': 'Holiday',
      'panel.label.campaign': 'Campaign',
      'panel.label.schedule': 'Peak hours',
      'panel.label.time': 'Time',
      'panel.label.calendar': 'Holiday calendar',
      'panel.label.provider': 'Provider',
      'holiday.newYear': "New Year's Day",
      'holiday.springFestival': 'Spring Festival',
      'holiday.qingming': 'Qingming Festival',
      'holiday.labourDay': 'Labour Day',
      'holiday.dragonBoat': 'Dragon Boat Festival',
      'holiday.midAutumn': 'Mid-Autumn Festival',
      'holiday.nationalDay': 'National Day',
    };

    const ZH = {
      'state.peak': '\u5cf0\u65f6',
      'state.offPeak': '\u9519\u5cf0',
      'rate.full': '\u539f\u4ef7',
      'rate.half': '\u534a\u4ef7',
      'countdown.ends': '{time}\u540e\u7ed3\u675f',
      'countdown.starts': '{time}\u540e\u5f00\u59cb',
      'note.calendar': '\u8282\u5047\u65e5\u5386\u6b62\u4e8e {year}',
      'note.promotion': '\u6d3b\u52a8',
      'plan.deepseek': 'DeepSeek',
      'plan.zai': 'z.ai \u7f16\u7a0b\u5957\u9910',
      'panel.title': '{plan} \u5cf0\u8c37\u5b9a\u4ef7',
      'panel.state': '{state}\uff08{rate}\uff09',
      'panel.next': '{next}\u5c06\u4e8e {when} \u5f00\u59cb\uff08{time} \u540e\uff09',
      'schedule.deepseek':
        'UTC 01:00-04:00 \u4e0e 06:00-10:00\uff0c\u5468\u4e00\u81f3\u5468\u4e94\uff0c\u4e2d\u56fd\u6cd5\u5b9a\u8282\u5047\u65e5\u9664\u5916\u3002',
      'schedule.zai':
        '\u65b0\u52a0\u5761\u65f6\u95f4\uff08UTC+8\uff0914:00-18:00\uff0c\u5468\u4e00\u81f3\u5468\u4e94\u3002',
      'panel.clock': '{utc} \u00b7 {utc8}',
      'panel.holiday': '{name}\uff0c\u5168\u5929\u9519\u5cf0',
      'panel.promotion':
        '{from} \u81f3 {to} \u5168\u5929\u534a\u4ef7',
      'panel.calendar': '{years}',
      'panel.calendarMissing':
        '\u6682\u65e0 {year} \u5e74\u6570\u636e\uff0c\u4ec5\u6309\u5468\u672b\u5224\u5b9a\u9519\u5cf0',
      'panel.label.holiday': '\u8282\u5047\u65e5',
      'panel.label.campaign': '\u6d3b\u52a8',
      'panel.label.schedule': '\u5cf0\u65f6',
      'panel.label.time': '\u65f6\u95f4',
      'panel.label.calendar': '\u8282\u5047\u65e5\u5386',
      'panel.label.provider': '\u63d0\u4f9b\u5546',
      'holiday.newYear': '\u5143\u65e6',
      'holiday.springFestival': '\u6625\u8282',
      'holiday.qingming': '\u6e05\u660e\u8282',
      'holiday.labourDay': '\u52b3\u52a8\u8282',
      'holiday.dragonBoat': '\u7aef\u5348\u8282',
      'holiday.midAutumn': '\u4e2d\u79cb\u8282',
      'holiday.nationalDay': '\u56fd\u5e86\u8282',
    };

    /** Built-in fallback so the pill still reads correctly without `locale`. */
    function fallbackTranslate(key, params) {
      let text = Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key;
      if (params !== undefined && params !== null) {
        for (const name of Object.keys(params)) {
          text = text.split('{' + name + '}').join(String(params[name]));
        }
      }
      return text;
    }

    // ---------------------------------------------------------------------
    // Provider resolution
    // ---------------------------------------------------------------------

    /**
     * Whether a provider id is claimed by some plan is {@link planFor}'s job;
     * the matchers live beside their schedules in {@link PLANS} so a new
     * subscription is one table entry and nothing else.
     */

    /** Read `{ lastUsed, next }` from the durable model-selection projection. */
    function readProjectedProvider(useProjection) {
      const selection = useProjection('modelSelection');
      if (selection === undefined || selection === null) return null;
      const chosen = selection.next !== undefined && selection.next !== null
        ? selection.next
        : selection.lastUsed;
      if (chosen === undefined || chosen === null) return null;
      return typeof chosen.provider === 'string' ? chosen.provider : null;
    }

    /** A `useProjection`-shaped stand-in for a kit that carries no such seat. */
    function readNoProjection() {
      return undefined;
    }

    // ---------------------------------------------------------------------
    // Click-opened panel
    // ---------------------------------------------------------------------

    /** Gap between trigger and panel, and the viewport margin both honour. */
    const PANEL_GAP = 8;
    const PANEL_MARGIN = 12;
    /** First-paint placement: measured at 0,0 while invisible, then moved. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /** Whether an event target sits inside one of the given elements. */
    function containsTarget(element, target) {
      return element !== null && element !== undefined && element.contains(target) === true;
    }

    /**
     * Trigger-anchored panel placement, clamped to the viewport.
     *
     * Reimplemented rather than imported: the primitives package is not a
     * stable import for a client bundle. Same inputs and result as the shipped
     * `useAnchoredPosition` — `start` alignment, `top` side, fixed placement
     * re-measured on scroll, resize, and panel resize.
     */
    function useAnchoredPanel(open, anchorRef, panelRef) {
      const [position, setPosition] = React.useState(null);

      React.useLayoutEffect(
        function () {
          if (!open) {
            setPosition(null);
            return undefined;
          }
          const place = function () {
            const anchor = anchorRef.current;
            const rect =
              anchor === null || anchor === undefined
                ? undefined
                : anchor.getBoundingClientRect();
            if (rect === undefined) return;
            const panel = panelRef.current;
            const width = panel === null || panel === undefined ? 0 : panel.offsetWidth;
            const height = panel === null || panel === undefined ? 0 : panel.offsetHeight;
            let left = rect.left;
            let top = rect.top - PANEL_GAP - height;
            if (width > 0) {
              left = Math.min(
                Math.max(left, PANEL_MARGIN),
                window.innerWidth - width - PANEL_MARGIN,
              );
            }
            if (height > 0) {
              top = Math.min(
                Math.max(top, PANEL_MARGIN),
                window.innerHeight - height - PANEL_MARGIN,
              );
            }
            setPosition({ left: left, top: top });
          };
          place();
          window.addEventListener('scroll', place, true);
          window.addEventListener('resize', place);
          let observer = null;
          if (typeof ResizeObserver !== 'undefined' && panelRef.current != null) {
            observer = new ResizeObserver(place);
            observer.observe(panelRef.current);
          }
          return function () {
            if (observer !== null) observer.disconnect();
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
          };
        },
        [open, anchorRef, panelRef],
      );

      return position;
    }

    /**
     * One trigger-owned panel seat: open state, placement, and the two
     * dismissals the shipped stat dialogs have — Escape, and a pointerdown
     * outside both the trigger and the portaled panel.
     */
    function usePanel(anchorRef, panelRef) {
      const [open, setOpen] = React.useState(false);
      const position = useAnchoredPanel(open, anchorRef, panelRef);

      React.useEffect(
        function () {
          if (!open) return undefined;
          const onKeyDown = function (event) {
            if (event.key === 'Escape') setOpen(false);
          };
          document.addEventListener('keydown', onKeyDown);
          return function () {
            document.removeEventListener('keydown', onKeyDown);
          };
        },
        [open],
      );

      React.useEffect(
        function () {
          if (!open) return undefined;
          const onPointerDown = function (event) {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (containsTarget(anchorRef.current, target)) return;
            if (containsTarget(panelRef.current, target)) return;
            setOpen(false);
          };
          document.addEventListener('pointerdown', onPointerDown);
          return function () {
            document.removeEventListener('pointerdown', onPointerDown);
          };
        },
        [open, anchorRef, panelRef],
      );

      return { open: open, setOpen: setOpen, position: position };
    }

    /**
     * Live provider of the model the composer will use.
     *
     * The model directory resolves `projected.next ?? catalog.default`, so it
     * also answers for a Session that has not chosen anything yet; the
     * projection is the backstop when that service is absent. Both are
     * optional: an unresolved provider renders nothing rather than a guess.
     */
    function useProvider(ctx, props) {
      const sessionId = props.sessionId;
      const [fromDirectory, setFromDirectory] = React.useState(null);

      React.useEffect(
        function () {
          let live = true;
          let unsubscribe = null;
          try {
            const models = ctx.get('modelDirectories');
            if (
              models === undefined ||
              models === null ||
              typeof models.directoryFor !== 'function' ||
              sessionId === undefined ||
              sessionId === null
            ) {
              return undefined;
            }
            const directory = models.directoryFor(sessionId);
            const store = directory === undefined || directory === null ? undefined : directory.store;
            if (
              store === undefined ||
              store === null ||
              typeof store.getSnapshot !== 'function' ||
              typeof store.subscribe !== 'function'
            ) {
              return undefined;
            }
            const read = function () {
              if (!live) return;
              const state = store.getSnapshot();
              const current = state === undefined || state === null ? null : state.current;
              setFromDirectory(
                current === undefined || current === null || typeof current.provider !== 'string'
                  ? null
                  : current.provider,
              );
            };
            read();
            const off = store.subscribe(read);
            unsubscribe = typeof off === 'function' ? off : null;
          } catch (error) {
            // An unresolved session or an absent catalog is not an error state
            // for this decoration: it simply has nothing to report.
            setFromDirectory(null);
          }
          return function () {
            live = false;
            if (unsubscribe !== null) {
              try {
                unsubscribe();
              } catch (error) {
                /* teardown is best-effort */
              }
            }
          };
        },
        [ctx, sessionId],
      );

      // The projection seat is itself a framework hook. It must be called in a
      // fixed position on every render — before any early return — or a later
      // render that the directory has answered would call one hook fewer and
      // React would retire the entry.
      const readSelection =
        typeof props.useProjection === 'function' ? props.useProjection : readNoProjection;
      let projected = null;
      try {
        projected = readProjectedProvider(readSelection);
      } catch (error) {
        projected = null;
      }

      return fromDirectory !== null ? fromDirectory : projected;
    }
    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    // The dot is centred with `vertical-align: middle`, which the spec defines
    // as the parent's baseline plus half its x-height — the optical centre of
    // the lowercase text beside it. Centring it on the flex line instead
    // (`align-items: center`) puts it on the line box, whose centre sits about
    // a pixel lower for this font, leaving the dot hanging below the baseline.
    // It also has to stay out of the flex line to be positioned this way, so
    // the pill is a plain inline box and the spacing is margins, not `gap`.
    //
    // The panel chrome copies the shipped stat dialogs' surface — same radius,
    // menu surface, elevation, padding, and label ramp — under this plugin's
    // own prefix, because a client bundle may not import the primitives.
    const CSS = [
      '.opkh-root{box-sizing:border-box;min-width:0;max-width:100%;display:flex;justify-content:center;gap:12px;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.opkh-anchor{min-width:0;display:inline-flex}',
      '.opkh-pill{box-sizing:border-box;max-width:100%;padding:1px 8px;border-radius:999px;',
      'font:inherit;line-height:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));',
      'background:0 0;border:none;cursor:pointer;text-align:start}',
      '.opkh-pill:hover,.opkh-pill[aria-expanded="true"]{',
      'background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));',
      'color:var(--dsw-alias-label-secondary,currentColor)}',
      '.opkh-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}',
      '.opkh-dot{display:inline-block;vertical-align:middle;width:7px;height:7px;margin-right:6px;',
      'border-radius:50%;background:currentColor}',
      '[data-off-peak-hours="off-peak"] .opkh-dot{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '[data-off-peak-hours="peak"] .opkh-dot{color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.opkh-strong{color:var(--dsw-alias-label-secondary,currentColor)}',
      '.opkh-sep{color:var(--dsw-alias-separator-primary,var(--dsw-alias-border-l1,currentColor));opacity:.75;margin:0 6px}',
      '.opkh-note{color:var(--dsw-alias-state-warn-primary,#d97706)}',
      // Panel: fixed, clamped by the placement hook, portaled to document.body.
      '.opkh-panel{z-index:1100;box-sizing:border-box;position:fixed;width:max-content;',
      'min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);padding:16px;border:0;',
      'border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#fff));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.14));',
      'color:var(--dsw-alias-label-secondary,currentColor);cursor:default;font-size:12px;line-height:18px}',
      '.opkh-panel-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;',
      'color:var(--dsw-alias-label-primary,currentColor)}',
      '.opkh-panel-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.opkh-panel-title-label .opkh-dot{margin-right:0;flex:none}',
      '.opkh-panel-title-value{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.opkh-panel-rule{border-top:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));margin-bottom:10px}',
      '.opkh-panel-answer{margin:0 0 10px;color:var(--dsw-alias-label-primary,currentColor)}',
      '.opkh-panel-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
      '.opkh-panel-details dt,.opkh-panel-details dd{min-width:0;margin:0}',
      // Values here are phrases, not counts, so the value column reads from the
      // start rather than the shipped panel's right-aligned numerals.
      '.opkh-panel-details dd{color:var(--dsw-alias-label-secondary,currentColor);overflow-wrap:anywhere}',
    ].join('');

    // ---------------------------------------------------------------------
    // Component
    // ---------------------------------------------------------------------

    /** Tick interval; the pill re-reads the wall clock rather than counting. */
    const TICK_MS = 1000;

    function createBadge(ctx) {
      return function OffPeakBadge(props) {
        const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
        const provider = useProvider(ctx, props);

        const [now, setNow] = React.useState(function () {
          return Date.now();
        });

        React.useEffect(function () {
          const timer = setInterval(function () {
            setNow(Date.now());
          }, TICK_MS);
          return function () {
            clearInterval(timer);
          };
        }, []);

        // Every hook is taken before the first return, including the panel's:
        // a provider that resolves from unknown to known would otherwise change
        // the hook count on a later render and retire the entry.
        const anchorRef = React.useRef(null);
        const panelRef = React.useRef(null);
        const panel = usePanel(anchorRef, panelRef);

        let view = null;
        try {
          view = describe(now, provider, t);
        } catch (error) {
          view = null;
        }
        if (view === null) return null;

        // Dotted segments, so an absent one never leaves a dangling separator.
        const text = [
          h('span', { className: 'opkh-strong', key: 'state' }, view.label),
          h('span', { key: 'rate' }, view.rate),
        ];
        if (view.countdown !== '') {
          text.push(h('span', { key: 'countdown' }, view.countdown));
        }
        view.notes.forEach(function (note, index) {
          text.push(h('span', { className: 'opkh-note', key: 'note' + index }, note));
        });
        const segments = [];
        text.forEach(function (segment, index) {
          if (index > 0) {
            segments.push(
              h('span', { className: 'opkh-sep', 'aria-hidden': 'true', key: 'sep' + index }, '\u00b7'),
            );
          }
          segments.push(segment);
        });

        const state = view.peak ? 'peak' : 'off-peak';

        const children = [
          h('style', { key: 'opkh-css' }, CSS),
          h(
            'span',
            { className: 'opkh-anchor', ref: anchorRef, key: 'anchor' },
            h(
              'button',
              {
                type: 'button',
                className: 'opkh-pill',
                'aria-haspopup': 'dialog',
                'aria-expanded': panel.open,
                onClick: function () {
                  panel.setOpen(!panel.open);
                },
              },
              h('span', { className: 'opkh-dot', 'aria-hidden': 'true', key: 'dot' }),
              segments,
            ),
          ),
        ];
        if (panel.open) children.push(renderPanel(view, state, panel, panelRef));

        return h(
          'div',
          { className: 'opkh-root', 'data-off-peak-hours': state },
          children,
        );
      };
    }

    /**
     * The click-opened panel: what is charged now, what changes next, and the
     * reference the answer comes from. Portaled to `document.body` and
     * positioned from the placement hook, like the shipped stat dialogs.
     */
    function renderPanel(view, state, panel, panelRef) {
      const rows = [];
      view.rows.forEach(function (row) {
        rows.push(h('dt', { key: row.key + '-label' }, row.label));
        rows.push(h('dd', { key: row.key + '-value' }, row.value));
      });

      return createPortal(
        h(
          'div',
          {
            ref: panelRef,
            className: 'opkh-panel',
            'data-off-peak-hours': state,
            role: 'dialog',
            'aria-label': view.title,
            style: panel.position === null ? MEASURE_STYLE : panel.position,
          },
          h(
            'div',
            { className: 'opkh-panel-title' },
            h(
              'span',
              { className: 'opkh-panel-title-label' },
              h('span', { className: 'opkh-dot', 'aria-hidden': 'true' }),
              view.planLabel,
            ),
            h('span', { className: 'opkh-panel-title-value' }, view.stateText),
          ),
          h('div', { className: 'opkh-panel-rule', 'aria-hidden': 'true' }),
          view.next === null ? null : h('p', { className: 'opkh-panel-answer' }, view.next),
          h('dl', { className: 'opkh-panel-details' }, rows),
        ),
        document.body,
      );
    }

    /**
     * Everything the pill shows for one instant, or null when the selected
     * provider belongs to no plan (the entry renders nothing at all).
     */
    function describe(now, provider, t) {
      const plan = planFor(provider);
      if (plan === null) return null;

      const peak = isPeakAt(plan, now);
      const changeAt = nextChangeAt(plan, now);
      const promotion = promotionAt(plan, now);
      const holidayNames = plan.usesChinaHolidays ? holidayAt(now) : null;

      const label = peak ? t('state.peak') : t('state.offPeak');
      const rate = peak ? t('rate.full') : t('rate.half');
      const countdown =
        changeAt === null
          ? ''
          : t(peak ? 'countdown.ends' : 'countdown.starts', {
              time: formatDuration(changeAt - now),
            });

      // A campaign outranks the calendar warning: it is the reason the answer
      // is off-peak right now, while the warning is about future accuracy.
      const notes = [];
      if (promotion !== null) notes.push(t('note.promotion'));
      const year = new Date(now + UTC8_OFFSET_MS).getUTCFullYear();
      const covered = year >= COVERED_FROM && year <= COVERED_TO;
      if (plan.usesChinaHolidays && !covered) {
        notes.push(t('note.calendar', { year: COVERED_TO }));
      }

      // The panel answers first — what is charged now, what changes next and
      // exactly when — and then lists the reference the answer comes from. Any
      // exception (a holiday, a campaign) is a reference row too, so one visual
      // idiom covers the whole panel.
      const planLabel = t(plan.labelKey);
      const rows = [];
      if (holidayNames !== null) {
        rows.push({
          key: 'holiday',
          label: t('panel.label.holiday'),
          value: t('panel.holiday', { name: holidayNames.map(function (key) {
            return t('holiday.' + key);
          }).join(' + ') }),
        });
      }
      if (promotion !== null) {
        rows.push({
          key: 'campaign',
          label: t('panel.label.campaign'),
          value: t('panel.promotion', { from: promotion.from, to: promotion.to }),
        });
      }
      rows.push({
        key: 'schedule',
        label: t('panel.label.schedule'),
        value: t(plan.scheduleKey),
      });
      rows.push({
        key: 'time',
        label: t('panel.label.time'),
        value: t('panel.clock', { utc: formatUtcClock(now), utc8: formatUtc8Clock(now) }),
      });
      if (plan.usesChinaHolidays) {
        rows.push({
          key: 'calendar',
          label: t('panel.label.calendar'),
          value: covered
            ? t('panel.calendar', { years: String(COVERED_FROM) + '-' + String(COVERED_TO) })
            : t('panel.calendarMissing', { year: year }),
        });
      }
      rows.push({
        key: 'provider',
        label: t('panel.label.provider'),
        value: provider,
      });

      return {
        peak: peak,
        label: label,
        rate: rate,
        countdown: countdown,
        notes: notes,
        title: t('panel.title', { plan: planLabel }),
        planLabel: planLabel,
        stateText: t('panel.state', { state: label, rate: rate }),
        next:
          changeAt === null
            ? null
            : t('panel.next', {
                next: t(peak ? 'state.offPeak' : 'state.peak'),
                time: formatDuration(changeAt - now),
                when: formatChangeStamp(changeAt, now),
              }),
        rows: rows,
      };
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    /** The dock entry the pill occupies; a fresh id keeps the shipped cells. */
    const ENTRY_ID = 'off-peak-hours';
    const ENTRY_ORDER = 10;

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');

        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          ctx.effect(
            function () {
              const disposers = [];
              try {
                disposers.push(locale.register(NS, 'en', EN));
                disposers.push(locale.register(NS, 'zh', ZH));
              } catch (error) {
                // A duplicate or rejected namespace only costs localization:
                // the component keeps its built-in English dictionary.
              }
              return function () {
                for (const dispose of disposers) {
                  try {
                    dispose();
                  } catch (error) {
                    /* already removed */
                  }
                }
              };
            },
            'off-peak-hours: dictionaries',
          );
        }

        const Badge = createBadge(ctx);
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              ...(locale === undefined || locale === null ? {} : { locale: NS }),
            },
            Badge,
          );
        });
      },
    };
  },
});
