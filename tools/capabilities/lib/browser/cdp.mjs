// Minimal Chrome DevTools Protocol client: opens a page/tab and exposes evaluate/click/errors.
const DEFAULT_SEND_TIMEOUT_MS = 30000;

const OPEN_TIMEOUT_MS = 15000;

// Closes a DevTools target (tab) by id and waits for Chromium to acknowledge it.
async function closeTarget(port, targetId) {
  const res = await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, { signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) });
  await res.text();
}

export async function openPage(port, url) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
  });
  const { id: targetId, webSocketDebuggerUrl } = await created.json();

  const ws = new WebSocket(webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP websocket did not open within ${OPEN_TIMEOUT_MS} ms`)), OPEN_TIMEOUT_MS);
      ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true });
      ws.addEventListener('error', (err) => (clearTimeout(timer), reject(err)), { once: true });
    });
  } catch (err) {
    // The tab exists even though we could not attach to it: close it so it does not leak.
    ws.close();
    await closeTarget(port, targetId).catch(() => {});
    throw err;
  }

  let nextId = 1;
  const pending = new Map();
  const errors = [];
  // console.warn / console.error text from the page. superdough reports dropped (past-due) haps only
  // with a console.warn, so probes that score late starts need the warnings.
  const warnings = [];
  const consoleErrors = [];

  // Every CDP call is bounded: a per-call timer is cleared as soon as the call settles (by
  // response or by the ws closing), so a slow/never-answered call can't keep the event loop
  // alive after the caller has moved on. `evaluate` overrides the default with its own timeoutMs.
  const send = (method, params = {}, timeoutMs = DEFAULT_SEND_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'CDP error'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params?.type === 'warning' || msg.params?.type === 'error')) {
      const text = (msg.params.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ');
      (msg.params.type === 'warning' ? warnings : consoleErrors).push(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const desc = msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text;
      errors.push(String(desc ?? 'unknown exception'));
    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      errors.push(String(msg.params.entry.text ?? 'unknown log error'));
    }
  });

  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed'));
    pending.clear();
  });

  await Promise.all([send('Runtime.enable'), send('Log.enable'), send('Page.enable')]);

  async function evaluate(fnOrSource, arg, { timeoutMs = 120000 } = {}) {
    const source = typeof fnOrSource === 'function' ? fnOrSource.toString() : fnOrSource;
    const expression = `(${source})(${JSON.stringify(arg)})`;
    let result;
    try {
      result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    } catch (err) {
      if (err instanceof Error && err.message === `CDP Runtime.evaluate timed out after ${timeoutMs} ms`) {
        throw new Error(`evaluate timed out after ${timeoutMs} ms`);
      }
      throw err;
    }
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(desc);
    }
    return result.result?.value;
  }

  async function click(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // Closes the tab (not just our connection to it), then the socket.
  async function close() {
    try {
      await closeTarget(port, targetId);
    } finally {
      ws.close();
    }
  }

  return { evaluate, click, send, errors, warnings, consoleErrors, close, targetId };
}

export async function waitForRepl(page, timeoutMs = 60000) {
  const start = Date.now();
  while (true) {
    const ready = await page.evaluate(() => !!window.strudelMirror);
    if (ready) break;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForRepl timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.click(5, 5);
}
