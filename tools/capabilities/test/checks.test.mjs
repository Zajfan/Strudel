import { describe, expect, it } from 'vitest';
import {
  analyzeSteps,
  checkArrangement,
  checkTuning,
  countPastScheduleWarnings,
  duckDrop,
  duckDropAt,
  expectedMinStarts,
  isStemApiName,
  judgeArrangement,
  judgeMix,
  calibrateGain,
  rampTiming,
  judgeStems,
  liveGap,
  locateError,
  RAMP_DETECTION_DB,
  rampWithinNote,
  stemResidual,
} from '../lib/checks.mjs';

const hap = (begin, note) => ({ whole: { begin }, value: { note } });

describe('checkArrangement', () => {
  it('counts wrong sections and events after the end', () => {
    const haps = [hap(0, 60), hap(8, 61), hap(9, 60), hap(64, 60)];
    expect(checkArrangement(haps, { sections: 8, bars: 8 })).toEqual({ eventsInSong: 3, wrongSection: 1, eventsAfterEnd: 1 });
  });
});

describe('checkTuning', () => {
  it('reports the largest deviation in cents', () => {
    const r = checkTuning([{ freq: 220 }, { freq: 440 * Math.pow(2, 2 / 1200) }], [220, 440]);
    expect(r.count).toBe(2);
    expect(r.maxCents).toBeCloseTo(2, 6);
  });
  it('treats a missing frequency as an infinite deviation', () => {
    expect(checkTuning([{}], [220]).maxCents).toBe(Infinity);
  });
  it('treats a count mismatch as an infinite deviation', () => {
    expect(checkTuning([{ freq: 220 }], [220, 440]).maxCents).toBe(Infinity);
  });
});

describe('locateError', () => {
  it('prefers err.loc', () => {
    expect(locateError({ loc: { line: 3, column: 12 }, message: 'x' }, 3)).toEqual({ line: 3, column: 12, source: 'loc' });
  });
  it('falls back to a (line:column) message suffix', () => {
    expect(locateError({ message: 'Unexpected token (2:5)' }, 3)).toEqual({ line: 2, column: 5, source: 'message' });
  });
  it('falls back to the first anonymous stack frame inside the user code, converted to 0-based', () => {
    const stack = 'TypeError: x\n    at eval (eval at f (file.mjs:1:1), <anonymous>:3:78)';
    expect(locateError({ message: 'x', stack }, 3)).toEqual({ line: 3, column: 77, source: 'stack' });
  });
  it('reports stack columns in the same 0-based convention as acorn loc', () => {
    // V8 stack columns are 1-based: `  .notAFunction(2)` throws at 1-based column 4, which is
    // acorn's 0-based column 3 (the `n` after the dot), the value ERROR_CASES expects.
    const stack = 'TypeError: x.notAFunction is not a function\n    at eval (<anonymous>:3:4)';
    expect(locateError({ message: 'x', stack }, 3)).toEqual({ line: 3, column: 3, source: 'stack' });
    expect(locateError({ loc: { line: 3, column: 3 } }, 3).column).toBe(3);
  });
  it('returns null when nothing locates the error', () => {
    expect(locateError({ message: 'x', stack: 'at <anonymous>:9:1' }, 3)).toBeNull();
  });
});

describe('analyzeSteps', () => {
  it('finds onsets on the grid and a rising level', () => {
    const sr = 1600;
    const x = new Float32Array(sr);
    for (let k = 0; k < 16; k++) for (let i = 0; i < 50; i++) x[k * 100 + i] = 0.1 * (k + 1) * (i % 2 ? 1 : -1);
    const r = analyzeSteps(x, sr, { steps: 16, cps: 1 });
    expect(r.maxErrorMs).toBe(0);
    expect(r.increasing).toBe(true);
  });
  it('reports Infinity when an onset is missing', () => {
    expect(analyzeSteps(new Float32Array(1600), 1600, { steps: 16, cps: 1 }).maxErrorMs).toBe(Infinity);
  });
});

describe('duckDrop', () => {
  it('measures the level drop after the trigger in dB', () => {
    const sr = 1000;
    const x = new Float32Array(sr).map((_, i) => (i < 250 ? 1 : 0.5) * (i % 2 ? 1 : -1));
    expect(duckDrop(x, sr, { cps: 1, triggerAt: 0.25 }).dropDb).toBeCloseTo(6.0206, 3);
  });

  it('takes an explicit trigger sample index', () => {
    const sr = 1000;
    const x = new Float32Array(2 * sr).map((_, i) => (i < 1300 ? 1 : 0.25) * (i % 2 ? 1 : -1));
    const r = duckDropAt(x, sr, 1300);
    expect(r.dropDb).toBeCloseTo(12.0412, 3);
    expect(r).toEqual(duckDrop(x, sr, { triggerAt: 1.3 }));
  });
});

describe('rampWithinNote', () => {
  it('is near 0 dB for a constant-amplitude tone', () => {
    const sr = 1000;
    const x = Float32Array.from({ length: sr }, (_, i) => 0.5 * (i % 2 ? 1 : -1));
    expect(rampWithinNote(x, sr, { cps: 1 }).changeDb).toBeCloseTo(0, 6);
  });
  it('reports ~+6.02 dB when the amplitude doubles between the windows', () => {
    const sr = 1000;
    const x = Float32Array.from({ length: sr }, (_, i) => (i < 500 ? 0.25 : 0.5) * (i % 2 ? 1 : -1));
    expect(rampWithinNote(x, sr, { cps: 1 }).changeDb).toBeCloseTo(6.0206, 3);
  });
});

describe('stemResidual', () => {
  it('is -Infinity when stems sum exactly to the mix', () => {
    const a = Float32Array.from([0.5, -0.25]);
    const b = Float32Array.from([0.25, 0.25]);
    expect(stemResidual(Float32Array.from([0.75, 0]), [a, b]).residualDbfs).toBe(-Infinity);
  });
  it('reports the worst sample difference in dBFS', () => {
    expect(stemResidual(Float32Array.from([0.1]), [Float32Array.from([0])]).residualDbfs).toBeCloseTo(-20, 6);
  });
});

describe('RAMP_DETECTION_DB', () => {
  it('is pinned at 3 dB', () => {
    expect(RAMP_DETECTION_DB).toBe(3);
  });
});

describe('isStemApiName', () => {
  it.each(['stems', 'stem', 'renderStems', 'exportStem', 'STEM_EXPORT', 'stem_export', 'stemExport'])('matches %s', (name) => {
    expect(isStemApiName(name)).toBe(true);
  });
  it.each(['system', 'systemTime', 'ecosystem', 'stemmer', 'mastem', 'items'])('does not match %s', (name) => {
    expect(isStemApiName(name)).toBe(false);
  });
});

describe('judgeStems', () => {
  const t = { maxResidualDbfs: -60 };
  const base = { apis: ['x.renderStems'], exercised: true, residualDbfs: -100, eventCount: 10 };
  it('fails with no events', () => {
    expect(judgeStems({ ...base, eventCount: 0 }, t)).toMatchObject({ status: 'fail', error: 'no events rendered' });
  });
  it('fails without the threshold', () => {
    expect(judgeStems(base, {})).toMatchObject({ status: 'fail', error: 'threshold maxResidualDbfs missing' });
  });
  it('fails when no stem API exists', () => {
    expect(judgeStems({ ...base, apis: [] }, t)).toMatchObject({ status: 'fail', error: 'no stem export API' });
  });
  it('is not-run when an API is found but not exercised, however good the residual', () => {
    expect(judgeStems({ ...base, exercised: false }, t)).toEqual({
      status: 'not-run',
      reason: 'stem-like API found but not exercised: x.renderStems',
    });
  });
  it('fails an exercised API whose stems do not sum to the mix', () => {
    expect(judgeStems({ ...base, residualDbfs: -20 }, t)).toMatchObject({ status: 'fail' });
    expect(judgeStems({ ...base, residualDbfs: NaN }, t)).toMatchObject({ status: 'fail' });
  });
  it('passes only an exercised API within the residual', () => {
    expect(judgeStems(base, t)).toEqual({ status: 'pass' });
  });
});

describe('expectedMinStarts', () => {
  it('allows one partial cycle at each end', () => {
    // 60 s at 0.5 cps = 30 cycles; 29 full cycles guaranteed; 64 voices
    expect(expectedMinStarts({ voices: 64, durationS: 60, cps: 0.5 })).toBe(64 * 29);
    expect(expectedMinStarts({ voices: 2, durationS: 10.9, cps: 1 })).toBe(2 * 9);
  });
  it('never goes below zero, and is NaN for missing inputs (fails closed)', () => {
    expect(expectedMinStarts({ voices: 4, durationS: 0.5, cps: 1 })).toBe(0);
    expect(expectedMinStarts({ voices: 4, durationS: 10, cps: undefined })).toBeNaN();
  });
});

describe('countPastScheduleWarnings', () => {
  it("counts superdough's dropped-hap warnings only", () => {
    const warnings = [
      '[superdough]: cannot schedule sounds in the past (target: 1.20, now: 1.25)',
      'something else',
      '[superdough]: Cannot schedule sounds in the past (target: 3.00, now: 3.01)',
    ];
    expect(countPastScheduleWarnings(warnings)).toBe(2);
    expect(countPastScheduleWarnings([])).toBe(0);
  });
});

describe('liveGap', () => {
  // Notes are 100-sample bursts every 150 samples (a 50-sample own gap), starting at sample 20.
  const signal = (length, stopAt = Infinity) =>
    Float32Array.from({ length }, (_, i) => (i >= 20 && i < stopAt && (i - 20) % 150 < 100 ? 0.5 : 0));
  it('finds the pattern own gap before the failure and no excess when playback continues', () => {
    const r = liveGap(signal(1520), { failureIndex: 760 });
    expect(r).toMatchObject({ firstNote: 20, ownGapFrames: 50, longestGapFrames: 50, excessFrames: 0 });
  });
  it('reports the excess when playback stops after the failure', () => {
    const r = liveGap(signal(1520, 920), { failureIndex: 760 });
    expect(r.ownGapFrames).toBe(50);
    // the last burst before sample 920 ends at 870 (770 + 100)
    expect(r.longestGapFrames).toBe(1520 - 870);
    expect(r.excessFrames).toBe(1520 - 870 - 50);
  });
  it('starts the baseline at `from`, ignoring leftover audio before it', () => {
    // leftover sound in [0, 10), then silence until the pattern starts at 20
    const x = signal(1520);
    for (let i = 0; i < 10; i++) x[i] = 0.5;
    expect(liveGap(x, { failureIndex: 760 }).ownGapFrames).toBe(50); // leftover gap (10) < own gap
    const long = signal(1520);
    for (let i = 0; i < 10; i++) long[i] = 0.5;
    for (let i = 20; i < 170; i++) long[i] = 0; // first burst missing: 160-sample hole after the leftover
    expect(liveGap(long, { failureIndex: 760 }).ownGapFrames).toBe(160);
    expect(liveGap(long, { failureIndex: 760, from: 150 })).toMatchObject({ firstNote: 170, ownGapFrames: 50 });
  });
  it('is Infinity (fails closed) when there is no note before the failure', () => {
    expect(liveGap(new Float32Array(1000), { failureIndex: 500 }).excessFrames).toBe(Infinity);
  });
});

describe('judgeArrangement', () => {
  const shape = { sections: 8, bars: 8 };
  const loops = { name: 'arrange()', eventsInSong: 64, wrongSection: 0, eventsAfterEnd: 8 };
  const cut = { name: 'arrange() + filterWhen(t < 64)', eventsInSong: 64, wrongSection: 0, eventsAfterEnd: 0 };
  it('passes when any candidate ends correctly, names it, and records that bare arrange() loops', () => {
    const r = judgeArrangement([loops, cut], shape);
    expect(r.status).toBe('pass');
    expect(r.metrics.headline).toContain('arrange() + filterWhen(t < 64)');
    expect(r.metrics.candidates).toEqual([loops, cut]);
    expect(r.notes.construct).toBe('arrange() + filterWhen(t < 64)');
    expect(r.notes.ergonomics).toMatch(/bare arrange\(\) loops/);
  });
  it('prefers the dedicated arrange().once() and drops the ergonomics note when it works', () => {
    const once = { ...cut, name: 'arrange().once()' };
    const r = judgeArrangement([loops, cut, once], shape);
    expect(r.status).toBe('pass');
    expect(r.notes.construct).toBe('arrange().once()');
    expect(r.notes.ergonomics).toBeUndefined();
  });
  it('fails when every candidate loops, has wrong sections, or is empty', () => {
    const wrong = { ...cut, name: 'b', wrongSection: 3 };
    const empty = { ...cut, name: 'c', eventsInSong: 0 };
    const r = judgeArrangement([loops, wrong, empty], shape);
    expect(r.status).toBe('fail');
    expect(r.notes.error).toContain('arrange()');
  });
  it('fails with no candidates', () => {
    expect(judgeArrangement([], shape).status).toBe('fail');
  });
});

describe('judgeMix', () => {
  const sr = 1000;
  const shape = { duckAt: 0.25, sendWindow: [0.64, 0.7], orbits: [1, 2, 3, 4], ducked: 1, send: 3 };
  const tone = (from, to, level = 0.5) =>
    Float32Array.from({ length: sr }, (_, i) => (i >= from * sr && i < to * sr ? level * (i % 2 ? 1 : -1) : 0));
  const good = () => {
    const ducked = tone(0, 1);
    for (let i = 0.25 * sr; i < 0.3 * sr; i++) ducked[i] *= 0.01;
    const stems = new Map([
      [1, ducked],
      [2, new Float32Array(sr)],
      [3, tone(0.5, 0.75)], // the note plus its delay return
      [4, tone(0.5, 0.6)],
    ]);
    const mix = Float32Array.from({ length: sr }, (_, i) => [...stems.values()].reduce((sum, s) => sum + s[i], 0));
    return { stems, mix, sampleRate: sr };
  };
  it('passes with four buses, a send return on its own bus, and a duck', () => {
    const r = judgeMix(good(), shape, { minDuckDb: 6 });
    expect(r.problems).toEqual([]);
    expect(r.status).toBe('pass');
  });
  it('fails without the duck, the send return, or a bus', () => {
    const noDuck = good();
    noDuck.stems.set(1, tone(0, 1));
    noDuck.mix = tone(0, 1);
    expect(judgeMix(noDuck, shape, { minDuckDb: 6 }).problems.join()).toMatch(/ducking/);
    const noSend = good();
    noSend.stems.set(3, tone(0.5, 0.6));
    expect(judgeMix(noSend, shape, { minDuckDb: 6 }).problems.join()).toMatch(/no delay return/);
    const threeBuses = good();
    threeBuses.stems.delete(4);
    expect(judgeMix(threeBuses, shape, { minDuckDb: 6 }).problems.join()).toMatch(/buses 1,2,3/);
  });
});

describe('rampTiming', () => {
  const sr = 48000;
  const period = 48; // 1 kHz
  const tone = (gainAt, seconds) => Float32Array.from({ length: seconds * sr }, (_, i) => gainAt(i / sr) ** 2 * Math.sin((2 * Math.PI * i) / period));
  // a squared gain law, so the calibration has to do real work
  const steps = 91;
  const calSeconds = 6;
  const calibration = calibrateGain(
    tone((t) => 0.1 + (0.9 * Math.min(steps - 1, Math.floor((t * steps) / calSeconds))) / (steps - 1), calSeconds),
    sr,
    { steps, seconds: calSeconds, from: 0.1, to: 1, period },
  );
  const shape = { begin: 0, duration: 1, from: 0.1, to: 1, period };
  it('measures well under a millisecond for a ramp on time', () => {
    const r = rampTiming(tone((t) => 0.1 + 0.9 * t, 1), sr, shape, calibration);
    expect(r.windows).toBeGreaterThan(900);
    expect(r.maxErrorMs).toBeLessThan(0.3);
  });
  it('measures a ramp 5 ms late as about 5 ms', () => {
    const r = rampTiming(tone((t) => 0.1 + 0.9 * Math.max(0, t - 0.005), 1), sr, shape, calibration);
    expect(r.maxErrorMs).toBeGreaterThan(4.5);
    expect(r.maxErrorMs).toBeLessThan(5.5);
  });
});
