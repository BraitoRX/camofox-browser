/**
 * E2E: native input serialization across tabs against the shared loopback
 * test server/site (jest.config.e2e.cjs global setup).
 *
 * Two coordinate clicks on different tabs of the same shared browser run
 * concurrently; the browser-wide native input gate must serialize dispatch
 * without wedging the pipeline, so both succeed and a follow-up click on a
 * fresh capture also succeeds.
 */

import { PNG } from 'pngjs';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

// Fetch a viewport screenshot from the REST server and decode its capture
// metadata (mirrors visualCoordinateClick.test.js).
async function fetchScreenshot(serverUrl, userId, tabId) {
  const res = await fetch(
    `${serverUrl}/tabs/${tabId}/screenshot?userId=${encodeURIComponent(userId)}&fullPage=false`
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
  expect(typeof visualCapture.captureId).toBe('string');
  expect(visualCapture.captureId.length).toBeGreaterThan(0);
  for (const key of ['imageWidth', 'imageHeight', 'viewportWidth', 'viewportHeight']) {
    expect(visualCapture[key]).toBeGreaterThan(0);
  }
}

function assertPng(buffer) {
  const png = PNG.sync.read(buffer);
  expect(png.width).toBeGreaterThan(0);
  expect(png.height).toBeGreaterThan(0);
}

// Read-only CSS viewport center of the button (does not invalidate captures).
async function buttonCenter(client, tabId) {
  return (await client.evaluate(tabId, `(() => {
    const rect = document.getElementById('clickMe').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)).result;
}

// Convert the CSS center to image pixels using the metadata ratios (never DPR).
function toImagePoint(center, visualCapture) {
  return {
    x: Math.round(center.x * visualCapture.imageWidth / visualCapture.viewportWidth),
    y: Math.round(center.y * visualCapture.imageHeight / visualCapture.viewportHeight),
  };
}

describe('Native input serialization across tabs', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  // Server/site lifecycle managed by globalSetup/globalTeardown.

  test('two concurrent coordinate clicks on different tabs both succeed and the pipeline stays usable', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId: tabA } = await client.createTab(`${testSiteUrl}/click`);
      const { tabId: tabB } = await client.createTab(`${testSiteUrl}/click`);

      const prepare = async (tabId) => {
        const center = await buttonCenter(client, tabId);
        const { buffer, visualCapture } = await fetchScreenshot(serverUrl, client.userId, tabId);
        assertMetadataShape(visualCapture);
        assertPng(buffer);
        return { tabId, center, captureId: visualCapture.captureId, visualCapture };
      };
      const preparedA = await prepare(tabA);
      const preparedB = await prepare(tabB);

      const [resultA, resultB] = await Promise.all([
        client.click(preparedA.tabId, {
          coordinates: { ...toImagePoint(preparedA.center, preparedA.visualCapture), captureId: preparedA.captureId },
          includeScreenshot: true,
        }),
        client.click(preparedB.tabId, {
          coordinates: { ...toImagePoint(preparedB.center, preparedB.visualCapture), captureId: preparedB.captureId },
          includeScreenshot: true,
        }),
      ]);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      expect(resultA.screenshot).toBeDefined();
      expect(resultB.screenshot).toBeDefined();
      assertPng(Buffer.from(resultA.screenshot.data, 'base64'));
      assertPng(Buffer.from(resultB.screenshot.data, 'base64'));

      // A fresh capture + single click on one tab still works after the
      // concurrent pair: the shared input pipeline is not wedged.
      const freshCenter = await buttonCenter(client, tabA);
      const fresh = await fetchScreenshot(serverUrl, client.userId, tabA);
      assertMetadataShape(fresh.visualCapture);
      const followUp = await client.click(tabA, {
        coordinates: { ...toImagePoint(freshCenter, fresh.visualCapture), captureId: fresh.visualCapture.captureId },
      });
      expect(followUp.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  });
});
