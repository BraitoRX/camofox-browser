// Humanized native mouse gestures (press-and-hold) for the shared browser.
//
// WHAT THIS IS
//   `humanizedHold` dispatches a trusted native mouse press at a target point,
//   keeps the button pressed for `durationMs`, and releases it. With
//   `humanize: true` it approaches the target in short jittered segments and
//   emits tiny pointer micro-movements while pressed, so the input stream is
//   not a single perfectly straight move followed by a perfectly still hold.
//
// WHY
//   "Press and hold" human-verification widgets (e.g. PerimeterX captchas)
//   require a sustained primary-button press; a normal click is not enough.
//
// SAFETY
//   The button is always released: the press is wrapped in try/finally, so a
//   rejected mouse call (or a caller-side timeout) cannot leave the pointer
//   stuck down once the underlying promise settles. This module performs no
//   I/O of its own and never touches page content.

/** Default hold duration (ms). */
export const HOLD_DEFAULT_MS = 3000;
/** Minimum accepted hold duration (ms). */
export const HOLD_MIN_MS = 100;
/** Maximum accepted hold duration (ms). */
export const HOLD_MAX_MS = 20000;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.round(rand(min, max));
}

/**
 * Move the native pointer to (x, y) in a short humanized approach:
 * a jittered waypoint near the target first, then the exact point.
 */
async function humanizedApproach(page, x, y) {
  const waypointX = x + rand(-20, 20);
  const waypointY = y + rand(-12, 12);
  await page.mouse.move(waypointX, waypointY, { steps: randInt(3, 6) });
  await page.waitForTimeout(randInt(20, 60));
  await page.mouse.move(x, y, { steps: randInt(1, 3) });
  await page.waitForTimeout(randInt(20, 60));
}

/**
 * Press at (x, y), hold for `durationMs`, then release.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ x: number, y: number, durationMs?: number, humanize?: boolean }} options
 * @returns {Promise<{ heldMs: number }>}
 */
export async function humanizedHold(page, { x, y, durationMs = HOLD_DEFAULT_MS, humanize = true } = {}) {
  const holdMs = Math.max(HOLD_MIN_MS, Math.min(HOLD_MAX_MS, Math.round(durationMs)));
  if (humanize) {
    await humanizedApproach(page, x, y);
  } else {
    await page.mouse.move(x, y);
  }

  const downAt = Date.now();
  let pressed = false;
  try {
    await page.mouse.down();
    pressed = true;
    // Let the press settle before any micro-movement (as a human would).
    await page.waitForTimeout(humanize ? randInt(60, 140) : 0);
    // The browser itself humanizes input (Camoufox `humanize: true`), so keep
    // the extra tremor sparse: a bounded handful of tiny moves spread across
    // the hold. Dense micro-moves multiply wall time on this pipeline.
    const maxMicroMoves = Math.max(2, Math.min(6, Math.round(holdMs / 3000)));
    let microMoves = 0;
    let remaining = holdMs - (Date.now() - downAt);
    while (remaining > 0) {
      const chunk = Math.min(remaining, humanize ? randInt(500, 1100) : remaining);
      await page.waitForTimeout(chunk);
      remaining = holdMs - (Date.now() - downAt);
      if (humanize && remaining > 0 && microMoves < maxMicroMoves && Math.random() < 0.4) {
        microMoves++;
        await page.mouse.move(x + rand(-1, 1), y + rand(-1, 1));
      }
    }
  } finally {
    if (pressed) {
      await page.mouse.up();
    }
  }
  return { heldMs: Date.now() - downAt };
}

/**
 * Drag from one point to another with a trusted native mouse: press at the
 * source, move along a jittered multi-segment path, optionally dwell over the
 * drop point, then release. The button is always released (try/finally).
 *
 * @param {import('playwright-core').Page} page
 * @param {{ fromX: number, fromY: number, toX: number, toY: number, steps?: number, holdBeforeDropMs?: number, humanize?: boolean }} options
 * @returns {Promise<{ dragMs: number, steps: number }>}
 */
export async function humanizedDrag(page, { fromX, fromY, toX, toY, steps, holdBeforeDropMs, humanize = true } = {}) {
  const moveSteps = Number.isFinite(steps) && steps > 0 ? Math.max(1, Math.round(steps)) : (humanize ? randInt(16, 28) : 1);
  const dwellMs = Number.isFinite(holdBeforeDropMs) ? Math.max(0, Math.round(holdBeforeDropMs)) : (humanize ? randInt(80, 250) : 0);

  if (humanize) {
    await humanizedApproach(page, fromX, fromY);
  } else {
    await page.mouse.move(fromX, fromY);
  }

  const downAt = Date.now();
  let pressed = false;
  try {
    await page.mouse.down();
    pressed = true;
    await page.waitForTimeout(humanize ? randInt(40, 120) : 0);
    // Move in a few jittered segments; the browser's own humanization
    // (Camoufox) stretches each dispatch, so keep the segment count modest.
    // Denser waypoints with only ±1.5px of lateral jitter keep the pointer
    // close to the straight line so the drop point is not blurred by wander.
    const segments = humanize ? Math.min(12, Math.max(2, Math.round(moveSteps / 4))) : 1;
    const perSegment = Math.max(1, Math.ceil(moveSteps / segments));
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const jx = humanize ? rand(-1.5, 1.5) : 0;
      const jy = humanize ? rand(-1.5, 1.5) : 0;
      await page.mouse.move(fromX + (toX - fromX) * t + jx, fromY + (toY - fromY) * t + jy, { steps: perSegment });
      if (humanize) await page.waitForTimeout(randInt(15, 45));
    }
    await page.mouse.move(toX, toY, { steps: perSegment });
    // Re-assert the exact drop point with a single un-jittered move so the last
    // position the page observes is precisely the resolved target point.
    await page.mouse.move(toX, toY);
    if (dwellMs > 0) {
      await page.waitForTimeout(dwellMs);
    }
  } finally {
    if (pressed) {
      await page.mouse.up();
    }
  }
  return { dragMs: Date.now() - downAt, steps: moveSteps };
}

/**
 * Move the native pointer to (x, y) with an optional humanized approach and
 * dwell there (hover menus/tooltips).
 *
 * @param {import('playwright-core').Page} page
 * @param {{ x: number, y: number, humanize?: boolean, settleMs?: number }} options
 * @returns {Promise<{ settledMs: number }>}
 */
export async function humanizedHover(page, { x, y, humanize = true, settleMs = 300 } = {}) {
  if (humanize) {
    await humanizedApproach(page, x, y);
  } else {
    await page.mouse.move(x, y);
  }
  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }
  return { settledMs: settleMs };
}
