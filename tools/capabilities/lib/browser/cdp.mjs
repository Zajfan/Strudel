// Minimal Chrome DevTools Protocol client: opens a page/tab and exposes evaluate/click/errors.
export async function openPage(port, url) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' });
  const { webSocketDebuggerUrl } = await created.json();

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (err) => reject(err), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const errors = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
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
    if (msg.method === 'Runtime.exceptionThrown') {
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
    const result = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`evaluate timed out after ${timeoutMs} ms`)), timeoutMs),
      ),
    ]);
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

  function close() {
    ws.close();
  }

  return { evaluate, click, errors, close };
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
