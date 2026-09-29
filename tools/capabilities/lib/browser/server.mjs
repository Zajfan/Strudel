// Minimal static file server for the capability browser tier: serves website/dist (or any
// root) on 127.0.0.1 with the cross-origin isolation headers the REPL needs for SharedArrayBuffer.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

// Resolves a raw request path against root by walking '.'/'..' segments ourselves. WHATWG URL
// (and fetch()) silently normalizes '..' away before it ever reaches an escape check, so a
// traversal attempt like '/../../etc/passwd' would otherwise never be seen as an escape.
function resolveRequestPath(rawUrl) {
  const rawPath = rawUrl.split('?')[0].split('#')[0];
  const segments = rawPath.split('/');
  const stack = [];
  for (const raw of segments) {
    if (raw === '' || raw === '.') continue;
    const segment = decodeURIComponent(raw);
    if (segment === '..') {
      if (stack.length === 0) return null; // escapes root
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

function contentTypeFor(path) {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export async function startStaticServer(root) {
  const absRoot = resolve(root);
  const server = createServer((req, res) => {
    let segments;
    try {
      segments = resolveRequestPath(req.url);
    } catch {
      res.writeHead(400, ISOLATION_HEADERS);
      res.end();
      return;
    }
    if (segments === null) {
      res.writeHead(403, ISOLATION_HEADERS);
      res.end();
      return;
    }
    let filePath = segments.length ? join(absRoot, ...segments) : absRoot;
    // Defense in depth: any resolved path outside root (e.g. via a symlink-like join) -> 403.
    if (filePath !== absRoot && !resolve(filePath).startsWith(absRoot + sep)) {
      res.writeHead(403, ISOLATION_HEADERS);
      res.end();
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, ISOLATION_HEADERS);
      res.end();
      return;
    }
    res.writeHead(200, { ...ISOLATION_HEADERS, 'Content-Type': contentTypeFor(filePath) });
    createReadStream(filePath).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
