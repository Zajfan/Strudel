// Drives the desktop app (src-tauri) for the desktop probes: the app runs on a private Xvfb display,
// tauri-driver (a WebDriver server over WebKitWebDriver) starts one app session per probe, and
// openDesktopPage() returns the same `page` interface the browser probes use (evaluate, click), so
// most browser probes run unchanged against the desktop's WebKitGTK webview.
//
// Isolation from the user's session: WAYLAND_DISPLAY is removed and GDK_BACKEND=x11 forces the
// window onto Xvfb (otherwise GTK opens it on the real desktop), and GStreamer's automatic audio
// sink is pointed at fakeaudiosink, so nothing plays on the speakers. The app's native audio (the cue,
// src-tauri/src/audio) gets an ALSA config with a silent device, "strudel_null", that probes use.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The system ALSA config plus a device that discards audio (cpal doesn't list ALSA's own "null").
function silentAlsaConfig() {
  const path = join(tmpdir(), 'strudel-caps-asound.conf');
  writeFileSync(
    path,
    '</usr/share/alsa/alsa.conf>\npcm.strudel_null { type null; hint { show on; description "Strudel test sink (discards audio)" } }\n',
  );
  return path;
}

export function appEnv(display) {
  const env = { ...process.env, DISPLAY: display, GDK_BACKEND: 'x11' };
  if (existsSync('/usr/share/alsa/alsa.conf')) env.ALSA_CONFIG_PATH = silentAlsaConfig();
  delete env.WAYLAND_DISPLAY;
  Object.assign(env, {
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
    LIBGL_ALWAYS_SOFTWARE: '1',
    GST_PLUGIN_FEATURE_RANK: 'fakeaudiosink:MAX',
  });
  return env;
}

// What the harness needs, or the reason it can't run.
export function desktopPrerequisites(repoRoot) {
  const missing = [];
  for (const [bin, why] of [
    ['Xvfb', 'virtual display'],
    ['WebKitWebDriver', 'WebKitGTK WebDriver'],
    ['tauri-driver', 'cargo install tauri-driver'],
    ['cargo', 'Rust toolchain'],
  ]) {
    if (spawnSync('which', [bin]).status !== 0) missing.push(`${bin} (${why})`);
  }
  if (!existsSync(join(repoRoot, 'website', 'dist', 'index.html'))) missing.push('website/dist (run pnpm build)');
  return missing;
}

// Builds the app with the website embedded (custom-protocol) and returns the binary's path.
export function buildApp(repoRoot, log = () => {}) {
  log('cargo build --features custom-protocol');
  const run = spawnSync('cargo', ['build', '--features', 'custom-protocol', '--manifest-path', join(repoRoot, 'src-tauri', 'Cargo.toml')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.status !== 0) throw new Error(`cargo build failed:\n${(run.stderr || '').split('\n').slice(-20).join('\n')}`);
  return join(repoRoot, 'src-tauri', 'target', 'debug', 'app');
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`${url} did not come up within ${timeoutMs} ms`);
}

// Starts Xvfb and tauri-driver. Returns { openPage, close }.
export async function startDesktop({ application }) {
  const displayNumber = 90 + Math.floor(Math.random() * 400);
  const display = `:${displayNumber}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1800x1200x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  const port = await freePort();
  const nativePort = await freePort();
  const driver = spawn('tauri-driver', ['--port', String(port), '--native-port', String(nativePort), '--native-driver', '/usr/bin/WebKitWebDriver'], {
    env: appEnv(display),
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const close = () => {
    driver.kill();
    xvfb.kill();
  };
  try {
    await waitForHttp(`${base}/status`, 20000);
  } catch (err) {
    close();
    throw err;
  }

  const request = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.value?.error) {
      throw new Error(`WebDriver ${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`.trim());
    }
    return json.value;
  };

  async function openPage() {
    const { sessionId } = await request('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application } } },
    });
    const session = `/session/${sessionId}`;

    async function evaluate(fnOrSource, arg, { timeoutMs = 120000 } = {}) {
      const source = typeof fnOrSource === 'function' ? fnOrSource.toString() : fnOrSource;
      await request('POST', `${session}/timeouts`, { script: timeoutMs });
      // results come back through JSON, like CDP's returnByValue; errors as { error } (with the
      // message first: JavaScriptCore's err.stack doesn't include it)
      const script = `const done = arguments[arguments.length - 1];
        Promise.resolve().then(() => (${source})(${JSON.stringify(arg)}))
          .then((value) => done({ value: value === undefined ? null : value }), (err) => done({ error: String(err) + '\\n' + ((err && err.stack) || '') }));`;
      const out = await request('POST', `${session}/execute/async`, { script, args: [] });
      if (out?.error) throw new Error(out.error);
      return out?.value ?? undefined;
    }

    // WebKitWebDriver supports neither pointer actions nor element clicks in the embedded webview
    // ("unsupported operation"), so the mouse events are dispatched from script. They are not
    // trusted gestures, but the page only needs them to run its first-click audio setup, and the
    // Tauri webview lets audio start without a gesture.
    async function click(x, y) {
      await evaluate(
        ({ x, y }) => {
          const target = document.elementFromPoint(x, y) || document.body;
          for (const type of ['mousedown', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
          }
        },
        { x, y },
      );
    }

    async function send(method) {
      throw new Error(`${method}: the desktop webview has no DevTools protocol`);
    }

    async function closePage() {
      await request('DELETE', session).catch(() => {});
    }

    return { evaluate, click, send, close: closePage, errors: [], warnings: [], consoleErrors: [], engine: 'webkitgtk' };
  }

  return { openPage, close, display };
}
