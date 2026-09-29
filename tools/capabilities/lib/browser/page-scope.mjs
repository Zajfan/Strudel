// Page scope setup shared by the browser probes.

// Node's loadScope() calls miniAllStrings(), so the shared builders in lib/patterns.mjs may use
// single-quoted mini notation ('<1 2>*4', '~ x ~ ~'). In the page, user code gets mini notation
// from the transpiler (double quotes only) and no global string parser is set. withMiniStrings
// mirrors the Node scope for the duration of `fn` and restores the page default (no string
// parser, the initial state in packages/core/pattern.mjs) afterwards.
export async function withMiniStrings(page, fn) {
  const ok = await page.evaluate(() => {
    if (typeof globalThis.miniAllStrings !== 'function' || typeof globalThis.setStringParser !== 'function') return false;
    globalThis.miniAllStrings();
    return true;
  });
  if (!ok) throw new Error('miniAllStrings/setStringParser not in page scope');
  try {
    return await fn();
  } finally {
    await page.evaluate(() => globalThis.setStringParser(undefined));
  }
}
