// Puts Strudel's pattern functions on globalThis once, like the REPL does.
import { evalScope } from '@strudel/core';
import { miniAllStrings } from '@strudel/mini';

let loaded;

export function loadScope() {
  loaded ??= evalScope(
    import('@strudel/core'),
    import('@strudel/mini'),
    import('@strudel/tonal'),
    import('@strudel/xen'),
  ).then(() => miniAllStrings());
  return loaded;
}
