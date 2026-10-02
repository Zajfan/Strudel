import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as core from '@strudel/core';
import * as mini from '../index.mjs';

// the intrinsic SyntaxError, whatever the global binding is (tests share globals: isolate is off)
const NativeSyntaxError = (() => {
  try {
    Function('(');
  } catch (err) {
    return err.constructor;
  }
})();

describe('mini in the eval scope', () => {
  it('does not replace JavaScript built-ins', async () => {
    // from a fresh realm, since other test files have already put Strudel exports on globalThis
    const builtins = runInNewContext('Object.getOwnPropertyNames(globalThis)');
    expect(Object.keys(mini).filter((name) => builtins.includes(name))).toEqual([]);

    await core.evalScope(core, mini);
    expect(globalThis.SyntaxError).toBe(NativeSyntaxError);
  });

  it('exports the parser error as MiniSyntaxError', () => {
    expect(mini.MiniSyntaxError).toBeTypeOf('function');
    expect(() => mini.parse('"a [b"')).toThrow(mini.MiniSyntaxError);
  });
});
