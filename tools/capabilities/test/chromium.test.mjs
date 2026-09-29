import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromium } from '../lib/browser/chromium.mjs';

const shell = (root, n) => {
  const dir = join(root, `chromium_headless_shell-${n}`, 'chrome-headless-shell-linux64');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'chrome-headless-shell'), '');
  return join(dir, 'chrome-headless-shell');
};

describe('findChromium', () => {
  it('picks the highest numbered headless shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'caps-pw-'));
    shell(root, 1223);
    const newest = shell(root, 1234);
    mkdirSync(join(root, 'chromium-9999'));
    expect(findChromium(root)).toBe(newest);
  });
  it('returns null when none exists', () => {
    expect(findChromium(mkdtempSync(join(tmpdir(), 'caps-pw-')))).toBeNull();
  });
});
