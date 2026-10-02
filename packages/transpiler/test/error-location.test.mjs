import { beforeAll, describe, it, expect } from 'vitest';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { evaluate } from '../index.mjs';

beforeAll(() => core.evalScope(core, mini));

async function errorOf(code) {
  try {
    await evaluate(code);
  } catch (err) {
    return err;
  }
  throw new Error('expected evaluation to fail');
}

// lines are 1-based, columns 0-based, like acorn's syntax error locations
describe('runtime error locations', () => {
  it('locates a call to an unknown method in the user code', async () => {
    const err = await errorOf('const x = { a: 1 }\nx\n  .notAFunction(2)\n');
    expect(err).toBeInstanceOf(TypeError);
    expect(err.loc).toEqual({ line: 3, column: 3 });
    expect(err.message).toMatch(/notAFunction.*\(3:3\)$/);
  });

  it('locates an unknown variable inside a mini-notation chain', async () => {
    const err = await errorOf('note("c e g")\n  .s("sine")\n  .fast(nope)\n');
    expect(err).toBeInstanceOf(ReferenceError);
    expect(err.loc).toEqual({ line: 3, column: 8 });
  });

  it('locates an error thrown inside a user callback', async () => {
    const err = await errorOf("[1, 2].map((v) => {\n  throw new Error('bad ' + v)\n})\n");
    // the stack is captured where the Error is constructed
    expect(err.message).toBe('bad 1 (2:8)');
    expect(err.loc).toEqual({ line: 2, column: 8 });
  });

  it('points at the user call site when the error is thrown inside library code', async () => {
    const err = await errorOf("const n = 1\n\nJSON.parse('{')\n");
    // by name: evalScope(mini) replaces the global SyntaxError with the mini parser's
    expect(err.name).toBe('SyntaxError');
    expect(err.loc).toEqual({ line: 3, column: 5 });
  });

  it('locates a mini-notation parse error', async () => {
    const err = await errorOf('note("c e g")\n  .fast("<1 2")\n');
    expect(err.message).toMatch(/^\[mini\] parse error: .* \(2:13\)$/);
    // the closing quote, where the parser expected a '>'
    expect(err.loc).toEqual({ line: 2, column: 13 });
  });

  it('keeps acorn locations for syntax errors', async () => {
    const err = await errorOf('a\n  .b(800 +)\n');
    expect(err.name).toBe('SyntaxError');
    expect(err.loc).toMatchObject({ line: 2, column: 10 });
    expect(err.message).toBe('Unexpected token (2:10)');
  });
});
