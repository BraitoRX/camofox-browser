// Per-tab "links-only" navigation guard and bounded action ledger.
//
// WHAT THIS IS
//   An opt-in, per-tab agent-workflow POLICY. While a tab is guarded the agent
//   may only make progress through native hyperlink clicks, scrolling,
//   viewport changes, screenshots/snapshots (observation), tab close, and guard
//   status. Caller-supplied JavaScript is rejected wholesale at the route
//   boundary -- this module never evaluates caller text and never tries to
//   regex-filter "read-only" JavaScript, because arbitrary JS cannot be made
//   safe that way.
//
// WHAT THIS IS NOT
//   Not a security sandbox. It cannot and does not restrict other MCP tools,
//   other clients, plugins, or JavaScript already running inside the page.
//   Callers still own tab ownership, session auth, and withTabLock locking.
//
// OBSERVED NAVIGATION vs INPUT DISPATCH
//   This module never clicks, types, scrolls, or mutates the DOM. The caller
//   performs exactly one normal native click and sets
//   `entry.dispatchRequested = true` immediately before dispatching. That flag
//   means "input dispatch was requested", never "a physical click happened".
//   URL transitions, hash changes, and popup tabs are recorded as independent
//   OBSERVATIONS, so a thrown click error and an observed navigation can both
//   be true for one action.
//
// VIEWPORT vs DOM MUTATION
//   Guarded target inspection only reads (getBoundingClientRect, computed
//   styles, elementFromPoint, closest('a[href]')). Nothing here scrolls the
//   page, changes ids/styles, dispatches events, or evaluates caller text.
//
// MEMORY AND PRIVACY
//   Observed URLs, target hrefs, and anchor text stay in this process's memory
//   for the lifetime of the guard: no filesystem writes, no logging, no
//   cookies, no typed text, no selector strings, no telemetry. Snapshots are
//   deep copies, so mutating a returned object cannot mutate guard state.
//
// INACTIVITY
//   Every helper is a no-op (or an "unrestricted" snapshot) when the tab has
//   no active guard, preserving unrestricted browsing behavior.

// Reuse the repo's pure terminal-error classifiers (lib/browser-errors.js is a
// pure classification module: no I/O, no network) so terminal browser/state
// failures reach the server's recovery boundary unchanged.
import { isDeadContextError, isPageCrashedError, isTabDestroyedError } from './browser-errors.js';

export const GUARD_MAX_ENTRIES = 100;
export const GUARD_MAX_FAILED_ATTEMPTS = 2;

const GUARD_MODE = 'links-only';

// Bounds Playwright's selector lookup for guarded target inspection (its
// _withElement timeout); it does NOT bound execution of the synchronous
// static probe itself.
const GUARD_LOCATOR_LOOKUP_TIMEOUT_MS = 3000;

// Terminal browser/state failures that must be rethrown unchanged.
const TERMINAL_ERROR_CODES = new Set(['tab_timeout', 'page_crashed', 'tab_destroyed', 'session_expired']);

const ALLOWED_ACTION_LABELS = new Set(['click', 'scroll', 'viewport', 'observe', 'close', 'guard']);
const CLICK_KINDS = new Set(['selector', 'ref', 'coordinates']);

// One observer binding per (tabState, page); WeakMap keeps no strong refs.
const observerBoundPages = new WeakMap();

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/**
 * Build a navigation-guard error with a stable `code` and HTTP-ish
 * `statusCode`. The default 403 is "blocked by guard policy"; callers of the
 * guard surface 400 (invalid input), 409 (state conflict), and 422 (invalid
 * click target) explicitly.
 */
export function guardError(code, message, statusCode = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// ---------------------------------------------------------------------------
// Guard state helpers (private)
// ---------------------------------------------------------------------------

function isGuardActive(tabState) {
  return Boolean(tabState && tabState.navigationGuard && tabState.navigationGuard.mode === GUARD_MODE);
}

function activeGuard(tabState) {
  return isGuardActive(tabState) ? tabState.navigationGuard : null;
}

/** Canonicalize an absolute URL through the WHATWG URL parser; null if invalid. */
function canonicalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed).href;
  } catch {
    return null;
  }
}

function isHttpUrl(canonicalUrl) {
  try {
    const parsed = new URL(canonicalUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Read the tab's current URL as a canonical string. Returns null when the URL
 * cannot be read (closed page) -- callers must report unavailability instead
 * of fabricating a URL.
 */
function readCurrentUrl(tabState) {
  const page = tabState ? tabState.page : null;
  if (!page || typeof page.url !== 'function') return null;
  try {
    return canonicalizeUrl(page.url());
  } catch {
    return null;
  }
}

/** 'page' when origin/path/search changed; 'fragment' for hash-only changes. */
function classifyTransition(previousUrl, nextUrl) {
  try {
    const previous = new URL(previousUrl);
    const next = new URL(nextUrl);
    const sameDocument = previous.origin === next.origin
      && previous.pathname === next.pathname
      && previous.search === next.search;
    return sameDocument ? 'fragment' : 'page';
  } catch {
    return 'page';
  }
}

function pushBounded(list, value, limit, onDrop) {
  list.push(value);
  while (list.length > limit) {
    list.shift();
    if (typeof onDrop === 'function') onDrop();
  }
}

function createGuardState({ tabId, startUrl, startedAt, inheritedFromTabId = null }) {
  return {
    mode: GUARD_MODE,
    tabId,
    // Canonical ORIGINAL start URL. Preserved in memory for the lifetime of
    // the guard and never updated by navigation, so repeated starts compare
    // against the original even after the tab has moved on.
    startUrl,
    startedAt,
    lastUrl: startUrl,
    // Bumped only by noteGuardObservation (a fresh screenshot/snapshot), never
    // by status reads or cached pages, so it cannot be used to erase budget.
    observationVersion: 0,
    needsObservation: false,
    consecutiveFailures: 0,
    counters: {
      clickAttempts: 0,
      clickCompleted: 0,
      clickErrors: 0,
      noChangeObserved: 0,
      popupCount: 0,
      navigationTransitions: 0,
      pageTransitions: 0,
      fragmentTransitions: 0,
      droppedActions: 0,
      droppedNavigationEvents: 0,
      droppedPopupTabs: 0,
    },
    // Bounded ledgers; lifetime totals live in `counters` and are never
    // reconstructed from these truncated arrays.
    actions: [],
    navigationEvents: [],
    popupTabs: [],
    inheritedFromTabId: inheritedFromTabId || null,
    // Monotonic action ids, kept across ledger truncation.
    _nextActionId: 1,
  };
}

/**
 * Shared observation helper: record one URL observation against a guard.
 * A different canonical href records a transition ('page' or 'fragment'),
 * resets consecutiveFailures, clears needsObservation, and lands in the
 * bounded navigationEvents ledger. Repeated identical observations are no-ops.
 */
function recordObservedUrlForGuard(guard, rawUrl, at) {
  if (!guard || guard.mode !== GUARD_MODE) return null;
  const nextUrl = canonicalizeUrl(rawUrl);
  if (!nextUrl || nextUrl === guard.lastUrl) return null;
  const kind = classifyTransition(guard.lastUrl, nextUrl);
  guard.lastUrl = nextUrl;
  guard.consecutiveFailures = 0;
  guard.needsObservation = false;
  guard.counters.navigationTransitions += 1;
  if (kind === 'fragment') guard.counters.fragmentTransitions += 1;
  else guard.counters.pageTransitions += 1;
  pushBounded(
    guard.navigationEvents,
    { url: nextUrl, kind, at: Number.isFinite(at) ? at : Date.now() },
    GUARD_MAX_ENTRIES,
    () => { guard.counters.droppedNavigationEvents += 1; },
  );
  return { url: nextUrl, kind };
}

/**
 * Reconcile the live page URL into the guard. Used by the observer and by
 * begin/complete/observation calls so late navigation is captured even when
 * the observer did not see it.
 */
function reconcileCurrentUrl(tabState, at) {
  const guard = activeGuard(tabState);
  if (!guard) return null;
  const currentUrl = readCurrentUrl(tabState);
  if (!currentUrl) return null;
  return recordObservedUrlForGuard(guard, currentUrl, at);
}

/**
 * Public, serializable copy of a single action record. Strips every private
 * bookkeeping key (including the guard reference) and never exposes page or
 * guard objects.
 */
function publicActionCopy(entry) {
  const target = entry && entry.target && typeof entry.target === 'object'
    ? {
      href: typeof entry.target.href === 'string' ? entry.target.href : null,
      text: typeof entry.target.text === 'string' ? entry.target.text : '',
    }
    : null;
  return {
    id: typeof entry.id === 'number' ? entry.id : null,
    tabId: entry.tabId ?? null,
    kind: entry.kind ?? null,
    startedAt: entry.startedAt ?? null,
    fromUrl: entry.fromUrl ?? null,
    status: entry.status ?? null,
    dispatchRequested: entry.dispatchRequested === true,
    target,
    completedAt: entry.completedAt ?? null,
    durationMs: entry.durationMs ?? null,
    toUrl: entry.toUrl ?? null,
    errorCode: entry.errorCode ?? null,
    outcome: entry.outcome ?? null,
    navigationObserved: entry.navigationObserved === true,
  };
}

// Stable error codes are bounded identifiers; bare strings and malformed or
// oversized codes collapse to 'unknown_error'. Messages and selectors are
// never retained.
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Extract a bounded stable code from an arbitrary thrown value; never stores messages. */
function errorCodeOf(error) {
  if (!error) return null;
  if (typeof error === 'object' && typeof error.code === 'string' && ERROR_CODE_RE.test(error.code)) {
    return error.code;
  }
  return 'unknown_error';
}

/**
 * Terminal browser/state failures (timeout, crashed page, destroyed tab,
 * closed context/session) are rethrown unchanged so the server's recovery
 * boundary sees them; they are not target problems and must not prompt a
 * target retry.
 */
function isTerminalBrowserError(error) {
  if (!error) return false;
  if (typeof error === 'object' && typeof error.code === 'string' && TERMINAL_ERROR_CODES.has(error.code)) return true;
  return isDeadContextError(error) || isPageCrashedError(error) || isTabDestroyedError(error);
}

// ---------------------------------------------------------------------------
// Static in-page probes. These functions are serialized and executed inside
// the page by Playwright, so they must be fully self-contained (no module
// scope references) and strictly read-only.
// ---------------------------------------------------------------------------

/** Probe: validate that a located element is a visible native http(s) link. */
function guardedLocatorProbe(element) {
  function resolveAnchor(el) {
    if (!el || typeof el.closest !== 'function') return { ok: false, reason: 'not_anchor' };
    const anchor = el.closest('a[href]');
    if (!anchor) return { ok: false, reason: 'not_anchor' };
    if (anchor.hasAttribute('download')) return { ok: false, reason: 'download' };

    let resolved;
    try {
      const href = anchor.href;
      if (typeof href !== 'string' || href.length === 0) return { ok: false, reason: 'invalid_href' };
      resolved = new URL(href);
    } catch {
      return { ok: false, reason: 'invalid_href' };
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return { ok: false, reason: 'unsafe_scheme', scheme: resolved.protocol };
    }

    let visible = false;
    try {
      const rect = anchor.getBoundingClientRect();
      const style = window.getComputedStyle(anchor);
      const opacity = style.opacity === '' ? 1 : parseFloat(style.opacity);
      visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && rect.width > 0
        && rect.height > 0
        && (Number.isNaN(opacity) || opacity > 0);
      if (visible && typeof anchor.checkVisibility === 'function') {
        try {
          visible = anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        } catch {
          // Keep the rect/style result when checkVisibility is unsupported.
        }
      }
    } catch {
      visible = false;
    }
    if (!visible) return { ok: false, reason: 'not_visible' };

    const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { ok: true, href: resolved.href, text };
  }
  return resolveAnchor(element);
}

/** Probe: validate that a viewport point resolves to a visible native link. */
function guardedPointProbe(point) {
  if (!point || typeof point !== 'object') return { ok: false, reason: 'invalid_point' };
  const x = point.x;
  const y = point.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
    return { ok: false, reason: 'invalid_point' };
  }
  const element = document.elementFromPoint(x, y);
  if (!element) return { ok: false, reason: 'no_element' };
  const tagName = element.tagName ? String(element.tagName).toUpperCase() : '';
  if (tagName === 'IFRAME' || tagName === 'FRAME') return { ok: false, reason: 'iframe' };

  function resolveAnchor(el) {
    if (!el || typeof el.closest !== 'function') return { ok: false, reason: 'not_anchor' };
    const anchor = el.closest('a[href]');
    if (!anchor) return { ok: false, reason: 'not_anchor' };
    if (anchor.hasAttribute('download')) return { ok: false, reason: 'download' };

    let resolved;
    try {
      const href = anchor.href;
      if (typeof href !== 'string' || href.length === 0) return { ok: false, reason: 'invalid_href' };
      resolved = new URL(href);
    } catch {
      return { ok: false, reason: 'invalid_href' };
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return { ok: false, reason: 'unsafe_scheme', scheme: resolved.protocol };
    }

    let visible = false;
    try {
      const rect = anchor.getBoundingClientRect();
      const style = window.getComputedStyle(anchor);
      const opacity = style.opacity === '' ? 1 : parseFloat(style.opacity);
      visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && rect.width > 0
        && rect.height > 0
        && (Number.isNaN(opacity) || opacity > 0);
      if (visible && typeof anchor.checkVisibility === 'function') {
        try {
          visible = anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        } catch {
          // Keep the rect/style result when checkVisibility is unsupported.
        }
      }
    } catch {
      visible = false;
    }
    if (!visible) return { ok: false, reason: 'not_visible' };

    const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { ok: true, href: resolved.href, text };
  }
  return resolveAnchor(element);
}

/**
 * Map a probe result to {href,text} or a guard_invalid_target error. Messages
 * carry no selector strings and always point at a fresh observation path.
 */
function interpretAnchorProbe(probe, source) {
  if (probe && probe.ok === true && typeof probe.href === 'string' && probe.href.length > 0) {
    return { href: probe.href, text: typeof probe.text === 'string' ? probe.text : '' };
  }
  const reason = probe && typeof probe.reason === 'string' ? probe.reason : 'unknown';
  const guidance = source === 'coordinates'
    ? 'Take a fresh screenshot/snapshot and choose a point over a visible hyperlink; the guard will not scroll, guess, or click through.'
    : 'Take a fresh snapshot and target a visible hyperlink ref (or :visible locator); the guard will not auto-select nth matches or rewrite selectors.';
  switch (reason) {
    case 'not_anchor':
      throw guardError('guard_invalid_target', 'Target is not a native hyperlink (no visible a[href]). ' + guidance, 422);
    case 'download':
      throw guardError('guard_invalid_target', 'Target has an explicit download attribute; downloads are not allowed in links-only mode. ' + guidance, 422);
    case 'unsafe_scheme': {
      const scheme = probe && typeof probe.scheme === 'string' && probe.scheme.length > 0 ? probe.scheme : 'non-http(s)';
      throw guardError('guard_invalid_target', 'Target link uses an unsupported scheme (' + scheme + '); only http(s) hyperlinks are allowed. ' + guidance, 422);
    }
    case 'invalid_href':
      throw guardError('guard_invalid_target', 'Target link has no resolvable http(s) href. ' + guidance, 422);
    case 'not_visible':
      throw guardError('guard_invalid_target', 'Target hyperlink is not currently visible. ' + guidance, 422);
    case 'no_element':
      throw guardError('guard_invalid_target', 'No actionable element at that point (outside the viewport or empty). ' + guidance, 422);
    case 'iframe':
      throw guardError('guard_invalid_target', 'That point resolves to an iframe; cross-frame targets are not allowed in links-only mode. ' + guidance, 422);
    case 'invalid_point':
      throw guardError('guard_invalid_target', 'Coordinates must be finite viewport pixels. ' + guidance, 422);
    default:
      throw guardError('guard_invalid_target', 'Target could not be validated as a visible http(s) hyperlink. ' + guidance, 422);
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Start the one-way links-only guard on an inactive tab.
 *
 * `expectedUrl` must be a nonempty canonicalizable http(s) URL that matches
 * the current page URL as a full canonical URL (not merely the path). Invalid
 * input throws navigation_guard_violation (400). While a guard is active,
 * restarting with the ORIGINAL start URL is idempotent and never resets
 * history or budget -- even after navigation; any other expectedUrl throws
 * guard_start_mismatch (409).
 *
 * Returns snapshotNavigationGuard(tabState).
 */
export function enableNavigationGuard(tabState, options = {}) {
  const { tabId, expectedUrl, now = Date.now() } = options || {};
  const canonicalExpected = canonicalizeUrl(expectedUrl);
  if (!canonicalExpected) {
    throw guardError('navigation_guard_violation', 'expectedUrl must be a nonempty absolute URL string that can be canonicalized.', 400);
  }

  const existing = activeGuard(tabState);
  if (existing) {
    if (canonicalExpected === existing.startUrl) return snapshotNavigationGuard(tabState);
    throw guardError('guard_start_mismatch', 'A navigation guard is already active for this tab; it is one-way and can only be re-started with its original start URL.', 409);
  }

  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    throw guardError('navigation_guard_violation', 'tabId is required to start a navigation guard.', 400);
  }
  if (!isHttpUrl(canonicalExpected)) {
    throw guardError('navigation_guard_violation', 'expectedUrl must be an http(s) URL.', 400);
  }
  const currentUrl = readCurrentUrl(tabState);
  if (!currentUrl) {
    throw guardError('navigation_guard_violation', 'The current page URL is unavailable, so expectedUrl cannot be verified. Ensure the tab is open, then start the guard.', 409);
  }
  if (currentUrl !== canonicalExpected) {
    throw guardError('navigation_guard_violation', 'expectedUrl does not match the current page URL (canonical full-URL comparison, not just the path).', 400);
  }

  const startedAt = Number.isFinite(now) ? now : Date.now();
  tabState.navigationGuard = createGuardState({ tabId, startUrl: canonicalExpected, startedAt });
  return snapshotNavigationGuard(tabState);
}

/**
 * Route-boundary gate. Inactive tabs are untouched. While active, only native
 * interaction labels are permitted; anything else (e.g. evaluate) throws
 * navigation_guard_violation with the replacement path spelled out. This does
 * not execute page code and does not log the caller's input.
 */
export function assertNavigationActionAllowed(tabState, action) {
  if (!isGuardActive(tabState)) return;
  if (typeof action === 'string' && ALLOWED_ACTION_LABELS.has(action)) return;
  throw guardError(
    'navigation_guard_violation',
    'Blocked by the links-only navigation guard. Only native hyperlink clicks, scrolling, viewport changes, screenshot/snapshot observation, closing, and guard status are allowed; caller-supplied JavaScript is disabled. Use screenshots/snapshots and native hyperlink clicks instead.',
    403,
  );
}

/**
 * Attach the main-frame navigation observer for this tab state.
 *
 * Idempotent per (tabState, page); safe to call before the guard is active --
 * the listener records only while a guard is active, so unrestricted tabs are
 * unaffected. It ignores child frames, never throws, and uses no timers.
 * After a transfer, the old state's listener is inert because its guard was
 * cleared, and the target state's listener records the moved guard.
 */
export function bindNavigationGuardObserver(tabState) {
  if (!tabState || typeof tabState !== 'object') return;
  const page = tabState.page;
  if (!page || typeof page.on !== 'function') return;
  if (observerBoundPages.get(tabState) === page) return;

  page.on('framenavigated', (frame) => {
    try {
      if (!isGuardActive(tabState)) return;
      // Keep a replaced page (e.g. proxy rotation) from writing into the
      // surviving tab state's guard.
      if (tabState.page !== page) return;
      let mainFrame;
      try {
        mainFrame = page.mainFrame();
      } catch {
        return;
      }
      if (frame !== mainFrame) return;
      let rawUrl = null;
      try {
        rawUrl = typeof frame.url === 'function' ? frame.url() : page.url();
      } catch {
        rawUrl = null;
      }
      if (!rawUrl) return;
      recordObservedUrlForGuard(activeGuard(tabState), rawUrl, Date.now());
    } catch {
      // Event listeners must never throw into Playwright.
    }
  });
  observerBoundPages.set(tabState, page);
}

/**
 * Register a fresh observation (successful screenshot or non-paginated
 * snapshot ONLY -- never cached offset pages or status reads). Reconciles the
 * live URL, bumps observationVersion, and clears needsObservation. It does NOT
 * reset consecutiveFailures absent a URL change, so repeated screenshots can
 * never erase the failure budget.
 */
export function noteGuardObservation(tabState) {
  const guard = activeGuard(tabState);
  if (!guard) return;
  reconcileCurrentUrl(tabState, Date.now());
  guard.observationVersion += 1;
  guard.needsObservation = false;
}

/**
 * Open a new action record for one guarded click attempt. Inactive tabs
 * return null. The returned entry is returned even when recovery is blocked;
 * the caller next invokes assertGuardedClickReady, assigns entry.target from
 * inspectGuardedLocator/inspectGuardedCoordinates, and sets
 * entry.dispatchRequested = true immediately before the single native click.
 *
 * The entry carries private bookkeeping (_observationVersionAtStart,
 * _popupCountAtStart, _pageTransitionsAtStart, _fragmentTransitionsAtStart,
 * _guard) that is stripped from all public snapshots.
 */
export function beginGuardedClick(tabState, options = {}) {
  const guard = activeGuard(tabState);
  if (!guard) return null;
  const { kind, now = Date.now() } = options || {};
  const startedAt = Number.isFinite(now) ? now : Date.now();
  reconcileCurrentUrl(tabState, startedAt);
  const normalizedKind = typeof kind === 'string' && CLICK_KINDS.has(kind) ? kind : 'unknown';
  const entry = {
    id: guard._nextActionId,
    tabId: guard.tabId,
    kind: normalizedKind,
    startedAt,
    fromUrl: guard.lastUrl,
    status: 'pending',
    dispatchRequested: false,
    target: null,
    completedAt: null,
    durationMs: null,
    toUrl: null,
    errorCode: null,
    outcome: null,
    navigationObserved: false,
    _observationVersionAtStart: guard.observationVersion,
    _popupCountAtStart: guard.counters.popupCount,
    _pageTransitionsAtStart: guard.counters.pageTransitions,
    _fragmentTransitionsAtStart: guard.counters.fragmentTransitions,
    _guard: guard,
  };
  guard._nextActionId += 1;
  guard.counters.clickAttempts += 1;
  pushBounded(guard.actions, entry, GUARD_MAX_ENTRIES, () => {
    guard.counters.droppedActions += 1;
  });
  return entry;
}

/**
 * Freshness/budget gate to call after beginGuardedClick and before input.
 * Throws guard_retry_exhausted when two consecutive failed/no-change attempts
 * have hit an unchanged URL (stop the task; there is no reset API), otherwise
 * guard_observation_required when a fresh observation is needed. Never
 * increments the budget itself.
 */
export function assertGuardedClickReady(tabState) {
  const guard = activeGuard(tabState);
  if (!guard) return;
  if (guard.consecutiveFailures >= GUARD_MAX_FAILED_ATTEMPTS) {
    throw guardError(
      'guard_retry_exhausted',
      'Navigation guard retry budget exhausted: ' + GUARD_MAX_FAILED_ATTEMPTS + ' consecutive failed or no-change click attempts on an unchanged URL. Stop this task; there is no reset API.',
      409,
    );
  }
  if (guard.needsObservation) {
    throw guardError(
      'guard_observation_required',
      'Navigation guard requires a fresh observation before the next click. Take a fresh screenshot or a non-paginated snapshot, re-read a visible hyperlink target, then retry once with a corrected target.',
      409,
    );
  }
}

/**
 * Validate a locator as a single visible native http(s) hyperlink.
 *
 * count()/isVisible() inspect the CURRENT state only and do not wait for
 * actionability; the caller's single normal click does that. Zero/multiple
 * matches and hidden targets throw guard_invalid_target with fresh
 * snapshot/ref/:visible guidance. No nth auto-selection, no selector
 * rewriting. Terminal browser/state errors are rethrown unchanged; only
 * ordinary target parse/detachment errors become guard_invalid_target.
 * Returns {href,text} with the canonical resolved href and anchor text capped
 * at 120 chars.
 */
export async function inspectGuardedLocator(locator) {
  if (!locator || typeof locator.count !== 'function') {
    throw guardError('guard_invalid_target', 'Locator could not be inspected. Take a fresh snapshot and target a visible hyperlink ref.', 422);
  }
  let count;
  try {
    count = await locator.count();
  } catch (error) {
    if (isTerminalBrowserError(error)) throw error;
    throw guardError('guard_invalid_target', 'Locator could not be inspected (it may be detached or malformed). Take a fresh snapshot and target a visible hyperlink ref; the guard will not rewrite selectors.', 422);
  }
  if (count === 0) {
    throw guardError('guard_invalid_target', 'Locator matched no elements. Take a fresh snapshot and target a visible hyperlink ref (or a :visible locator); the guard will not auto-select or rewrite selectors.', 422);
  }
  if (count !== 1) {
    throw guardError('guard_invalid_target', 'Locator matched ' + count + ' elements. Take a fresh snapshot and target exactly one visible hyperlink ref; the guard will not auto-select an nth match.', 422);
  }
  let visible;
  try {
    visible = await locator.isVisible();
  } catch (error) {
    if (isTerminalBrowserError(error)) throw error;
    visible = false;
  }
  if (!visible) {
    throw guardError('guard_invalid_target', 'Matched element is not visible. Take a fresh snapshot and target a visible hyperlink ref (:visible); the guard will not click hidden elements.', 422);
  }
  let probe;
  try {
    // The timeout bounds Playwright's selector lookup (_withElement), not the
    // synchronous static probe execution itself.
    probe = await locator.evaluate(guardedLocatorProbe, undefined, { timeout: GUARD_LOCATOR_LOOKUP_TIMEOUT_MS });
  } catch (error) {
    if (isTerminalBrowserError(error)) throw error;
    throw guardError('guard_invalid_target', 'Matched element could not be inspected as a hyperlink. Take a fresh snapshot and retry with a visible hyperlink ref.', 422);
  }
  return interpretAnchorProbe(probe, 'locator');
}

/**
 * Validate that a mapped CSS viewport point resolves to a single visible
 * native http(s) hyperlink, using exactly ONE page.evaluate with a static
 * function. Rejects iframes, non-links, unsafe schemes, downloads, and
 * unactionable points as guard_invalid_target. The caller runs the existing
 * captureId/freshness validation first; this helper does not screenshot,
 * scroll, or input. Terminal browser/state errors are rethrown unchanged.
 */
export async function inspectGuardedCoordinates(page, x, y) {
  if (!page || typeof page.evaluate !== 'function') {
    throw guardError('guard_invalid_target', 'Page is unavailable; cannot validate coordinates. Take a fresh screenshot.', 422);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw guardError('guard_invalid_target', 'Coordinates must be finite viewport pixels. Take a fresh screenshot and retry.', 422);
  }
  let probe;
  try {
    probe = await page.evaluate(guardedPointProbe, { x, y });
  } catch (error) {
    if (isTerminalBrowserError(error)) throw error;
    throw guardError('guard_invalid_target', 'Coordinates could not be inspected on the page. Take a fresh screenshot and retry.', 422);
  }
  return interpretAnchorProbe(probe, 'coordinates');
}

/**
 * Finalize one action and return its public receipt (null entry no-op returns
 * null; already-final entries are idempotent). The guard that opened the entry
 * owns its completion: a transferred/replaced state's page and any newer guard
 * are ignored, so stale completions never charge the wrong guard. Status and
 * observed outcome are independent: a thrown click error may still have
 * navigated, and observations are never claimed as caused by the input.
 *
 * URL progress is derived from monotonic page/fragment transition counters
 * since the entry began (never from possibly-truncated arrays) as well as the
 * final URL difference, so a round trip (A->B->A) still reports page_changed.
 * Page progress outranks fragment, then popup, then no-change/unavailable.
 * Progress clears needsObservation and resets consecutiveFailures; a completed
 * or errored action with no observed progress consumes one consecutiveFailure
 * and requires a fresh observation unless observationVersion advanced after
 * the entry began. Pure readiness denials (guard_observation_required /
 * guard_retry_exhausted) never consume budget. Late navigation/popups are
 * captured later -- absence of observed change now is not proof of a permanent
 * no-op.
 */
export function completeGuardedClick(tabState, entry, options = {}) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.status !== 'pending') return publicActionCopy(entry);

  const { error = null, now = Date.now() } = options || {};
  const at = Number.isFinite(now) ? now : Date.now();

  // The entry's original guard is authoritative. A provided state holding a
  // different guard (or none) is a replacement/restart: ignore its page and
  // its guard entirely. Entries without a private owner (none produced by
  // beginGuardedClick) fall back to the active state for safety.
  const ownerGuard = entry._guard && entry._guard.mode === GUARD_MODE ? entry._guard : null;
  const stateGuard = activeGuard(tabState);
  const guard = ownerGuard || stateGuard;
  const ownsState = ownerGuard ? stateGuard === ownerGuard : true;

  let liveUrl = null;
  if (ownsState) {
    liveUrl = readCurrentUrl(tabState);
    if (guard && liveUrl) recordObservedUrlForGuard(guard, liveUrl, at);
  }

  const referenceUrl = liveUrl !== null ? liveUrl : (guard ? guard.lastUrl : null);
  const urlDiffers = referenceUrl !== null && referenceUrl !== entry.fromUrl;
  const urlTransitionKind = urlDiffers ? classifyTransition(entry.fromUrl, referenceUrl) : null;

  const pageStart = Number.isFinite(entry._pageTransitionsAtStart)
    ? entry._pageTransitionsAtStart
    : (guard ? guard.counters.pageTransitions : 0);
  const fragmentStart = Number.isFinite(entry._fragmentTransitionsAtStart)
    ? entry._fragmentTransitionsAtStart
    : (guard ? guard.counters.fragmentTransitions : 0);
  const pageProgress = Boolean(guard && guard.counters.pageTransitions > pageStart) || urlTransitionKind === 'page';
  const fragmentProgress = Boolean(guard && guard.counters.fragmentTransitions > fragmentStart) || urlTransitionKind === 'fragment';
  const navigationObserved = pageProgress || fragmentProgress;

  const popupStart = Number.isFinite(entry._popupCountAtStart)
    ? entry._popupCountAtStart
    : (guard ? guard.counters.popupCount : 0);
  const popupProgress = Boolean(guard && guard.counters.popupCount > popupStart);
  const progress = navigationObserved || popupProgress;

  let outcome;
  if (pageProgress) outcome = 'page_changed';
  else if (fragmentProgress) outcome = 'fragment_changed';
  else if (popupProgress) outcome = 'popup_observed';
  else if (liveUrl === null) outcome = 'unavailable';
  else outcome = 'no_change_observed';

  const code = errorCodeOf(error);
  const readinessDenial = code === 'guard_observation_required' || code === 'guard_retry_exhausted';

  entry.completedAt = at;
  entry.durationMs = Math.max(0, at - (Number.isFinite(entry.startedAt) ? entry.startedAt : at));
  entry.status = error ? 'error' : 'completed';
  entry.errorCode = error ? (code || 'unknown_error') : null;
  entry.toUrl = referenceUrl;
  entry.outcome = outcome;
  entry.navigationObserved = navigationObserved;

  if (guard) {
    if (progress) {
      guard.consecutiveFailures = 0;
      guard.needsObservation = false;
    } else if (!readinessDenial) {
      guard.consecutiveFailures += 1;
      const versionAdvanced = Number.isFinite(entry._observationVersionAtStart)
        && guard.observationVersion > entry._observationVersionAtStart;
      if (!versionAdvanced) guard.needsObservation = true;
    }
    if (entry.status === 'completed') guard.counters.clickCompleted += 1;
    else guard.counters.clickErrors += 1;
    if (outcome === 'no_change_observed') guard.counters.noChangeObserved += 1;
  }

  return publicActionCopy(entry);
}

/**
 * Move the SAME guard object to a replacement tab state (e.g. page
 * replacement). No new guard and no ledger/budget reset; the old state stops
 * recording because its navigationGuard is cleared, and the replacement page
 * URL is reconciled into the moved guard. Inactive source is a no-op.
 * Observers stay attached per state (see bindNavigationGuardObserver).
 */
export function transferNavigationGuard(sourceState, targetState) {
  const guard = activeGuard(sourceState);
  if (!guard) return snapshotNavigationGuard(targetState);
  if (!targetState || typeof targetState !== 'object') {
    throw guardError('navigation_guard_violation', 'targetState must be a tab state object.', 400);
  }
  if (targetState === sourceState) return snapshotNavigationGuard(sourceState);
  const existingTarget = activeGuard(targetState);
  if (existingTarget && existingTarget !== guard) {
    throw guardError('navigation_guard_violation', 'targetState already has an active navigation guard; refusing to overwrite it.', 409);
  }

  sourceState.navigationGuard = null;
  targetState.navigationGuard = guard;
  const replacementUrl = readCurrentUrl(targetState);
  if (replacementUrl) recordObservedUrlForGuard(guard, replacementUrl, Date.now());
  return snapshotNavigationGuard(targetState);
}

/**
 * Give a browser-created popup (child) its own independent active guard under
 * the same links-only policy, inheriting the parent tab id for attribution.
 * The child gets its own startUrl (child page.url(), about:blank allowed only
 * here for a fresh popup), budget, counters, and ledgers -- nothing is merged
 * and the parent's URL is not faked. The parent records a bounded popup entry
 * and a monotonic popupCount (used by receipts).
 *
 * This method never creates or authorizes tabs and makes no ownership
 * decisions; callers own tab ownership/auth. Popups observed before they
 * navigate later update through the child's observer
 * (bindNavigationGuardObserver). A NEW child resets the parent's failure
 * budget and observation requirement (observed progress); the idempotent
 * existing-child path does not. Inactive parent is a no-op.
 */
export function inheritNavigationGuard(parentState, childState, options = {}) {
  const parentGuard = activeGuard(parentState);
  if (!parentGuard) return snapshotNavigationGuard(childState);
  if (!childState || typeof childState !== 'object') {
    throw guardError('navigation_guard_violation', 'childState must be a tab state object.', 400);
  }
  if (activeGuard(childState)) return snapshotNavigationGuard(childState);
  const { tabId, now = Date.now() } = options || {};
  if (typeof tabId !== 'string' || tabId.trim().length === 0) {
    throw guardError('navigation_guard_violation', 'tabId is required to inherit a navigation guard.', 400);
  }

  const startedAt = Number.isFinite(now) ? now : Date.now();
  const childUrl = readCurrentUrl(childState);
  const startUrl = childUrl || 'about:blank';
  childState.navigationGuard = createGuardState({
    tabId,
    startUrl,
    startedAt,
    inheritedFromTabId: parentGuard.tabId,
  });

  parentGuard.counters.popupCount += 1;
  pushBounded(parentGuard.popupTabs, { tabId, url: startUrl, at: startedAt }, GUARD_MAX_ENTRIES, () => {
    parentGuard.counters.droppedPopupTabs += 1;
  });
  // A new popup is observed progress for the parent, even when it arrives
  // after the originating click was already finalized: clear the parent's
  // failure budget and observation requirement. Receipts already returned are
  // not rewritten; future snapshots show the popup and the progress.
  parentGuard.consecutiveFailures = 0;
  parentGuard.needsObservation = false;
  return snapshotNavigationGuard(childState);
}

/**
 * Owner-facing, in-memory snapshot. Inactive tabs report
 * {mode:'unrestricted'}. Active snapshots are serializable deep copies with
 * bounded arrays (last 100), lifetime counters, truncation/dropped totals,
 * and optional inheritedFromTabId. This is NOT an observation: it never bumps
 * observationVersion, clears needsObservation, or resets failures. Private
 * entry bookkeeping and page/guard references are stripped.
 */
export function snapshotNavigationGuard(tabState) {
  const guard = activeGuard(tabState);
  if (!guard) return { mode: 'unrestricted' };
  const snapshot = {
    mode: guard.mode,
    tabId: guard.tabId,
    startUrl: guard.startUrl,
    startedAt: guard.startedAt,
    currentUrl: guard.lastUrl,
    needsObservation: guard.needsObservation === true,
    consecutiveFailures: guard.consecutiveFailures,
    retryLimit: GUARD_MAX_FAILED_ATTEMPTS,
    counters: { ...guard.counters },
    actions: guard.actions.map(publicActionCopy),
    navigationEvents: guard.navigationEvents.map((event) => ({ url: event.url, kind: event.kind, at: event.at })),
    popupTabs: guard.popupTabs.map((popup) => ({ tabId: popup.tabId, url: popup.url, at: popup.at })),
    truncated: {
      actions: guard.counters.droppedActions > 0,
      navigationEvents: guard.counters.droppedNavigationEvents > 0,
      popupTabs: guard.counters.droppedPopupTabs > 0,
    },
    dropped: {
      actions: guard.counters.droppedActions,
      navigationEvents: guard.counters.droppedNavigationEvents,
      popupTabs: guard.counters.droppedPopupTabs,
    },
  };
  if (guard.inheritedFromTabId) snapshot.inheritedFromTabId = guard.inheritedFromTabId;
  return snapshot;
}
