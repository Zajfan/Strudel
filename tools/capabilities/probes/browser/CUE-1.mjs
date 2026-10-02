// CUE-1 (browser, opt): a pattern with .cue() plays on the cue (headphone) output and not on the main
// output. Live playback of a main pattern (C3) and a cued one (A5) is recorded from two taps at once:
// the main mix (superdough's destinationGain, which feeds the speakers) and the cue MediaStream itself
// (read back into the context), i.e. exactly what the cue's <audio> element plays. Headless Chromium
// has a single fake output device, so routing the cue to a second physical device is checked only as
// far as setSinkId accepting the device choice.
import { decodeFloat32, toneDb } from '../../lib/measure.mjs';

const MAIN_FREQ = 440 * Math.pow(2, (48 - 69) / 12); // c3
const CUE_FREQ = 440 * Math.pow(2, (81 - 69) / 12); // a5
const CODE = '$: note("c3*4").s("sine").gain(0.3)\n$: note("a5*4").s("sine").gain(0.3).cue()';
const SECONDS = 3;
const MIN_SEPARATION_DB = 40;
// a pattern counts as present on an output above this level (averaged over the recording, which is
// mostly the gaps between short notes; the noise floor is near -100 dB)
const PRESENT_DB = -60;

// Runs in the page; serialized with toString(), so no closures over Node scope.
async function cueInPage({ code, seconds }) {
  if (typeof setCueDevice !== 'function') return { missing: 'setCueDevice' };
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const controller = getSuperdoughAudioController();
  if (typeof controller.getCueOutput !== 'function') return { missing: 'cue output' };
  window.__capsCueCount = (window.__capsCueCount ?? 0) + 1;
  const name = `caps-cue-recorder-${window.__capsCueCount}`;
  const source = `
    class R extends AudioWorkletProcessor {
      constructor() { super(); this.chunks = [[], []]; this.on = true;
        this.port.onmessage = () => { this.on = false; this.port.postMessage(this.chunks.map((c) => {
          const out = new Float32Array(c.reduce((n, x) => n + x.length, 0)); let at = 0;
          for (const x of c) { out.set(x, at); at += x.length; } return out; })); }; }
      process(inputs) { if (this.on) inputs.forEach((input, k) => input[0] && this.chunks[k].push(input[0].slice())); return true; }
    }
    registerProcessor('${name}', R);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const cueOutput = controller.getCueOutput();
  await setCueDevice('System Standard');
  const recorder = new AudioWorkletNode(ctx, name, { numberOfInputs: 2, numberOfOutputs: 1 });
  const sink = new GainNode(ctx, { gain: 0 });
  const mainTap = controller.output.destinationGain;
  const cueTap = new MediaStreamAudioSourceNode(ctx, { mediaStream: cueOutput.destination.stream });
  mainTap.connect(recorder, 0, 0);
  cueTap.connect(recorder, 0, 1);
  recorder.connect(sink).connect(ctx.destination);
  const m = window.strudelMirror;
  let recorded;
  try {
    m.setCode(code);
    await m.evaluate();
    const error = String(m.repl.state.error || '');
    if (error) return { error };
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    recorded = await new Promise((resolve) => {
      recorder.port.onmessage = (e) => resolve(e.data);
      recorder.port.postMessage('dump');
    });
  } finally {
    m.stop();
    mainTap.disconnect(recorder);
    cueTap.disconnect();
    recorder.disconnect();
    sink.disconnect();
  }
  const b64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  return {
    sampleRate: ctx.sampleRate,
    main: b64(recorded[0]),
    cue: b64(recorded[1]),
    sinkId: cueOutput.audio.sinkId,
    cuePlaying: !cueOutput.audio.paused,
  };
}

export async function probe({ page }) {
  const notes = {
    code: CODE,
    scope: 'headless Chromium, one fake output device: the cue stream is verified, a second physical device is not',
  };
  const out = await page.evaluate(cueInPage, { code: CODE, seconds: SECONDS }, { timeoutMs: (SECONDS + 60) * 1000 });
  if (out.missing) return { status: 'fail', metrics: { headline: `no ${out.missing}` }, notes: { ...notes, error: `no ${out.missing} in the page` } };
  if (out.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: out.error } };
  const main = decodeFloat32(out.main);
  const cue = decodeFloat32(out.cue);
  const level = (samples) => ({ main: toneDb(samples, out.sampleRate, MAIN_FREQ), cue: toneDb(samples, out.sampleRate, CUE_FREQ) });
  const onMain = level(main);
  const onCue = level(cue);
  const metrics = {
    mainOutput: onMain,
    cueOutput: onCue,
    separationOnMainDb: onMain.main - onMain.cue,
    separationOnCueDb: onCue.cue - onCue.main,
    cuePlaying: out.cuePlaying,
    sinkId: out.sinkId,
    recordedSamples: main.length,
  };
  metrics.headline = `cue ${metrics.separationOnMainDb.toFixed(0)} dB below main on the main output, main ${metrics.separationOnCueDb.toFixed(0)} dB below cue on the cue`;
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (!(onMain.main > PRESENT_DB)) return fail('the main pattern is missing from the main output');
  if (!(onCue.cue > PRESENT_DB)) return fail('the cued pattern is missing from the cue output');
  if (!(metrics.separationOnMainDb >= MIN_SEPARATION_DB)) return fail(`the cued pattern is audible on the main output (${metrics.separationOnMainDb.toFixed(1)} dB)`);
  if (!(metrics.separationOnCueDb >= MIN_SEPARATION_DB)) return fail(`the main pattern leaks into the cue (${metrics.separationOnCueDb.toFixed(1)} dB)`);
  if (!out.cuePlaying) return fail('the cue <audio> element is not playing');
  return { status: 'pass', metrics, notes };
}
