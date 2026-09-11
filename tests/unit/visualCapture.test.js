/**
 * Unit tests for screenshot-coordinate capture state (lib/visual-capture.js).
 *
 * Deterministic and browser-free: a fake page object supplies mutable layout
 * metrics, a real in-memory PNG (pngjs), and captured event listeners. These
 * tests pin the state contract the REST routes rely on: exact metadata keys,
 * latest-capture-only semantics, image-pixel -> CSS mapping, and the
 * 400 invalid_coordinates / 409 stale_visual_capture split.
 */

import { PNG } from 'pngjs';

import {
  VISUAL_CAPTURE_MAX_AGE_MS,
  bindVisualCaptureInvalidation,
  captureVisualState,
  resolveCoordinatesToCss,
} from '../../lib/visual-capture.js';

const METADATA_KEYS = [
  'captureId',
  'imageWidth',
  'imageHeight',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'scrollX',
  'scrollY',
  'url',
  'capturedAt',
];

// A real, decodable PNG so IHDR dimension parsing is exercised for real.
function makePng(width, height) {
  return PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, 255) });
}

const DEFAULT_METRICS = {
  viewportWidth: 160,
  viewportHeight: 120,
  devicePixelRatio: 2,
  scrollX: 0,
  scrollY: 0,
};

function makePage({ metrics = {}, url = 'https://example.test/page', screenshot } = {}) {
  const state = {
    metrics: { ...DEFAULT_METRICS, ...metrics },
    url,
    screenshot,
    screenshotCalls: [],
    listeners: new Map(),
    mainFrame: { name: 'main-frame' },
  };
  const page = {
    evaluate: async () => ({ ...state.metrics }),
    url: () => state.url,
    screenshot: async (options) => {
      state.screenshotCalls.push(options);
      if (typeof state.screenshot === 'function') return state.screenshot(options);
      return state.screenshot;
    },
    mainFrame: () => state.mainFrame,
    on: (event, listener) => { state.listeners.set(event, listener); },
  };
  return { page, state };
}

async function captureOn(page) {
  const tabState = { page };
  const result = await captureVisualState(tabState);
  return { tabState, result };
}

async function expectInvalidCoordinates(coordinates, tabState = { visualCapture: null }) {
  await expect(resolveCoordinatesToCss(tabState, coordinates)).rejects.toMatchObject({
    statusCode: 400,
    code: 'invalid_coordinates',
  });
}

async function expectStale(coordinates, tabState) {
  await expect(resolveCoordinatesToCss(tabState, coordinates)).rejects.toMatchObject({
    statusCode: 409,
    code: 'stale_visual_capture',
  });
}

describe('captureVisualState', () => {
  test('captures a device-scale viewport PNG and stores the exact metadata contract', async () => {
    const png = makePng(320, 240);
    const { page, state } = makePage({ screenshot: png });
    const tabState = { page, visualCapture: { captureId: 'prior-capture' } };

    const { buffer, visualCapture } = await captureVisualState(tabState);

    expect(buffer).toBe(png);
    // Exact screenshot options: viewport-only, device-pixel scale.
    expect(state.screenshotCalls).toEqual([{ type: 'png', fullPage: false, scale: 'device' }]);
    // The prior capture is superseded by the new one.
    expect(tabState.visualCapture).toBe(visualCapture);
    expect(visualCapture.captureId).not.toBe('prior-capture');
    expect(visualCapture.captureId.length).toBeGreaterThan(0);
    // Exact metadata key set -- coordinate clicks depend on every field.
    expect(Object.keys(visualCapture).sort()).toEqual([...METADATA_KEYS].sort());
    // Dimensions parsed from the actual PNG bytes.
    expect(visualCapture.imageWidth).toBe(320);
    expect(visualCapture.imageHeight).toBe(240);
    expect(visualCapture.viewportWidth).toBe(160);
    expect(visualCapture.viewportHeight).toBe(120);
    expect(visualCapture.devicePixelRatio).toBe(2);
    expect(visualCapture.scrollX).toBe(0);
    expect(visualCapture.scrollY).toBe(0);
    expect(visualCapture.url).toBe('https://example.test/page');
    for (const key of ['imageWidth', 'imageHeight', 'viewportWidth', 'viewportHeight', 'devicePixelRatio']) {
      expect(Number.isFinite(visualCapture[key])).toBe(true);
      expect(visualCapture[key]).toBeGreaterThan(0);
    }
    expect(Number.isFinite(visualCapture.scrollX)).toBe(true);
    expect(Number.isFinite(visualCapture.scrollY)).toBe(true);
    expect(Math.abs(Date.now() - visualCapture.capturedAt)).toBeLessThan(10000);
  });

  test('failed replacement attempts never leave an older capture reusable', async () => {
    const png = makePng(8, 8);

    // Invalid live metrics.
    {
      const { page, state } = makePage({ screenshot: png });
      const tabState = { page };
      await captureVisualState(tabState);
      expect(tabState.visualCapture).not.toBeNull();
      state.metrics = { ...state.metrics, viewportWidth: 0 };
      await expect(captureVisualState(tabState)).rejects.toMatchObject({ statusCode: 500 });
      expect(tabState.visualCapture).toBeNull();
    }

    // Screenshot call rejects.
    {
      const { page, state } = makePage({ screenshot: png });
      const tabState = { page };
      await captureVisualState(tabState);
      state.screenshot = () => { throw new Error('screenshot failed'); };
      await expect(captureVisualState(tabState)).rejects.toThrow('screenshot failed');
      expect(tabState.visualCapture).toBeNull();
    }

    // Unreadable PNG payloads: too short, wrong signature, non-PNG text.
    for (const bad of [
      Buffer.from([0x89, 0x50]),
      Buffer.alloc(24),
      Buffer.from('definitely not a png'),
    ]) {
      const { page, state } = makePage({ screenshot: png });
      const tabState = { page };
      await captureVisualState(tabState);
      state.screenshot = bad;
      await expect(captureVisualState(tabState)).rejects.toMatchObject({ statusCode: 500 });
      expect(tabState.visualCapture).toBeNull();
    }
  });
});

describe('resolveCoordinatesToCss', () => {
  test('maps image pixels proportionally onto CSS pixels when DPR and image size differ', async () => {
    const { page } = makePage({ screenshot: makePng(320, 240) });
    const { tabState, result } = await captureOn(page);
    const captureId = result.visualCapture.captureId;

    // Image center -> CSS viewport center (viewport 160x120, DPR 2).
    await expect(resolveCoordinatesToCss(tabState, { x: 160, y: 120, captureId }))
      .resolves.toEqual({ cssX: 80, cssY: 60 });

    // Image bounds are half-open: [0, width) x [0, height).
    await expect(resolveCoordinatesToCss(tabState, { x: 319, y: 239, captureId }))
      .resolves.toEqual({ cssX: 159.5, cssY: 119.5 });
    await expectInvalidCoordinates({ x: 320, y: 120, captureId }, tabState);
    await expectInvalidCoordinates({ x: 160, y: 240, captureId }, tabState);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'x'],
    ['array', [1, 2]],
    ['number', 5],
    ['missing x', { y: 1, captureId: 'cap' }],
    ['missing y', { x: 1, captureId: 'cap' }],
    ['NaN x', { x: NaN, y: 1, captureId: 'cap' }],
    ['Infinity y', { x: 1, y: Infinity, captureId: 'cap' }],
    ['-Infinity x', { x: -Infinity, y: 1, captureId: 'cap' }],
    ['missing captureId', { x: 1, y: 1 }],
    ['empty captureId', { x: 1, y: 1, captureId: '' }],
    ['non-string captureId', { x: 1, y: 1, captureId: 42 }],
  ])('malformed coordinates (%s) -> 400 invalid_coordinates', async (_label, coordinates) => {
    await expectInvalidCoordinates(coordinates);
  });

  test('negative and out-of-bounds image points are 400 invalid_coordinates', async () => {
    const { page } = makePage({ screenshot: makePng(320, 240) });
    const { tabState, result } = await captureOn(page);
    const captureId = result.visualCapture.captureId;
    for (const [x, y] of [[-1, 10], [10, -1], [-1, -1], [320, 10], [10, 240], [320, 240]]) {
      await expectInvalidCoordinates({ x, y, captureId }, tabState);
    }
  });

  test('missing, mismatched, expired, and negative-age captures are 409 stale_visual_capture', async () => {
    // No capture at all.
    await expectStale({ x: 1, y: 1, captureId: 'anything' }, { visualCapture: null });

    // Mismatched capture id.
    {
      const { page } = makePage({ screenshot: makePng(8, 8) });
      const { tabState } = await captureOn(page);
      await expectStale({ x: 1, y: 1, captureId: 'not-the-capture' }, tabState);
    }

    // Expired (older than the 120s max age).
    {
      const { page } = makePage({ screenshot: makePng(8, 8) });
      const { tabState, result } = await captureOn(page);
      result.visualCapture.capturedAt = Date.now() - (VISUAL_CAPTURE_MAX_AGE_MS + 5);
      await expectStale({ x: 1, y: 1, captureId: result.visualCapture.captureId }, tabState);
    }

    // Negative age (capturedAt in the future).
    {
      const { page } = makePage({ screenshot: makePng(8, 8) });
      const { tabState, result } = await captureOn(page);
      result.visualCapture.capturedAt = Date.now() + 1000;
      await expectStale({ x: 1, y: 1, captureId: result.visualCapture.captureId }, tabState);
    }
  });

  test.each([
    ['url change', (state) => { state.url = 'https://example.test/other'; }],
    ['viewport width change', (state) => { state.metrics.viewportWidth += 10; }],
    ['viewport height change', (state) => { state.metrics.viewportHeight += 10; }],
    ['device pixel ratio change', (state) => { state.metrics.devicePixelRatio = 1; }],
    ['scroll drift greater than 1px', (state) => { state.metrics.scrollY += 1.5; }],
    ['invalid live metrics', (state) => { state.metrics.viewportWidth = NaN; }],
  ])('layout mismatch (%s) -> 409 stale_visual_capture', async (_label, mutate) => {
    const { page, state } = makePage({ screenshot: makePng(8, 8) });
    const { tabState, result } = await captureOn(page);
    mutate(state);
    await expectStale({ x: 1, y: 1, captureId: result.visualCapture.captureId }, tabState);
  });

  test('exactly 1px of scroll drift is still accepted', async () => {
    const { page, state } = makePage({ screenshot: makePng(8, 8) });
    const { tabState, result } = await captureOn(page);
    state.metrics.scrollX += 1;
    state.metrics.scrollY -= 1;
    await expect(resolveCoordinatesToCss(tabState, { x: 1, y: 1, captureId: result.visualCapture.captureId }))
      .resolves.toEqual({ cssX: 20, cssY: 15 });
  });
});

describe('bindVisualCaptureInvalidation', () => {
  test('clears only current-page main-frame navigation; ignores child frames and replaced pages', async () => {
    const { page, state } = makePage({ screenshot: makePng(2, 2) });
    const tabState = { page };
    bindVisualCaptureInvalidation(tabState, page);
    const listener = state.listeners.get('framenavigated');
    expect(typeof listener).toBe('function');

    // Child-frame navigation does not clear the capture.
    tabState.visualCapture = { captureId: 'c1' };
    listener({ name: 'child-frame' });
    expect(tabState.visualCapture).not.toBeNull();

    // Current-page main-frame navigation clears it.
    listener(state.mainFrame);
    expect(tabState.visualCapture).toBeNull();

    // A replaced page (old listener still bound) cannot clear the new tab state.
    tabState.visualCapture = { captureId: 'c2' };
    tabState.page = { name: 'replacement-page' };
    listener(state.mainFrame);
    expect(tabState.visualCapture).not.toBeNull();
  });

  test('tolerates mainFrame() failures and pages without an event emitter', () => {
    const { page, state } = makePage({ screenshot: makePng(2, 2) });
    const tabState = { page, visualCapture: { captureId: 'c1' } };
    bindVisualCaptureInvalidation(tabState, page);
    const listener = state.listeners.get('framenavigated');

    page.mainFrame = () => { throw new Error('page closed'); };
    expect(() => listener(state.mainFrame)).not.toThrow();
    expect(tabState.visualCapture).not.toBeNull();

    expect(() => bindVisualCaptureInvalidation({ visualCapture: null }, null)).not.toThrow();
  });
});
