/**
 * Mock-HTTP contract tests for the shared tool contract module
 * (lib/mcp-tool-contracts.mjs).
 *
 * These tests are the "1:1 compatibility is verifiable" guard the reviewer
 * asked for: every tool's REST route, method, body shape, auth header, and
 * response decoding is asserted against a mock REST server. Because plugin.ts
 * (OpenClaw) and mcp/server.mjs both call the same runTool()/adaptResponse(),
 * passing these tests proves both hosts issue identical REST traffic.
 *
 * No network: globalThis.fetch is swapped per-test.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  TOOL_DEFS,
  TOOL_NAMES,
  buildRequest,
  buildCookieRequest,
  fetchSpec,
  runTool,
  adaptResponse,
  authHeaders,
} from '../../lib/mcp-tool-contracts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:9377';
const CTX = { userId: 'u1', sessionKey: 'default' };
const cfg = (overrides = {}) => ({
  apiKey: 'API-KEY',
  accessKey: 'ACCESS-KEY',
  cookiesDir: '/tmp/cookies',
  ...overrides,
});

// --- Minimal fetch mock -----------------------------------------------------
const originalFetch = globalThis.fetch;

function makeResponse(res) {
  const status = res.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => (res.headers ? res.headers[k.toLowerCase()] ?? null : null),
    },
    async text() {
      return typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    },
    async json() {
      return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    },
    async arrayBuffer() {
      return res.buffer ?? Buffer.from(res.body ?? '');
    },
  };
}

function installFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const rawHeaders = init.headers || {};
    const headers = rawHeaders instanceof Headers
      ? Object.fromEntries(rawHeaders.entries())
      : { ...rawHeaders };
    const req = {
      path: `${u.pathname}${u.search}`,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      body: init.body,
    };
    const route = routes.find((r) => r.match(req));
    if (!route) {
      throw new Error(`no mock route for ${req.method} ${req.path}`);
    }
    return makeResponse(await route.respond(req));
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- Schema sanity ----------------------------------------------------------
describe('TOOL_DEFS', () => {
  test('exposes exactly 12 tools in stable order', () => {
    expect(TOOL_DEFS).toHaveLength(12);
    expect(TOOL_NAMES).toEqual([
      'camofox_create_tab',
      'camofox_snapshot',
      'camofox_click',
      'camofox_type',
      'camofox_navigate',
      'camofox_scroll',
      'camofox_screenshot',
      'camofox_close_tab',
      'camofox_evaluate',
      'camofox_list_tabs',
      'camofox_import_cookies',
      'camofox_navigation_guard',
    ]);
  });

  test('every def has a unique name and a valid JSON-Schema object', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_DEFS) {
      expect(t.inputSchema.type).toBe('object');
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
    }
  });

  test('camofox_click schema exposes strict coordinates, doubleClick, includeScreenshot', () => {
    const click = TOOL_DEFS.find((t) => t.name === 'camofox_click');
    const coordinates = click.inputSchema.properties.coordinates;
    expect(coordinates.type).toBe('object');
    expect(coordinates.required).toEqual(['x', 'y', 'captureId']);
    expect(coordinates.additionalProperties).toBe(false);
    expect(Object.keys(coordinates.properties).sort()).toEqual(['captureId', 'x', 'y']);
    expect(click.inputSchema.properties.doubleClick.type).toBe('boolean');
    expect(click.inputSchema.properties.includeScreenshot.type).toBe('boolean');
  });
});

// --- buildRequest: per-tool REST contract (source of truth assertions) -------
describe('buildRequest', () => {
  test.each([
    ['camofox_create_tab', { url: 'https://x.com' }, { method: 'POST', path: '/tabs', auth: 'accessKey', kind: 'json' }],
    ['camofox_snapshot', { tabId: 't1' }, { method: 'GET', path: '/tabs/t1/snapshot?userId=u1&includeScreenshot=true', auth: 'accessKey', kind: 'snapshot' }],
    ['camofox_snapshot', { tabId: 't1', offset: 40 }, { method: 'GET', path: '/tabs/t1/snapshot?userId=u1&includeScreenshot=true&offset=40', auth: 'accessKey', kind: 'snapshot' }],
    ['camofox_click', { tabId: 't1', ref: 'e1' }, { method: 'POST', path: '/tabs/t1/click', auth: 'accessKey', kind: 'json' }],
    ['camofox_type', { tabId: 't1', text: 'hi', pressEnter: true }, { method: 'POST', path: '/tabs/t1/type', auth: 'accessKey', kind: 'json' }],
    ['camofox_navigate', { tabId: 't1', url: 'https://y.com' }, { method: 'POST', path: '/tabs/t1/navigate', auth: 'accessKey', kind: 'json' }],
    ['camofox_scroll', { tabId: 't1', direction: 'down', amount: 200 }, { method: 'POST', path: '/tabs/t1/scroll', auth: 'accessKey', kind: 'json' }],
    ['camofox_screenshot', { tabId: 't1' }, { method: 'GET', path: '/tabs/t1/screenshot?userId=u1', auth: 'accessKey', kind: 'image' }],
    ['camofox_close_tab', { tabId: 't1' }, { method: 'DELETE', path: '/tabs/t1?userId=u1', auth: 'accessKey', kind: 'json' }],
    ['camofox_evaluate', { tabId: 't1', expression: '1+1' }, { method: 'POST', path: '/tabs/t1/evaluate', auth: 'accessKey', kind: 'json' }],
    ['camofox_list_tabs', {}, { method: 'GET', path: '/tabs?userId=u1', auth: 'accessKey', kind: 'json' }],
    ['camofox_navigation_guard', { tabId: 't1', action: 'status' }, { method: 'GET', path: '/tabs/t1/navigation-guard?userId=u1', auth: 'accessKey', kind: 'json' }],
    ['camofox_navigation_guard', { tabId: 't1', action: 'start', expectedUrl: 'https://example.test/' }, { method: 'POST', path: '/tabs/t1/navigation-guard', auth: 'accessKey', kind: 'json' }],
  ])('%s → %s %s (auth=%s)', (name, args, expected) => {
    const spec = buildRequest(name, args, CTX);
    expect(spec.method).toBe(expected.method);
    expect(spec.path).toBe(expected.path);
    expect(spec.auth).toBe(expected.auth);
    expect(spec.responseKind).toBe(expected.kind);
  });

  test('create_tab body carries url + userId + sessionKey', () => {
    const spec = buildRequest('camofox_create_tab', { url: 'https://x.com' }, CTX);
    expect(spec.body).toEqual({ url: 'https://x.com', userId: 'u1', sessionKey: 'default' });
  });

  test('click/type/navigate/scroll forward all non-routing args + userId in body', () => {
    const spec = buildRequest('camofox_type', { tabId: 't1', ref: 'e2', text: 'hi', pressEnter: true }, CTX);
    expect(spec.body).toEqual({ ref: 'e2', text: 'hi', pressEnter: true, userId: 'u1' });
    expect(spec.body.tabId).toBeUndefined();
  });

  test('evaluate body is exactly { userId, expression }', () => {
    const spec = buildRequest('camofox_evaluate', { tabId: 't1', expression: 'document.title' }, CTX);
    expect(spec.body).toEqual({ userId: 'u1', expression: 'document.title' });
  });

  test('coordinate click forwards nested coordinates + strict booleans without tabId', () => {
    const spec = buildRequest('camofox_click', {
      tabId: 't1',
      coordinates: { x: 12.5, y: 34, captureId: 'cap-1' },
      doubleClick: true,
      includeScreenshot: true,
    }, CTX);
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/tabs/t1/click');
    expect(spec.body).toEqual({
      coordinates: { x: 12.5, y: 34, captureId: 'cap-1' },
      doubleClick: true,
      includeScreenshot: true,
      userId: 'u1',
    });
    expect(spec.body.tabId).toBeUndefined();
    expect(spec.responseKind).toBe('snapshot');
  });

  test('legacy ref click keeps the json responseKind and body', () => {
    const spec = buildRequest('camofox_click', { tabId: 't1', ref: 'e1' }, CTX);
    expect(spec.responseKind).toBe('json');
    expect(spec.body).toEqual({ ref: 'e1', userId: 'u1' });
  });

  test('includeScreenshot must be strictly true to select the snapshot adapter', () => {
    for (const includeScreenshot of [false, 'true', 1, undefined]) {
      const spec = buildRequest('camofox_click', {
        tabId: 't1',
        coordinates: { x: 1, y: 2, captureId: 'cap-1' },
        includeScreenshot,
      }, CTX);
      expect(spec.responseKind).toBe('json');
    }
  });

  test('import_cookies is NOT synchronous (must use buildCookieRequest)', () => {
    expect(() => buildRequest('camofox_import_cookies', {}, CTX)).toThrow(/buildCookieRequest/);
  });

  test('unknown tool throws', () => {
    expect(() => buildRequest('camofox_bogus', {}, CTX)).toThrow(/Unknown tool/);
  });
});

// --- authHeaders: accessKey vs apiKey vs none -------------------------------
describe('authHeaders', () => {
  test('accessKey present → Bearer accessKey', () => {
    expect(authHeaders({ auth: 'accessKey' }, cfg())).toEqual({
      Authorization: 'Bearer ACCESS-KEY',
    });
  });
  test('accessKey absent on ungated server → no header (pass-through)', () => {
    expect(authHeaders({ auth: 'accessKey' }, cfg({ accessKey: '' }))).toEqual({});
  });
  test('apiKey → Bearer apiKey', () => {
    expect(authHeaders({ auth: 'apiKey' }, cfg())).toEqual({
      Authorization: 'Bearer API-KEY',
    });
  });
  test('none → empty', () => {
    expect(authHeaders({ auth: 'none' }, cfg())).toEqual({});
  });
});

// --- adaptResponse: content-block shaping -----------------------------------
describe('adaptResponse', () => {
  test('json → single text block', () => {
    const spec = { responseKind: 'json' };
    const c = adaptResponse(spec, { ok: true });
    expect(c).toHaveLength(1);
    expect(c[0].type).toBe('text');
    expect(JSON.parse(c[0].text)).toEqual({ ok: true });
  });
  test('snapshot → text block + screenshot image block', () => {
    const spec = { responseKind: 'snapshot' };
    const c = adaptResponse(spec, { url: 'u', snapshot: 's', screenshot: { data: 'IMG', mimeType: 'image/png' } });
    expect(c).toHaveLength(2);
    expect(c[0].type).toBe('text');
    expect(c[1]).toEqual({ type: 'image', data: 'IMG', mimeType: 'image/png' });
    expect(JSON.parse(c[0].text).screenshot).toBeUndefined();
  });
  test('snapshot without screenshot → text only', () => {
    const c = adaptResponse({ responseKind: 'snapshot' }, { snapshot: 's' });
    expect(c).toHaveLength(1);
  });
  test('image → passes the prebuilt image block through', () => {
    const block = { type: 'image', data: 'IMG', mimeType: 'image/png' };
    expect(adaptResponse({ responseKind: 'image' }, block)).toEqual([block]);
  });
  test('image with visualCapture → compact metadata text first, unchanged image second', () => {
    const block = { type: 'image', data: 'IMG', mimeType: 'image/png' };
    const visualCapture = { captureId: 'c1', imageWidth: 100, imageHeight: 50 };
    const content = adaptResponse({ responseKind: 'image' }, { image: block, visualCapture });
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: JSON.stringify({ visualCapture }) });
    expect(content[1]).toBe(block);
  });
  test('image payload without visualCapture stays a single image block', () => {
    const block = { type: 'image', data: 'IMG', mimeType: 'image/png' };
    expect(adaptResponse({ responseKind: 'image' }, { image: block })).toEqual([block]);
  });
  test('cookie import → surfaces imported count', () => {
    const spec = { responseKind: 'json', meta: { imported: 3, userId: 'u1' } };
    const c = adaptResponse(spec, { ok: true });
    expect(JSON.parse(c[0].text)).toEqual({ imported: 3, userId: 'u1', result: { ok: true } });
  });
});

// --- fetchSpec: wire-level behavior with a mocked REST server ----------------
describe('fetchSpec (mock REST)', () => {
  test('attaches accessKey bearer to an accessKey request', async () => {
    let seen;
    installFetch([
      { match: (r) => r.method === 'POST' && r.path === '/tabs', respond: (r) => { seen = r; return { body: { tabId: 't1' } }; } },
    ]);
    const spec = buildRequest('camofox_create_tab', { url: 'https://x.com' }, CTX);
    await fetchSpec(BASE, spec, cfg());
    expect(seen.headers.Authorization).toBe('Bearer ACCESS-KEY');
    expect(JSON.parse(seen.body)).toEqual({ url: 'https://x.com', userId: 'u1', sessionKey: 'default' });
  });

  test('omits Authorization when server has no accessKey', async () => {
    let seen;
    installFetch([{ match: (r) => r.method === 'GET' && r.path === '/tabs?userId=u1', respond: (r) => { seen = r; return { body: [] }; } }]);
    await fetchSpec(BASE, buildRequest('camofox_list_tabs', {}, CTX), cfg({ accessKey: '' }));
    expect(seen.headers.Authorization).toBeUndefined();
  });

  test('throws on non-2xx with status + body', async () => {
    installFetch([{ match: () => true, respond: () => ({ status: 403, body: { error: 'Forbidden' } }) }]);
    await expect(fetchSpec(BASE, buildRequest('camofox_list_tabs', {}, CTX), cfg())).rejects.toThrow(/403/);
  });

  test('screenshot decodes image bytes to a base64 image block', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    installFetch([
      { match: (r) => r.method === 'GET' && r.path === '/tabs/t1/screenshot?userId=u1', respond: () => ({ headers: { 'content-type': 'image/png' }, buffer: pngBytes }) },
    ]);
    const out = await fetchSpec(BASE, buildRequest('camofox_screenshot', { tabId: 't1' }, CTX), cfg());
    expect(out).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(out.data).toBe(pngBytes.toString('base64'));
    expect(out.visualCapture).toBeUndefined();
  });

  test('screenshot decodes base64url visual metadata into { image, visualCapture }', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const visualCapture = {
      captureId: 'cap-1',
      imageWidth: 2,
      imageHeight: 3,
      viewportWidth: 1,
      viewportHeight: 1.5,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 0,
      url: 'https://example.test/',
      capturedAt: 1234567890,
    };
    const header = Buffer.from(JSON.stringify(visualCapture), 'utf8').toString('base64url');
    installFetch([
      {
        match: (r) => r.method === 'GET' && r.path === '/tabs/t1/screenshot?userId=u1',
        respond: () => ({ headers: { 'content-type': 'image/png', 'x-camofox-visual-metadata': header }, buffer: pngBytes }),
      },
    ]);
    const out = await fetchSpec(BASE, buildRequest('camofox_screenshot', { tabId: 't1' }, CTX), cfg());
    expect(out.image).toEqual({ type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' });
    expect(out.visualCapture).toEqual(visualCapture);
  });

  test('malformed visual metadata header does not fail the screenshot', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const header = Buffer.from('{not json', 'utf8').toString('base64url');
    installFetch([
      {
        match: (r) => r.method === 'GET' && r.path === '/tabs/t1/screenshot?userId=u1',
        respond: () => ({ headers: { 'content-type': 'image/png', 'x-camofox-visual-metadata': header }, buffer: pngBytes }),
      },
    ]);
    const out = await fetchSpec(BASE, buildRequest('camofox_screenshot', { tabId: 't1' }, CTX), cfg());
    expect(out).toEqual({ type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' });
    expect(out.visualCapture).toBeUndefined();
  });

  test('screenshot that returns JSON (error with 200) is not base64-encoded', async () => {
    installFetch([
      { match: () => true, respond: () => ({ headers: { 'content-type': 'application/json' }, body: { error: 'tab closed' } }) },
    ]);
    await expect(fetchSpec(BASE, buildRequest('camofox_screenshot', { tabId: 't1' }, CTX), cfg())).rejects.toThrow(/Screenshot failed/);
  });
});

// --- runTool end-to-end: a few representative tools -------------------------
describe('runTool (end-to-end)', () => {
  test('create_tab round-trips through the real REST shape', async () => {
    installFetch([{ match: (r) => r.method === 'POST' && r.path === '/tabs', respond: () => ({ body: { tabId: 't9', url: 'https://x.com' } }) }]);
    const { spec, payload } = await runTool('camofox_create_tab', { url: 'https://x.com' }, CTX, BASE, cfg());
    expect(payload).toEqual({ tabId: 't9', url: 'https://x.com' });
    const content = adaptResponse(spec, payload);
    expect(content[0].type).toBe('text');
  });

  test('snapshot splits the embedded screenshot into an image block', async () => {
    installFetch([
      { match: (r) => r.method === 'GET' && r.path.startsWith('/tabs/t1/snapshot'), respond: () => ({ body: { url: 'u', snapshot: 's', screenshot: { data: 'IMG', mimeType: 'image/png' } } }) },
    ]);
    const { spec, payload } = await runTool('camofox_snapshot', { tabId: 't1' }, CTX, BASE, cfg());
    const content = adaptResponse(spec, payload);
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ type: 'image', data: 'IMG' });
  });

  test('coordinate click with includeScreenshot sends coordinates and splits the post-click image', async () => {
    let seen;
    installFetch([
      {
        match: (r) => r.method === 'POST' && r.path === '/tabs/t1/click',
        respond: (r) => {
          seen = r;
          return {
            body: {
              ok: true,
              url: 'https://example.test/click',
              refsAvailable: false,
              screenshot: { data: 'IMG', mimeType: 'image/png' },
              visualCapture: { captureId: 'cap-2' },
            },
          };
        },
      },
    ]);
    const { spec, payload } = await runTool(
      'camofox_click',
      { tabId: 't1', coordinates: { x: 7, y: 8, captureId: 'cap-1' }, includeScreenshot: true },
      CTX,
      BASE,
      cfg()
    );
    expect(spec.responseKind).toBe('snapshot');
    expect(JSON.parse(seen.body)).toEqual({
      coordinates: { x: 7, y: 8, captureId: 'cap-1' },
      includeScreenshot: true,
      userId: 'u1',
    });
    const content = adaptResponse(spec, payload);
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('text');
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, refsAvailable: false, visualCapture: { captureId: 'cap-2' } });
    expect(content[0].text).not.toContain('IMG');
    expect(content[1]).toEqual({ type: 'image', data: 'IMG', mimeType: 'image/png' });
  });
});

// --- Cookie import: the core contract fix ----------------------------------
// Reviewer: MCP previously POSTed { cookiesPath } but the REST route requires a
// parsed { cookies: [...] } payload. This proves the MCP path now parses the
// Netscape file locally (like OpenClaw) and sends { cookies } + Bearer apiKey.
describe('cookie import contract', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-browser-mcp-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const NETSCAPE = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t9999999999\tsess\tabc123',
    '.other.com\tTRUE\t/\tFALSE\t0\tunwanted\tnope',
  ].join('\n');

  test('parses Netscape locally and sends { cookies } body with apiKey bearer', async () => {
    fs.writeFileSync(path.join(tmpDir, 'cookies.txt'), NETSCAPE);
    let seen;
    installFetch([
      {
        match: (r) => r.method === 'POST' && r.path === '/sessions/u1/cookies',
        respond: (r) => { seen = r; return { body: { ok: true, userId: 'u1', count: 1 } }; },
      },
    ]);
    const { spec, payload } = await runTool(
      'camofox_import_cookies',
      { cookiesPath: 'cookies.txt', domainSuffix: 'example.com' },
      CTX,
      BASE,
      cfg({ cookiesDir: tmpDir })
    );
    // REST route receives the PARSED cookie array, never a path.
    expect(spec.body.cookies).toEqual([
      expect.objectContaining({ name: 'sess', value: 'abc123', domain: '.example.com', httpOnly: true, secure: true }),
    ]);
    expect(spec.body.cookiesPath).toBeUndefined();
    expect(spec.auth).toBe('apiKey');
    expect(seen.headers.Authorization).toBe('Bearer API-KEY');
    expect(JSON.parse(seen.body)).toEqual({ cookies: spec.body.cookies });
    // Response surfaces the parsed count.
    expect(JSON.parse(adaptResponse(spec, payload)[0].text).imported).toBe(1);
  });

  test('throws when CAMOFOX_API_KEY is unset (cookie import disabled)', async () => {
    await expect(
      buildCookieRequest({ cookiesPath: 'cookies.txt' }, CTX, cfg({ apiKey: '' }))
    ).rejects.toThrow(/CAMOFOX_API_KEY/);
  });

  test('rejects cookiesPath outside the cookies directory (path traversal)', async () => {
    await expect(
      buildCookieRequest({ cookiesPath: '../escape.txt' }, CTX, cfg({ cookiesDir: tmpDir }))
    ).rejects.toThrow(/within the cookies directory/);
  });
});

// --- Cross-host equivalence: every tool name resolves via both entry points --
describe('host equivalence', () => {
  test('every tool name is buildable and listed', () => {
    for (const name of TOOL_NAMES) {
      if (name === 'camofox_import_cookies') {
        expect(() => buildRequest(name, {}, CTX)).toThrow(/buildCookieRequest/);
      } else if (name === 'camofox_navigation_guard') {
        expect(() => buildRequest(name, { tabId: 't1', action: 'status' }, CTX)).not.toThrow();
      } else {
        expect(() => buildRequest(name, { tabId: 't1', url: 'u', expression: 'e', text: 'x', direction: 'down' }, CTX)).not.toThrow();
      }
    }
  });
});
