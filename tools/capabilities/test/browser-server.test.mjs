import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticServer } from '../lib/browser/server.mjs';

// fetch() normalizes '..' away, so path escapes need a raw request.
const rawStatus = (url, path) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    request({ host: u.hostname, port: u.port, path }, (r) => {
      r.resume();
      resolve(r.statusCode);
    })
      .on('error', reject)
      .end();
  });

let server;
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'caps-server-'));
  writeFileSync(join(root, 'index.html'), '<p>hi</p>');
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'x.wasm'), 'w');
  server = await startStaticServer(root);
});
afterAll(() => server.close());

describe('startStaticServer', () => {
  it('serves index.html with isolation headers', async () => {
    const r = await fetch(server.url + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
  });
  it('serves wasm with its MIME type', async () => {
    const r = await fetch(server.url + '/a/x.wasm');
    expect(r.headers.get('content-type')).toBe('application/wasm');
  });
  it('returns 404 for missing files and 403 for escapes', async () => {
    expect((await fetch(server.url + '/nope.js')).status).toBe(404);
    expect(await rawStatus(server.url, '/../../etc/passwd')).toBe(403);
  });
});
