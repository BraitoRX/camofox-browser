/**
 * E2E: screenshot-coordinate navigation against the shared loopback test
 * server/site (jest.config.e2e.cjs global setup).
 *
 * Proves the full REST flow: viewport screenshot + X-Camofox-Visual-Metadata
 * header -> image-pixel coordinate click -> DOM effect -> chained post-click
 * screenshot, plus capture invalidation and the legacy fullPage path.
 */

import { PNG } from 'pngjs';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

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

// Fetch a screenshot from the REST server and decode its capture metadata.
// Returns the raw PNG buffer plus the parsed metadata (null when absent).
async function fetchScreenshot(serverUrl, userId, tabId, fullPage = false) {
  const res = await fetch(
    `${serverUrl}/tabs/${tabId}/screenshot?userId=${encodeURIComponent(userId)}&fullPage=${fullPage}`
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('image/png');
  const buffer = Buffer.from(await res.arrayBuffer());
  const header = res.headers.get('x-camofox-visual-metadata');
  const visualCapture = header
    ? JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
    : null;
  return { buffer, visualCapture };
}

function assertMetadataShape(visualCapture) {
  expect(visualCapture).toBeTruthy();
  expect(Object.keys(visualCapture).sort()).toEqual([...METADATA_KEYS].sort());
  expect(typeof visualCapture.captureId).toBe('string');
  expect(visualCapture.captureId.length).toBeGreaterThan(0);
  for (const key of ['imageWidth', 'imageHeight', 'viewportWidth', 'viewportHeight', 'devicePixelRatio']) {
    expect(Number.isFinite(visualCapture[key])).toBe(true);
    expect(visualCapture[key]).toBeGreaterThan(0);
  }
  expect(Number.isFinite(visualCapture.scrollX)).toBe(true);
  expect(Number.isFinite(visualCapture.scrollY)).toBe(true);
  expect(Number.isFinite(visualCapture.capturedAt)).toBe(true);
  expect(typeof visualCapture.url).toBe('string');
}

function assertPng(buffer) {
  const png = PNG.sync.read(buffer);
  expect(png.width).toBeGreaterThan(0);
  expect(png.height).toBeGreaterThan(0);
  return png;
}

describe('Screenshot coordinate click', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  // Server/site lifecycle managed by globalSetup/globalTeardown.

  test('image-pixel coordinate click hits the button and chains a fresh capture', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);

      // Read-only: CSS viewport center of the button (does not invalidate captures).
      const center = (await client.evaluate(tabId, `(() => {
        const rect = document.getElementById('clickMe').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`)).result;
      expect(center.x).toBeGreaterThan(0);
      expect(center.y).toBeGreaterThan(0);

      const { buffer, visualCapture } = await fetchScreenshot(serverUrl, client.userId, tabId, false);
      assertMetadataShape(visualCapture);
      expect(visualCapture.url).toContain('/click');

      const png = assertPng(buffer);
      expect(png.width).toBe(visualCapture.imageWidth);
      expect(png.height).toBe(visualCapture.imageHeight);

      // Convert CSS center -> image pixels using the metadata ratios (never DPR).
      const imgX = Math.round(center.x * visualCapture.imageWidth / visualCapture.viewportWidth);
      const imgY = Math.round(center.y * visualCapture.imageHeight / visualCapture.viewportHeight);

      const clickResult = await client.click(tabId, {
        coordinates: { x: imgX, y: imgY, captureId: visualCapture.captureId },
        includeScreenshot: true,
      });

      expect(clickResult.ok).toBe(true);
      expect(clickResult.refsAvailable).toBe(false);
      expect(clickResult.screenshot).toBeDefined();
      expect(clickResult.screenshot.mimeType).toBe('image/png');
      assertPng(Buffer.from(clickResult.screenshot.data, 'base64'));

      // The chained capture is fresh, shaped identically, and points at the same page.
      assertMetadataShape(clickResult.visualCapture);
      expect(clickResult.visualCapture.captureId).not.toBe(visualCapture.captureId);
      expect(clickResult.visualCapture.url).toContain('/click');

      // The click actually activated the button in the DOM.
      const resultText = await client.evaluate(tabId, `document.getElementById('result').textContent`);
      expect(resultText.result).toBe('Button was clicked!');

      // The pre-click capture was consumed; reusing it is a retryable 409.
      await expect(client.click(tabId, {
        coordinates: { x: imgX, y: imgY, captureId: visualCapture.captureId },
      })).rejects.toMatchObject({ status: 409, data: { code: 'stale_visual_capture' } });
    } finally {
      await client.cleanup();
    }
  });

  test('snapshot and scroll invalidate the viewport capture', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);

      const first = await fetchScreenshot(serverUrl, client.userId, tabId, false);
      assertMetadataShape(first.visualCapture);

      // Snapshot/DOM observation replaces coordinate targeting.
      await client.getSnapshot(tabId);
      await expect(client.click(tabId, {
        coordinates: { x: 1, y: 1, captureId: first.visualCapture.captureId },
      })).rejects.toMatchObject({ status: 409, data: { code: 'stale_visual_capture' } });

      const second = await fetchScreenshot(serverUrl, client.userId, tabId, false);
      assertMetadataShape(second.visualCapture);
      expect(second.visualCapture.captureId).not.toBe(first.visualCapture.captureId);

      // Scrolling moves the viewport relative to the captured pixels.
      await client.scroll(tabId, { direction: 'down', amount: 100 });
      await expect(client.click(tabId, {
        coordinates: { x: 1, y: 1, captureId: second.visualCapture.captureId },
      })).rejects.toMatchObject({ status: 409, data: { code: 'stale_visual_capture' } });
    } finally {
      await client.cleanup();
    }
  });

  test('fullPage screenshot returns no metadata and invalidates a viewport capture', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const viewport = await fetchScreenshot(serverUrl, client.userId, tabId, false);
      assertMetadataShape(viewport.visualCapture);

      const fullPage = await fetchScreenshot(serverUrl, client.userId, tabId, true);
      expect(fullPage.visualCapture).toBeNull();
      assertPng(fullPage.buffer);

      await expect(client.click(tabId, {
        coordinates: { x: 1, y: 1, captureId: viewport.visualCapture.captureId },
      })).rejects.toMatchObject({ status: 409, data: { code: 'stale_visual_capture' } });
    } finally {
      await client.cleanup();
    }
  });
});
