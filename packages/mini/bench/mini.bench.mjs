import { describe, bench } from 'vitest';

import { calculateSteps } from '../../core/index.mjs';
import { mini } from '../index.mjs';

describe('mini', () => {
  bench(
    '+tactus',
    () => {
      calculateSteps(true);
      mini('a b c*3 [c d e, f g] <a b [c d?]>').fast(64).firstCycle();
    },
    { time: 1000 },
  );

  bench(
    '-tactus',
    () => {
      calculateSteps(false);
      mini('a b c*3 [c d e, f g] <a b [c d?]>').fast(64).firstCycle();
    },
    { time: 1000, teardown: () => calculateSteps(true) },
  );
});
