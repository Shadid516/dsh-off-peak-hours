/**
 * Schedule and rendering tests for client.js.
 *
 * The Client module is a browser artifact that registers itself on
 * `window.__ModuleLoader__`, so the test captures that registration and drives
 * the real component with a small React stand-in. Nothing here re-implements
 * the schedule: every expectation is checked against the shipped code.
 *
 * Run: node --test test/
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// The component owns a one-second interval; unref it so the test process can
// exit. The interval itself still runs, exactly as it does in the browser.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, delay) => {
  const timer = realSetInterval(callback, delay);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

/** Event-target stand-in: records listeners so a test can fire them. */
function createEventTarget() {
  const byType = new Map();
  return {
    addEventListener(type, listener) {
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      const set = byType.get(type);
      if (set !== undefined) set.delete(listener);
    },
    /** Number of live listeners for a type — used to prove cleanup. */
    listenerCount(type) {
      const set = byType.get(type);
      return set === undefined ? 0 : set.size;
    },
    /** Fire a type; returns how many listeners ran. */
    dispatch(type, event) {
      const set = byType.get(type);
      if (set === undefined) return 0;
      for (const listener of [...set]) listener(event);
      return set.size;
    },
  };
}

/**
 * Node stand-in, so `event.target instanceof Node` is decidable and the
 * placement hook has geometry to read.
 *
 * Geometry is off by default — `getBoundingClientRect()` returns undefined,
 * which is the "not laid out yet" case the hook guards. A test that wants
 * placement sets the static fields and restores them.
 */
class FakeNode {
  constructor() {
    this.children = [];
    this.rect = FakeNode.rect;
    this.offsetWidth = FakeNode.width;
    this.offsetHeight = FakeNode.height;
  }
  contains(other) {
    return other === this || this.children.includes(other);
  }
  getBoundingClientRect() {
    return this.rect;
  }
}
FakeNode.rect = undefined;
FakeNode.width = 0;
FakeNode.height = 0;

/** Run a body with node geometry in place, then restore no-geometry. */
function withGeometry(rect, size, body) {
  FakeNode.rect = rect;
  FakeNode.width = size.width;
  FakeNode.height = size.height;
  try {
    return body();
  } finally {
    FakeNode.rect = undefined;
    FakeNode.width = 0;
    FakeNode.height = 0;
  }
}

/** React stand-in: element trees plus a cursored hook store. */
function createReact() {
  let hooks = [];
  let cursor = 0;
  let expected = null;
  let pending = [];

  // Effects are deferred to `endRender`, as React defers them past the commit:
  // an effect must observe the refs of the tree it just rendered, not the
  // previous one.
  const queueEffect = (effect, deps, slot) => {
    const previous = hooks[slot];
    const changed =
      previous === undefined ||
      deps === undefined ||
      previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, index) => value !== previous.deps[index]);
    if (!changed) return;
    pending.push(() => {
      const prior = hooks[slot];
      if (prior !== undefined && typeof prior.cleanup === 'function') prior.cleanup();
      hooks[slot] = { deps, cleanup: effect() };
    });
  };

  return {
    createElement(type, props, ...children) {
      // React flattens array children; the component passes a children array,
      // so the stand-in has to do the same or the tree nests.
      const element = {
        type,
        props: props === null || props === undefined ? {} : props,
        children: children.flat(Infinity),
      };
      // Attach object refs to a stand-in node, so the outside-pointer check has
      // something to test containment against. `element.dom` is the test's
      // handle on the node React would have mounted.
      const ref = element.props.ref;
      if (ref !== null && typeof ref === 'object') {
        element.dom = new FakeNode();
        ref.current = element.dom;
      }
      return element;
    },
    useState(init) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = typeof init === 'function' ? init() : init;
      return [
        hooks[slot],
        (value) => {
          hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value;
        },
      ];
    },
    useRef(init) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = { current: init };
      return hooks[slot];
    },
    useEffect(effect, deps) {
      queueEffect(effect, deps, cursor++);
    },
    useLayoutEffect(effect, deps) {
      queueEffect(effect, deps, cursor++);
    },
    /**
     * Stand-in for a framework seat hook (`useProjection`, `useSession`, …):
     * consuming a hook slot is the whole point, so that a component which
     * skips the call on a later render is caught by {@link endRender}.
     */
    useSeat(compute) {
      cursor += 1;
      return compute();
    },
    /**
     * Open a render; {@link endRender} closes it. Together they enforce
     * React's positional hook contract: a re-render that calls a different
     * number of hooks is exactly what retires a slot entry in the browser, so
     * the harness fails it here instead.
     */
    beginRender() {
      cursor = 0;
      pending = [];
    },
    endRender() {
      const queued = pending;
      pending = [];
      for (const task of queued) task();
      if (expected === null) {
        expected = cursor;
        return;
      }
      if (cursor !== expected) {
        throw new Error(
          'hook order changed: the first render called ' +
            expected +
            ' hooks, this one called ' +
            cursor +
            ' (React would raise "Rendered fewer hooks than expected" and retire the entry)',
        );
      }
    },
  };
}

/**
 * Load client.js, run its `apply` against a stub context, and return the
 * registered dock entry plus a render helper.
 */
function loadEntry({ models, locale = createLocale() } = {}) {
  // The component reaches for `document` and `Node` as globals and for
  // `window` from its module scope; both are supplied so its effects run.
  const body = new FakeNode();
  const documentStub = createEventTarget();
  documentStub.body = body;
  globalThis.document = documentStub;
  globalThis.Node = FakeNode;
  // eslint-disable-next-line no-undefined
  globalThis.ResizeObserver = undefined;

  let registration = null;
  const window = createEventTarget();
  window.innerWidth = 1280;
  window.innerHeight = 800;
  window.__ModuleLoader__ = {
    load(value) {
      registration = value;
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', SOURCE)(window);
  assert.equal(registration.id, 'dsh-off-peak-hours');

  const portals = [];
  const React = createReact();
  const ReactDOM = {
    createPortal(node, container) {
      portals.push({ node, container });
      return node;
    },
  };
  const face = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    if (specifier === 'react-dom') return ReactDOM;
    throw new Error('unexpected require: ' + specifier);
  });
  assert.deepEqual(face.inject, ['slots']);

  let entry = null;
  const ctx = {
    get(name) {
      if (name === 'modelDirectories') return models;
      if (name === 'locale') return locale;
      return undefined;
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject(key, callback) {
        assert.equal(key, 'conversation.composer.dock');
        callback();
      },
      register(options, component) {
        entry = { options, component };
      },
    },
  };
  face.apply(ctx);
  assert.ok(entry, 'the dock entry registered');
  assert.equal(entry.options.name, 'conversation.composer.dock');
  assert.equal(entry.options.id, 'off-peak-hours');

  const originalNow = Date.now;
  const entryApi = {
    options: entry.options,
    locale,
    document: documentStub,
    window,
    portals,
    /**
     * Render to a settled tree: React mounts, runs effects, then re-renders the
     * state those effects produced.
     */
    render(atMs, props = {}) {
      Date.now = () => atMs;
      // The kit's `useProjection` is a framework hook, so the harness gives the
      // component a seat-shaped one rather than a plain function.
      const readProjection = props.useProjection;
      const shaped =
        typeof readProjection === 'function'
          ? {
              ...props,
              useProjection: (key) => React.useSeat(() => readProjection(key)),
            }
          : props;
      try {
        let element = null;
        for (let pass = 0; pass < 3; pass += 1) {
          React.beginRender();
          element = entry.component({ sessionId: 'session-1', ...shaped });
          React.endRender();
        }
        return element;
      } finally {
        Date.now = originalNow;
      }
    },
  };

  /**
   * Render, click the trigger, and render again — the two-step the browser
   * performs when the panel opens.
   */
  entryApi.open = function (atMs, props = {}) {
    const closed = entryApi.render(atMs, props);
    buttonOf(closed).props.onClick();
    return entryApi.render(atMs, props);
  };

  return entryApi;
}

/** Locale service stand-in that records what the plugin contributes. */
function createLocale() {
  const registrations = [];
  return {
    registrations,
    register(ns, id, dict) {
      registrations.push({ ns, locale: id, dict });
      return () => {};
    },
  };
}

/** Flatten one element's string children. */
function textOf(element) {
  if (element === null || element === undefined) return '';
  if (typeof element === 'string') return element;
  if (typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(textOf).join('');
  return (element.children ?? []).map(textOf).join('');
}

function pillOf(element) {
  assert.ok(element, 'the badge rendered');
  assert.equal(element.type, 'div');
  assert.equal(element.props.className, 'opkh-root');
  // The trigger sits in an anchor span, which is what the placement hook and
  // the outside-pointer check both measure.
  const anchor = element.children.find(
    (child) => child && child.props && child.props.className === 'opkh-anchor',
  );
  assert.ok(anchor, 'the anchor rendered');
  const pill = anchor.children.find(
    (child) => child && child.props && child.props.className === 'opkh-pill',
  );
  assert.ok(pill, 'the pill rendered');
  return pill;
}

/** The trigger's anchor span — what the placement hook measures off. */
function anchorOf(element) {
  assert.ok(element, 'the badge rendered');
  const anchor = element.children.find(
    (child) => child && child.props && child.props.className === 'opkh-anchor',
  );
  assert.ok(anchor, 'the anchor rendered');
  return anchor;
}

/** The pill is the trigger: a button that owns the panel. */
function buttonOf(element) {
  const pill = pillOf(element);
  assert.equal(pill.type, 'button', 'the pill opens a dialog, so it is a button');
  return pill;
}

/** The portaled panel, or null while it is closed. */
function panelOrNull(element) {
  if (element === null || element === undefined) return null;
  return (
    element.children.find(
      (child) => child && child.props && child.props.className === 'opkh-panel',
    ) ?? null
  );
}

function panelOf(element) {
  const panel = panelOrNull(element);
  assert.ok(panel, 'the panel rendered');
  assert.equal(panel.props.role, 'dialog');
  return panel;
}

/** The panel's `dt`/`dd` pairs as one label-to-value object. */
function rowsOf(panel) {
  const list = panel.children.find((child) => child && child.type === 'dl');
  assert.ok(list, 'the details list rendered');
  const rows = {};
  for (let index = 0; index + 1 < list.children.length; index += 2) {
    rows[textOf(list.children[index])] = textOf(list.children[index + 1]);
  }
  return rows;
}

const DEEPSEEK = { sessionId: 'session-1', useProjection: () => ({ lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, next: null }) };
const deepseekProps = (extra = {}) => ({ ...DEEPSEEK, ...extra });
const zaiProps = (provider = 'zai', extra = {}) => ({
  sessionId: 'session-1',
  useProjection: () => ({ lastUsed: { provider, model: 'glm-5.3' }, next: null }),
  ...extra,
});
const utc = (iso) => Date.parse(iso);

// ---------------------------------------------------------------------------
// Peak / off-peak classification
// ---------------------------------------------------------------------------

const CASES = [
  // [instant, peak, why]
  ['2026-09-27T03:00:00Z', false, 'Sunday inside a window: weekends are off-peak'],
  ['2026-09-27T09:30:00Z', false, 'Sunday inside a window'],
  ['2026-09-28T00:30:00Z', false, 'Monday before the first window'],
  ['2026-09-28T01:00:00Z', true, 'Monday, first window opens (inclusive)'],
  ['2026-09-28T03:59:00Z', true, 'Monday, first window still open'],
  ['2026-09-28T04:00:00Z', false, 'Monday, first window closes (exclusive)'],
  ['2026-09-28T05:59:00Z', false, 'Monday, between the windows'],
  ['2026-09-28T06:00:00Z', true, 'Monday, second window opens'],
  ['2026-09-28T09:59:00Z', true, 'Monday, second window still open'],
  ['2026-09-28T10:00:00Z', false, 'Monday, second window closes'],
  ['2026-10-02T02:00:00Z', false, 'Friday inside the 2026 National Day block'],
  ['2026-10-03T02:00:00Z', false, 'Saturday inside the 2026 National Day block'],
  ['2026-10-07T02:00:00Z', false, 'last National Day holiday day'],
  ['2026-10-08T02:00:00Z', true, 'Thursday after the National Day block'],
  ['2026-02-23T02:00:00Z', false, 'last Spring Festival day (a Monday)'],
  ['2026-02-24T02:00:00Z', true, 'Tuesday after the Spring Festival block'],
  ['2026-02-14T02:00:00Z', false, 'Saturday before the Spring Festival block'],
  ['2026-02-16T02:00:00Z', false, 'Spring Festival day two (a Monday)'],
  ['2026-06-19T02:00:00Z', false, 'Dragon Boat Friday'],
  ['2026-06-22T02:00:00Z', true, 'Monday after the Dragon Boat block'],
  ['2025-09-29T02:00:00Z', true, 'Monday before the 2025 National Day block'],
  ['2025-10-01T02:00:00Z', false, '2025 National Day block (merged with Mid-Autumn)'],
  ['2025-10-08T02:00:00Z', false, 'last day of the 2025 merged block'],
  ['2025-10-09T02:00:00Z', true, 'Thursday after the 2025 merged block'],
  ['2025-01-27T02:00:00Z', true, 'Monday before the 2025 Spring Festival'],
  ['2025-01-28T02:00:00Z', false, '2025 Spring Festival eve'],
  ['2025-02-04T02:00:00Z', false, 'last day of the 2025 Spring Festival'],
  ['2025-02-05T02:00:00Z', true, 'Wednesday after the 2025 Spring Festival'],
  ['2025-05-01T02:00:00Z', false, '2025 Labour Day'],
  ['2025-05-06T02:00:00Z', true, 'Tuesday after 2025 Labour Day'],
  ['2025-01-04T02:00:00Z', false, 'Saturday makeup workday stays off-peak'],
  ['2026-02-28T02:00:00Z', false, 'Saturday makeup workday stays off-peak'],
  ['2027-03-02T02:00:00Z', true, 'year outside the table: weekday rule only'],
];

for (const [instant, peak, why] of CASES) {
  test(`${instant} is ${peak ? 'peak' : 'off-peak'} — ${why}`, () => {
    const entry = loadEntry();
    const element = entry.render(utc(instant), deepseekProps());
    const pill = pillOf(element);
    assert.equal(element.props['data-off-peak-hours'], peak ? 'peak' : 'off-peak');
    assert.match(textOf(pill), new RegExp('^' + (peak ? 'Peak' : 'Off-peak')));
    assert.match(textOf(pill), peak ? /full rate/ : /50% off/);
  });
}

// ---------------------------------------------------------------------------
// Next transition
//
// A change less than a day away is stamped by weekday; further out it gains a
// date, because a weekday alone no longer identifies the day.
// ---------------------------------------------------------------------------

const TRANSITIONS = [
  ['2026-09-27T03:00:00Z', 'Mon 01:00 UTC', 'weekend runs into Monday peak'],
  ['2026-09-28T00:30:00Z', 'Mon 01:00 UTC', 'first window opens'],
  ['2026-09-28T02:00:00Z', 'Mon 04:00 UTC', 'first window closes'],
  ['2026-09-28T05:00:00Z', 'Mon 06:00 UTC', 'second window opens'],
  ['2026-09-28T07:00:00Z', 'Mon 10:00 UTC', 'second window closes'],
  ['2026-10-09T11:00:00Z', 'Mon 2026-10-12 01:00 UTC', 'Friday afternoon reaches Monday peak'],
  ['2026-10-06T07:00:00Z', 'Thu 2026-10-08 01:00 UTC', 'holiday Tuesday reaches Thursday peak'],
];

for (const [instant, expected, why] of TRANSITIONS) {
  test(`next change after ${instant} is ${expected} — ${why}`, () => {
    const entry = loadEntry();
    const panel = panelOf(entry.open(utc(instant), deepseekProps()));
    const answer = textOf(panel.children.find((child) => child && child.type === 'p'));
    assert.ok(
      answer.includes('begins in ') && answer.includes('at ' + expected),
      'expected a "begins in ..., at ' + expected + '" answer, got: ' + answer,
    );
  });
}

test('the panel names what begins, not just when', () => {
  // The pill's own "starts in 5h 57m" does not say what starts; the panel has
  // to, and it has to agree with the state the pill is showing.
  const offPeak = panelOf(loadEntry().open(utc('2026-09-27T19:03:00Z'), deepseekProps()));
  assert.match(offPeak.props['aria-label'], /DeepSeek peak \/ off-peak pricing/);
  assert.match(textOf(offPeak), /Peak begins in 5h 57m, at Mon 01:00 UTC/);
  assert.doesNotMatch(textOf(offPeak), /Off-peak begins/);

  const peak = panelOf(loadEntry().open(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  assert.match(textOf(peak), /Off-peak begins in 2h, at Mon 04:00 UTC/);
  assert.doesNotMatch(textOf(peak), /Peak begins/);
});

test('the panel header always agrees with the pill', () => {
  for (const instant of [
    '2026-09-27T19:03:00Z',
    '2026-09-28T02:00:00Z',
    '2026-10-01T02:00:00Z',
    '2027-03-02T02:00:00Z',
  ]) {
    const entry = loadEntry();
    const closed = entry.render(utc(instant), deepseekProps());
    const peak = closed.props['data-off-peak-hours'] === 'peak';
    const panel = panelOf(entry.open(utc(instant), deepseekProps()));
    const title = panel.children.find(
      (child) => child && child.props && child.props.className === 'opkh-panel-title',
    );
    const header = title.children.find(
      (child) => child && child.props && child.props.className === 'opkh-panel-title-value',
    );
    assert.equal(
      textOf(header),
      peak ? 'Peak (full rate)' : 'Off-peak (50% off)',
      'disagreement at ' + instant,
    );
  }
});

// ---------------------------------------------------------------------------
// The click-opened panel
//
// The shipped stat pills beside this one open a dialog on click rather than a
// hover tooltip; these cover the same seat: portal, aria state, and the two
// dismissals.
// ---------------------------------------------------------------------------

const OPEN_AT = utc('2026-09-28T02:00:00Z');

test('the trigger is a collapsed dialog button until it is clicked', () => {
  const entry = loadEntry();
  const closed = entry.render(OPEN_AT, deepseekProps());
  const button = buttonOf(closed);
  assert.equal(button.props['aria-haspopup'], 'dialog');
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(button.props.type, 'button');
  assert.equal(panelOrNull(closed), null, 'nothing is rendered before the click');

  const opened = entry.open(OPEN_AT, deepseekProps());
  assert.equal(buttonOf(opened).props['aria-expanded'], true);
  assert.ok(panelOrNull(opened), 'the click opened the panel');
});

test('a second click closes the panel again', () => {
  const entry = loadEntry();
  const opened = entry.open(OPEN_AT, deepseekProps());
  buttonOf(opened).props.onClick();
  const closed = entry.render(OPEN_AT, deepseekProps());
  assert.equal(panelOrNull(closed), null);
  assert.equal(buttonOf(closed).props['aria-expanded'], false);
});

test('the panel is portaled to document.body, not nested in the composer', () => {
  const entry = loadEntry();
  entry.open(OPEN_AT, deepseekProps());
  assert.ok(entry.portals.length > 0, 'the open panel renders through a portal');
  for (const portal of entry.portals) {
    assert.equal(portal.container, entry.document.body, 'every portal targets body');
    assert.equal(portal.node.props.className, 'opkh-panel');
  }
});

test('the panel waits invisible until the trigger has geometry to place against', () => {
  // No layout yet: `place()` bails and the panel stays at the origin, hidden.
  const panel = panelOf(loadEntry().open(OPEN_AT, deepseekProps()));
  assert.equal(panel.props.style.visibility, 'hidden');
  assert.equal(panel.props.style.left, 0);
  assert.equal(panel.props.style.top, 0);
});

test('the panel sits above the trigger, gap included', () => {
  const panel = panelOf(
    withGeometry(
      { left: 100, top: 700, width: 200, height: 20, right: 300, bottom: 720 },
      { width: 320, height: 180 },
      () => loadEntry().open(OPEN_AT, deepseekProps()),
    ),
  );
  // left follows the trigger; top is the trigger's top, less the 8px gap and
  // the panel's own height.
  assert.deepEqual(panel.props.style, { left: 100, top: 512 });
});

test('placement is clamped into the viewport on both axes', () => {
  const panel = panelOf(
    withGeometry(
      { left: 1200, top: 30, width: 60, height: 20, right: 1260, bottom: 50 },
      { width: 320, height: 180 },
      () => loadEntry().open(OPEN_AT, deepseekProps()),
    ),
  );
  // 1280 - 320 - 12, and the 12px margin for a panel that would sit above y=0.
  assert.deepEqual(panel.props.style, { left: 948, top: 12 });
});

test('Escape closes an open panel and unbinds its listeners', () => {
  const entry = loadEntry();
  const opened = entry.open(OPEN_AT, deepseekProps());
  assert.equal(entry.document.listenerCount('keydown'), 1);
  assert.equal(entry.document.listenerCount('pointerdown'), 1);

  entry.document.dispatch('keydown', { key: 'Escape' });
  const closed = entry.render(OPEN_AT, deepseekProps());
  assert.equal(panelOrNull(closed), null, 'Escape closed it');
  assert.equal(entry.document.listenerCount('keydown'), 0, 'the listener was removed');
  assert.equal(entry.document.listenerCount('pointerdown'), 0);
});

test('another key leaves the panel open', () => {
  const entry = loadEntry();
  entry.open(OPEN_AT, deepseekProps());
  entry.document.dispatch('keydown', { key: 'a' });
  assert.ok(panelOrNull(entry.render(OPEN_AT, deepseekProps())));
});

test('a pointerdown outside the trigger and panel closes it', () => {
  const entry = loadEntry();
  entry.open(OPEN_AT, deepseekProps());
  entry.document.dispatch('pointerdown', { target: new FakeNode() });
  assert.equal(panelOrNull(entry.render(OPEN_AT, deepseekProps())), null);
});

test('a pointerdown inside the anchor or the panel keeps it open', () => {
  for (const pick of [
    (opened) => anchorOf(opened).props.ref.current,
    (opened) => panelOf(opened).props.ref.current,
  ]) {
    const entry = loadEntry();
    const opened = entry.open(OPEN_AT, deepseekProps());
    entry.document.dispatch('pointerdown', { target: pick(opened) });
    assert.ok(
      panelOrNull(entry.render(OPEN_AT, deepseekProps())),
      'a click inside the panel must not dismiss it',
    );
  }
});

test('a non-Node pointer target is ignored', () => {
  const entry = loadEntry();
  entry.open(OPEN_AT, deepseekProps());
  entry.document.dispatch('pointerdown', { target: {} });
  assert.ok(panelOrNull(entry.render(OPEN_AT, deepseekProps())));
});

test('the panel leads with the answer and lists the reference below', () => {
  const panel = panelOf(loadEntry().open(utc('2026-09-27T19:03:00Z'), deepseekProps()));
  const classes = panel.children.map((child) => child.props.className);
  assert.deepEqual(classes, [
    'opkh-panel-title',
    'opkh-panel-rule',
    'opkh-panel-answer',
    'opkh-panel-details',
  ]);
  assert.equal(panel.children[1].props['aria-hidden'], 'true', 'the title rule is decorative');

  const rows = rowsOf(panel);
  assert.deepEqual(Object.keys(rows), ['Peak hours', 'Time', 'Holiday calendar', 'Provider']);
});

test('the reference lists both time zones for the same instant', () => {
  const rows = rowsOf(panelOf(loadEntry().open(utc('2026-09-28T02:00:00Z'), deepseekProps())));
  assert.equal(rows['Time'], 'Mon 02:00 UTC · Mon 10:00 UTC+8');
});

// ---------------------------------------------------------------------------
// Countdown copy
// ---------------------------------------------------------------------------

test('countdown reports the remaining time in the current state', () => {
  const entry = loadEntry();
  const pill = pillOf(entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  assert.match(textOf(pill), /ends in 2h/);
});

test('an off-peak state reports when peak starts', () => {
  const entry = loadEntry();
  const pill = pillOf(entry.render(utc('2026-09-28T00:30:00Z'), deepseekProps()));
  assert.match(textOf(pill), /starts in 30m/);
});

test('a holiday is named in the panel', () => {
  const entry = loadEntry();
  const rows = rowsOf(panelOf(entry.open(utc('2026-10-01T02:00:00Z'), deepseekProps())));
  assert.equal(rows['Holiday'], 'National Day - off-peak all day');
});

test('an uncovered year is called out on the pill and in the panel', () => {
  const entry = loadEntry();
  const pill = pillOf(entry.render(utc('2027-03-02T02:00:00Z'), deepseekProps()));
  assert.match(textOf(pill), /calendar ends 2026/);
  const rows = rowsOf(panelOf(entry.open(utc('2027-03-02T02:00:00Z'), deepseekProps())));
  assert.equal(rows['Holiday calendar'], 'None for 2027 - only weekends count as off-peak');
});

test('a covered year carries no calendar warning', () => {
  const entry = loadEntry();
  const pill = pillOf(entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  assert.doesNotMatch(textOf(pill), /calendar ends/);
  const rows = rowsOf(panelOf(entry.open(utc('2026-09-28T02:00:00Z'), deepseekProps())));
  assert.equal(rows['Holiday calendar'], '2025-2026');
});

// ---------------------------------------------------------------------------
// Provider gating
// ---------------------------------------------------------------------------

test('renders nothing when the selected provider is not DeepSeek', () => {
  const entry = loadEntry();
  const element = entry.render(utc('2026-09-28T02:00:00Z'), {
    ...DEEPSEEK,
    useProjection: () => ({ lastUsed: { provider: 'anthropic', model: 'claude' }, next: null }),
  });
  assert.equal(element, null);
});

test('renders nothing while no provider is known', () => {
  // Each shape gets its own mount: a registration's props are stable in the
  // page, so swapping the seat in and out would be a harness artifact.
  const withSeat = loadEntry();
  assert.equal(withSeat.render(utc('2026-09-28T02:00:00Z'), { useProjection: () => undefined }), null);
  const withoutSeat = loadEntry();
  assert.equal(withoutSeat.render(utc('2026-09-28T02:00:00Z'), {}), null);
});

test('a pending switch wins over the last used provider', () => {
  const entry = loadEntry();
  const props = {
    ...DEEPSEEK,
    useProjection: () => ({
      lastUsed: { provider: 'anthropic', model: 'claude' },
      next: { provider: 'deepseek-account', model: 'deepseek-v4-pro' },
    }),
  };
  assert.ok(entry.render(utc('2026-09-28T02:00:00Z'), props), 'the pill shows');
  assert.equal(
    rowsOf(panelOf(entry.open(utc('2026-09-28T02:00:00Z'), props)))['Provider'],
    'deepseek-account',
  );
});

test('every DeepSeek provider id shape is accepted', () => {
  for (const provider of ['deepseek', 'deepseek-official', 'deepseek-account', 'DEEPSEEK-OFFICIAL']) {
    const entry = loadEntry();
    const element = entry.render(utc('2026-09-28T02:00:00Z'), {
      ...DEEPSEEK,
      useProjection: () => ({ lastUsed: { provider, model: 'm' }, next: null }),
    });
    assert.ok(element, provider + ' shows the pill');
  }
  for (const provider of ['', 'notdeepseek', 'deepseekish']) {
    const entry = loadEntry();
    assert.equal(
      entry.render(utc('2026-09-28T02:00:00Z'), {
        ...DEEPSEEK,
        useProjection: () => ({ lastUsed: { provider, model: 'm' }, next: null }),
      }),
      null,
      provider + ' hides the pill',
    );
  }
});

// ---------------------------------------------------------------------------
// z.ai / GLM Coding Plan
//
// Peak is 14:00-18:00 Singapore time (UTC+8) = 06:00-10:00 UTC, Mon-Fri, with
// no holiday exclusion, plus a dated all-day off-peak campaign. The 2026
// campaign runs 2026-09-25 to 2026-10-07 inclusive (UTC+8 days), so the
// regular-schedule cases below sit after it.
// ---------------------------------------------------------------------------

const ZAI_CASES = [
  // [instant, peak, why]
  ['2026-10-12T05:59:00Z', false, 'Monday, one minute before the window opens'],
  ['2026-10-12T06:00:00Z', true, 'Monday, window opens (inclusive)'],
  ['2026-10-12T09:59:00Z', true, 'Monday, window still open'],
  ['2026-10-12T10:00:00Z', false, 'Monday, window closes (exclusive)'],
  ['2026-10-12T02:00:00Z', false, 'Monday, inside the DeepSeek window but not the z.ai one'],
  ['2026-10-12T13:00:00Z', false, 'Monday afternoon, past the window'],
  ['2026-10-16T07:00:00Z', true, 'Friday inside the window'],
  ['2026-10-17T07:00:00Z', false, 'Saturday inside the window'],
  ['2026-10-18T07:00:00Z', false, 'Sunday inside the window'],
  ['2026-10-11T07:00:00Z', false, 'Sunday before a working week'],
  ['2027-03-02T07:00:00Z', true, 'Tuesday, any year, no calendar to consult'],
];

for (const [instant, peak, why] of ZAI_CASES) {
  test(`z.ai ${instant} is ${peak ? 'peak' : 'off-peak'} — ${why}`, () => {
    const entry = loadEntry();
    const element = entry.render(utc(instant), zaiProps());
    const pill = pillOf(element);
    assert.equal(element.props['data-off-peak-hours'], peak ? 'peak' : 'off-peak');
    assert.match(textOf(pill), new RegExp('^' + (peak ? 'Peak' : 'Off-peak')));
    assert.match(textOf(pill), peak ? /full rate/ : /50% off/);
  });
}

test('z.ai has no holiday exclusion where DeepSeek has one', () => {
  // 2026-02-17 is a Tuesday inside the Spring Festival block, outside any z.ai
  // campaign: peak for z.ai, off-peak for DeepSeek at the very same instant.
  const at = utc('2026-02-17T07:00:00Z');
  assert.equal(loadEntry().render(at, zaiProps()).props['data-off-peak-hours'], 'peak');
  assert.equal(
    loadEntry().render(at, deepseekProps()).props['data-off-peak-hours'],
    'off-peak',
  );
  // 2025-10-01 (National Day, a Wednesday) discriminates the same way.
  const nationalDay = utc('2025-10-01T07:00:00Z');
  assert.equal(loadEntry().render(nationalDay, zaiProps()).props['data-off-peak-hours'], 'peak');
  assert.equal(
    loadEntry().render(nationalDay, deepseekProps()).props['data-off-peak-hours'],
    'off-peak',
  );
});

test('the campaign makes a Monday window off-peak for z.ai only', () => {
  // 2026-09-28 is a Monday inside the campaign and inside both windows.
  const at = utc('2026-09-28T07:00:00Z');
  const entry = loadEntry();
  const zai = entry.render(at, zaiProps());
  assert.equal(zai.props['data-off-peak-hours'], 'off-peak');
  assert.match(textOf(pillOf(zai)), /campaign/);
  const rows = rowsOf(panelOf(entry.open(at, zaiProps())));
  assert.equal(rows['Campaign'], '50% off all day, 2026-09-25 to 2026-10-07');
  // The campaign row sits above the general rule, so the reader meets the
  // reason for the long wait before the rule it overrides.
  assert.deepEqual(Object.keys(rows), ['Campaign', 'Peak hours', 'Time', 'Provider']);
  // DeepSeek prices the same campaign-free instant at peak.
  assert.equal(
    loadEntry().render(utc('2026-09-28T02:00:00Z'), deepseekProps()).props['data-off-peak-hours'],
    'peak',
  );
});

test('the campaign covers its inclusive last day and not the next', () => {
  const lastDay = loadEntry().render(utc('2026-10-07T07:00:00Z'), zaiProps());
  assert.equal(lastDay.props['data-off-peak-hours'], 'off-peak', '2026-10-07 is the last campaign day');
  const after = loadEntry().render(utc('2026-10-08T07:00:00Z'), zaiProps());
  assert.equal(after.props['data-off-peak-hours'], 'peak', '2026-10-08 is a Thursday back on schedule');
});

test('the campaign starts on the UTC+8 day boundary, not the UTC one', () => {
  // 2026-09-25 00:00 UTC+8 is 2026-09-24 16:00 UTC. One minute earlier the
  // campaign has not begun; at the boundary the UTC+8 day has turned.
  const before = loadEntry().render(utc('2026-09-24T15:59:00Z'), zaiProps());
  assert.doesNotMatch(textOf(pillOf(before)), /campaign/);
  const at = loadEntry().render(utc('2026-09-24T16:00:00Z'), zaiProps());
  assert.match(textOf(pillOf(at)), /campaign/, 'the UTC+8 day has turned');
  // Because the campaign covers 2026-09-25 in UTC+8, that Friday's window
  // never opens — while the Thursday window before it was ordinary.
  assert.equal(
    loadEntry().render(utc('2026-09-24T07:00:00Z'), zaiProps()).props['data-off-peak-hours'],
    'peak',
  );
  assert.equal(
    loadEntry().render(utc('2026-09-25T07:00:00Z'), zaiProps()).props['data-off-peak-hours'],
    'off-peak',
  );
});

test('peak resumes after the campaign at the next window edge', () => {
  const entry = loadEntry();
  const panel = panelOf(entry.open(utc('2026-10-07T07:00:00Z'), zaiProps()));
  assert.match(textOf(panel), /Peak begins in 23h, at Thu 06:00 UTC/);
});

test('the z.ai panel states the plan and its own schedule', () => {
  const entry = loadEntry();
  const panel = panelOf(entry.open(utc('2026-10-12T07:00:00Z'), zaiProps()));
  assert.equal(panel.props['aria-label'], 'z.ai Coding Plan peak / off-peak pricing');
  const rows = rowsOf(panel);
  assert.equal(rows['Peak hours'], '14:00-18:00 Singapore time (UTC+8), Mon-Fri.');
  assert.equal(rows['Provider'], 'zai');
  assert.equal(rows['Holiday calendar'], undefined, 'z.ai consults no calendar');
});

test('both z.ai catalog routes resolve to the same plan', () => {
  for (const provider of ['zai', 'zai-coding-cn', 'ZAI-CODING-CN']) {
    const entry = loadEntry();
    const element = entry.render(utc('2026-10-12T07:00:00Z'), zaiProps(provider));
    assert.ok(element, provider + ' shows the pill');
    assert.equal(element.props['data-off-peak-hours'], 'peak');
    assert.equal(
      panelOf(entry.open(utc('2026-10-12T07:00:00Z'), zaiProps(provider))).props['aria-label'],
      'z.ai Coding Plan peak / off-peak pricing',
    );
  }
});

test('a provider no plan claims stays hidden', () => {
  for (const provider of ['zaiish', 'za', 'anthropic', 'glm', 'openai', '']) {
    assert.equal(
      loadEntry().render(utc('2026-10-12T07:00:00Z'), zaiProps(provider)),
      null,
      provider + ' hides the pill',
    );
  }
});

// ---------------------------------------------------------------------------
// Model-directory resolution (the blank-Session path)
// ---------------------------------------------------------------------------

function directoryModels(provider) {
  let snapshot = { current: provider === null ? null : { provider, model: 'deepseek-flash' } };
  const listeners = new Set();
  return {
    directoryFor() {
      return {
        store: {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      };
    },
    set(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

test('the model directory answers before any selection exists', () => {
  const models = directoryModels('deepseek-official');
  const entry = loadEntry({ models });
  const props = { useProjection: () => undefined };
  assert.ok(entry.render(utc('2026-09-28T02:00:00Z'), props), 'the catalog default decides the pill');
  assert.equal(
    rowsOf(panelOf(entry.open(utc('2026-09-28T02:00:00Z'), props)))['Provider'],
    'deepseek-official',
  );
});

test('a non-DeepSeek catalog default hides the pill', () => {
  const entry = loadEntry({ models: directoryModels('anthropic') });
  assert.equal(entry.render(utc('2026-09-28T02:00:00Z'), { useProjection: () => undefined }), null);
});

test('a provider switch through the directory updates the pill', () => {
  const models = directoryModels('deepseek-official');
  const entry = loadEntry({ models });
  const props = { useProjection: () => undefined };
  assert.ok(entry.render(utc('2026-09-28T02:00:00Z'), props));
  models.set({ current: { provider: 'anthropic', model: 'claude' } });
  assert.equal(entry.render(utc('2026-09-28T02:00:00Z'), props), null);
  models.set({ current: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } });
  assert.ok(entry.render(utc('2026-09-28T02:00:00Z'), props));
});

test('a throwing model-directory service degrades to the projection', () => {
  const models = {
    directoryFor() {
      throw new Error('ui-model-selection: session "session-1" resolved no scope');
    },
  };
  const entry = loadEntry({ models });
  assert.ok(entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps()), 'the projection answers');
  assert.equal(
    rowsOf(panelOf(entry.open(utc('2026-09-28T02:00:00Z'), deepseekProps())))['Provider'],
    'deepseek-official',
  );
});

test('an empty catalog falls back to the projection', () => {
  const entry = loadEntry({ models: directoryModels(null) });
  assert.ok(entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  assert.equal(
    rowsOf(panelOf(entry.open(utc('2026-09-28T02:00:00Z'), deepseekProps())))['Provider'],
    'deepseek-official',
  );
});

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

test('the component falls back to English without a translate seat', () => {
  const entry = loadEntry();
  const pill = pillOf(entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  assert.match(textOf(pill), /Peak/);
  assert.equal(
    panelOf(entry.open(utc('2026-09-28T02:00:00Z'), deepseekProps())).props['aria-label'],
    'DeepSeek peak / off-peak pricing',
  );
});

test('a translate seat drives every visible string', () => {
  const entry = loadEntry();
  const dict = {
    'state.peak': 'SPITZE',
    'state.offPeak': 'NEBENZEIT',
    'rate.full': 'VOLL',
    'rate.half': 'HALB',
    'countdown.ends': 'endet in {time}',
    'countdown.starts': 'beginnt in {time}',
    'plan.deepseek': 'DEEPSEEK',
    'panel.title': 'TITEL {plan}',
    'panel.state': 'JETZT {state} ({rate})',
    'panel.next': '{next} AB {time} UM {when}',
    'schedule.deepseek': 'REGEL',
    'panel.clock': 'UHR {utc} {utc8}',
    'panel.holiday': 'FEIERTAG {name}',
    'panel.promotion': 'AKTION {from} {to}',
    'panel.calendar': 'KALENDER {years}',
    'panel.calendarMissing': 'KEIN KALENDER {year}',
    'panel.label.holiday': 'FEIERTAGSLABEL',
    'panel.label.campaign': 'AKTIONSLABEL',
    'panel.label.schedule': 'REGELSLABEL',
    'panel.label.time': 'UHRLABEL',
    'panel.label.calendar': 'KALENDERLABEL',
    'panel.label.provider': 'ANBIETERLABEL',
    'holiday.nationalDay': 'NATIONALFEIERTAG',
  };
  const t = (key, params = {}) => {
    let text = dict[key] ?? key;
    for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
    return text;
  };
  const pill = pillOf(entry.render(utc('2026-10-01T02:00:00Z'), deepseekProps({ t })));
  assert.match(textOf(pill), /^NEBENZEIT/);
  assert.match(textOf(pill), /HALB/);
  assert.match(textOf(pill), /beginnt in 6d 23h/);

  const panel = panelOf(entry.open(utc('2026-10-01T02:00:00Z'), deepseekProps({ t })));
  const text = textOf(panel);
  assert.equal(panel.props['aria-label'], 'TITEL DEEPSEEK');  assert.match(text, /JETZT NEBENZEIT \(HALB\)/);
  // The state that begins is named through the dictionary too, not hard-coded.
  assert.match(text, /SPITZE AB 6d 23h UM Thu 2026-10-08 01:00 UTC/);

  const rows = rowsOf(panel);
  assert.equal(rows['REGELSLABEL'], 'REGEL');
  assert.equal(rows['UHRLABEL'], 'UHR Thu 02:00 UTC Thu 10:00 UTC+8');
  assert.equal(rows['FEIERTAGSLABEL'], 'FEIERTAG NATIONALFEIERTAG');
  assert.equal(rows['KALENDERLABEL'], 'KALENDER 2025-2026');
  assert.equal(rows['ANBIETERLABEL'], 'deepseek-official');
  assert.doesNotMatch(text, /(panel|tip|schedule|holiday|state|rate|countdown)\./, 'no key leaked untranslated');
  assert.doesNotMatch(textOf(pill), /(countdown|state|rate)\./);
});

// ---------------------------------------------------------------------------
// Determinism and hygiene
// ---------------------------------------------------------------------------

test('the same instant always yields the same answer', () => {
  // Two separate mounts: one entry's panel would only toggle on a second click.
  const first = panelOf(loadEntry().open(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  const second = panelOf(loadEntry().open(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  assert.equal(textOf(first), textOf(second));
  assert.equal(first.props['aria-label'], second.props['aria-label']);
});

test('every colour is a theme token, with a literal only as its fallback', () => {
  const entry = loadEntry();
  const element = entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps());
  const style = element.children.find((child) => child && child.type === 'style');
  assert.ok(style, 'the component carries its own stylesheet');
  const css = style.children.join('');
  const colors = new Set(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []);
  assert.deepEqual(
    [...colors].sort(),
    ['#16a34a', '#d97706', '#fff'],
    'hex colours appear only as fallbacks inside var()',
  );
  // Every literal sits inside a var() fallback position, never as a bare value.
  for (const literal of colors) {
    assert.match(css, new RegExp('var\\([^)]*' + literal + '\\)'), literal + ' is a fallback');
  }
  for (const token of [
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-primary',
    '--dsw-alias-border-l2',
  ]) {
    assert.ok(css.includes(token), 'stylesheet uses ' + token);
  }
});

test('the pill joins its segments with single separators', () => {
  const entry = loadEntry();
  const pill = pillOf(entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps()));
  const flat = pill.children.flat();
  assert.equal(flat[0].props.className, 'opkh-dot');
  assert.deepEqual(
    flat.slice(1).map((child) => child.props.className ?? ''),
    ['opkh-strong', 'opkh-sep', '', 'opkh-sep', ''],
    'state, rate and countdown separated exactly once each',
  );
});

test('the dot centres on the text x-height, not the flex line', () => {
  const entry = loadEntry();
  const element = entry.render(utc('2026-09-28T02:00:00Z'), deepseekProps());
  const css = element.children.find((child) => child && child.type === 'style').children.join('');

  const dot = /\.opkh-dot\{([^}]*)\}/.exec(css)[1];
  assert.match(dot, /display:inline-block/, 'the dot must be an inline-level box to use vertical-align');
  assert.match(dot, /vertical-align:middle/, 'middle is baseline + half the x-height: the optical centre');

  const pill = /\.opkh-pill\{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(
    pill,
    /align-items:center/,
    'line-box centring is what left the dot hanging below the baseline',
  );
  assert.doesNotMatch(pill, /display:inline-flex/);

  // Spacing must survive without flex `gap`.
  assert.match(dot, /margin-right:6px/);
  assert.match(css, /\.opkh-sep\{[^}]*margin:0 6px/);
});

test('the dock entry declares a fresh id and a stable order', () => {
  const entry = loadEntry();
  assert.equal(entry.options.id, 'off-peak-hours');
  assert.equal(typeof entry.options.order, 'number');
  assert.equal(entry.options.locale, 'offPeakHours');
});

test('the plugin registers one English and one Chinese dictionary', () => {
  const entry = loadEntry();
  const locales = entry.locale.registrations.map((item) => item.locale).sort();
  assert.deepEqual(locales, ['en', 'zh']);
  for (const item of entry.locale.registrations) {
    assert.equal(item.ns, 'offPeakHours');
  }
  const [en, zh] = entry.locale.registrations;
  assert.deepEqual(
    Object.keys(zh.dict).sort(),
    Object.keys(en.dict).sort(),
    'both dictionaries cover the same keys',
  );
  for (const value of Object.values(en.dict)) {
    assert.equal(typeof value, 'string');
  }
});

test('without a locale service the entry still registers, unlocalized', () => {
  let registration = null;
  const window = createEventTarget();
  window.__ModuleLoader__ = { load: (value) => { registration = value; } };
  new Function('window', SOURCE)(window);
  const React = createReact();
  const face = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    if (specifier === 'react-dom') return { createPortal: (node) => node };
    throw new Error('unexpected require: ' + specifier);
  });
  let entry = null;
  face.apply({
    get: () => undefined,
    effect: (callback) => callback(),
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        entry = { options, component };
      },
    },
  });
  assert.equal(entry.options.locale, undefined);
  assert.equal(entry.options.id, 'off-peak-hours');
});

// ---------------------------------------------------------------------------
// Untrusted provider names
// ---------------------------------------------------------------------------
//
// The provider string is the only value the pill renders that comes from
// outside this module: it is whatever the model directory or the Session's
// projection reports. It reaches the panel as a plain text child, and
// SECURITY.md names a crafted provider name as a risk the suite covers — so it
// is covered here rather than assumed. These payloads all begin with
// `deepseek-`, which is what makes them match a plan: a payload that no plan
// claimed would render nothing and pass vacuously, so each case asserts the
// pill rendered first.

/** Every element `type` in a rendered tree, for asserting nothing was injected. */
function elementTypesIn(element, found = []) {
  if (element === null || element === undefined) return found;
  if (Array.isArray(element)) {
    for (const child of element) elementTypesIn(child, found);
    return found;
  }
  if (typeof element !== 'object') return found;
  found.push(element.type);
  elementTypesIn(element.children ?? [], found);
  return found;
}

/** The element types a markup injection would have to create to do anything. */
const MARKUP_ELEMENTS = ['img', 'script', 'svg', 'iframe', 'object', 'embed', 'a', 'link', 'meta'];

test('a provider name carrying markup stays text', () => {
  const payloads = [
    'deepseek-<img src=x onerror=alert(1)>',
    'deepseek-"><script>alert(1)</script>',
    'deepseek-<svg/onload=alert(1)>',
    'deepseek-</dd><a href="https://evil.example">x</a>',
  ];

  for (const crafted of payloads) {
    const entry = loadEntry({ models: directoryModels(crafted) });
    const props = { useProjection: () => undefined };

    // `pillOf` asserts the entry rendered at all, so a payload silently
    // rejected by `matches` cannot pass this test by rendering nothing.
    const tree = entry.render(utc('2026-09-28T02:00:00Z'), props);
    pillOf(tree);

    const panel = panelOf(entry.open(utc('2026-09-28T02:00:00Z'), props));
    const list = panel.children.find((child) => child && child.type === 'dl');
    assert.ok(list, 'the details list rendered');

    const pairs = [];
    for (let index = 0; index + 1 < list.children.length; index += 2) {
      pairs.push([list.children[index], list.children[index + 1]]);
    }
    const providerRow = pairs.find(([label]) => textOf(label) === 'Provider');
    assert.ok(providerRow, 'the provider row rendered');

    // The value is one string child — what React escapes at commit — rather
    // than a nested element, or a props object carrying the payload.
    assert.equal(providerRow[1].children.length, 1, `one child for ${crafted}`);
    assert.equal(typeof providerRow[1].children[0], 'string', `a string child for ${crafted}`);
    assert.equal(providerRow[1].children[0], crafted, `the payload survives verbatim as text: ${crafted}`);

    // And nothing anywhere in the rendered tree became a markup element.
    for (const type of [...elementTypesIn(panel), ...elementTypesIn(tree)]) {
      assert.ok(
        !MARKUP_ELEMENTS.includes(type),
        `a <${String(type)}> element was created from the provider name ${crafted}`,
      );
    }
  }
});

