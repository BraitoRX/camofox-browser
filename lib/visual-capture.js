// Screenshot-coordinate navigation helpers.
//
// A "visual capture" is a viewport-only PNG plus the layout metadata in effect
// when it was taken. Coordinates are expressed in the PNG's own image pixels;
// resolveCoordinatesToCss() maps them proportionally onto the live CSS viewport
// and rejects captures that no longer match the page (navigation, scroll,
// resize, DPR change, or a newer capture).
//
// Pure capture/validation logic lives here (per the repo's code-separation
// conventions); server.js routes only call these helpers.

import crypto from 'crypto';

/** How long a visual capture may be reused for coordinate clicks (ms). */
export const VISUAL_CAPTURE_MAX_AGE_MS = 120000;

// The page may settle by a sub-pixel amount without moving the target, so
// scroll offsets get a small drift allowance; everything else must match exactly.
const MAX_SCROLL_DRIFT_PX = 1;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function visualCaptureFailure(message) {
  return Object.assign(new Error(message), { statusCode: 500 });
}

export function invalidCoordinatesError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'invalid_coordinates' });
}

export function staleVisualCaptureError(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: 'stale_visual_capture' });
}

// Read the exact pixel dimensions from the PNG IHDR chunk (bytes 16..24).
function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

async function readVisualMetrics(page) {
  const metrics = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }));
  return { ...metrics, url: page.url() };
}

function hasValidVisualMetrics(metrics) {
  return Boolean(metrics) &&
    Number.isFinite(metrics.viewportWidth) && metrics.viewportWidth > 0 &&
    Number.isFinite(metrics.viewportHeight) && metrics.viewportHeight > 0 &&
    Number.isFinite(metrics.devicePixelRatio) && metrics.devicePixelRatio > 0 &&
    Number.isFinite(metrics.scrollX) && Number.isFinite(metrics.scrollY) &&
    typeof metrics.url === 'string';
}

/**
 * Attach a main-frame navigation listener that invalidates this tab's visual
 * capture. The `tabState.page === page` guard keeps a replaced page (e.g. after
 * Google proxy rotation) from clearing the surviving tab state's capture.
 */
export function bindVisualCaptureInvalidation(tabState, page = tabState.page) {
  if (!page || typeof page.on !== 'function') return;
  page.on('framenavigated', (frame) => {
    if (tabState.page !== page) return;
    let mainFrame;
    try { mainFrame = page.mainFrame(); } catch { return; }
    if (frame === mainFrame) tabState.visualCapture = null;
  });
}

/**
 * Capture the current viewport as a PNG plus the metadata needed to map its
 * image pixels back to CSS coordinates. Stores the metadata as
 * tabState.visualCapture -- the only capture coordinate clicks may reference --
 * and returns { buffer, visualCapture }.
 */
export async function captureVisualState(tabState) {
  // A new capture attempt supersedes any previous one: clear first so a failed
  // metrics read, screenshot, or PNG validation cannot leave an older capture
  // reusable (latest-capture semantics).
  tabState.visualCapture = null;
  // Read layout first: if the page moves between this read and the screenshot,
  // the stored metadata will not match the pixels and the click-time re-read
  // rejects the capture as stale instead of clicking the wrong spot.
  const metrics = await readVisualMetrics(tabState.page);
  if (!hasValidVisualMetrics(metrics)) {
    throw visualCaptureFailure('Page reported invalid viewport metrics; cannot create a coordinate capture');
  }
  // scale:'device' keeps the PNG at device pixels so image pixels can be mapped
  // back to CSS pixels via the viewport/image ratio (Retina-safe).
  const buffer = await tabState.page.screenshot({ type: 'png', fullPage: false, scale: 'device' });
  const dimensions = readPngDimensions(buffer);
  if (!dimensions) {
    throw visualCaptureFailure('Screenshot did not return a readable PNG (missing IHDR)');
  }
  const visualCapture = {
    captureId: crypto.randomUUID(),
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
    viewportWidth: metrics.viewportWidth,
    viewportHeight: metrics.viewportHeight,
    devicePixelRatio: metrics.devicePixelRatio,
    scrollX: metrics.scrollX,
    scrollY: metrics.scrollY,
    url: metrics.url,
    capturedAt: Date.now(),
  };
  tabState.visualCapture = visualCapture;
  return { buffer, visualCapture };
}

/**
 * Validate a coordinate click against the latest visual capture and map image
 * pixels to current CSS viewport pixels. Throws 400 invalid_coordinates for a
 * malformed request and 409 stale_visual_capture when the capture is missing,
 * expired, or no longer matches the live layout.
 */
export async function resolveCoordinatesToCss(tabState, coordinates) {
  if (!coordinates || typeof coordinates !== 'object' || Array.isArray(coordinates)) {
    throw invalidCoordinatesError('coordinates must be an object with { x, y, captureId }');
  }
  const { x, y, captureId } = coordinates;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw invalidCoordinatesError('coordinates.x and coordinates.y must be finite numbers (image pixels)');
  }
  if (typeof captureId !== 'string' || captureId === '') {
    throw invalidCoordinatesError('coordinates.captureId is required (from the latest screenshot visualCapture)');
  }
  const capture = tabState.visualCapture;
  if (!capture || capture.captureId !== captureId) {
    throw staleVisualCaptureError('No matching visual capture. Take a fresh screenshot and use its captureId.');
  }
  const ageMs = Date.now() - capture.capturedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > VISUAL_CAPTURE_MAX_AGE_MS) {
    throw staleVisualCaptureError(`Visual capture is older than ${VISUAL_CAPTURE_MAX_AGE_MS}ms. Take a fresh screenshot.`);
  }
  if (x < 0 || y < 0 || x >= capture.imageWidth || y >= capture.imageHeight) {
    throw invalidCoordinatesError(`coordinates (${x}, ${y}) are outside the captured image ${capture.imageWidth}x${capture.imageHeight}`);
  }
  const current = await readVisualMetrics(tabState.page);
  const layoutChanged =
    !hasValidVisualMetrics(current) ||
    current.url !== capture.url ||
    current.viewportWidth !== capture.viewportWidth ||
    current.viewportHeight !== capture.viewportHeight ||
    current.devicePixelRatio !== capture.devicePixelRatio ||
    Math.abs(current.scrollX - capture.scrollX) > MAX_SCROLL_DRIFT_PX ||
    Math.abs(current.scrollY - capture.scrollY) > MAX_SCROLL_DRIFT_PX;
  if (layoutChanged) {
    throw staleVisualCaptureError('Page layout changed since the screenshot. Take a fresh screenshot and retry.');
  }
  return {
    cssX: x * capture.viewportWidth / capture.imageWidth,
    cssY: y * capture.viewportHeight / capture.imageHeight,
  };
}
