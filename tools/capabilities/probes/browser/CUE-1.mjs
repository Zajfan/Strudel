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
async function cueInPage({ code, seconds, device }) {
  if (typeof setCueDevice !== 'function') return { missing: 'setCueDevice' };
  const native = window.__TAURI_INTERNALS__;
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
  await setCueDevice(device);
  // desktop: also keep what the native backend hands to the device
  if (native) await native.invoke('cue_capture', { start: true });
  const recorder = new AudioWorkletNode(ctx, name, { numberOfInputs: 2, numberOfOutputs: 1 });
  const sink = new GainNode(ctx, { gain: 0 });
  const mainTap = controller.output.destinationGain;
  // the cue mix: the provider's destination itself if it passes audio on (native), else the stream
  // the browser's <audio> element plays
  const cueTap =
    cueOutput.destination.numberOfOutputs > 0
      ? cueOutput.destination
      : new MediaStreamAudioSourceNode(ctx, { mediaStream: cueOutput.destination.stream });
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
    cueTap.disconnect(recorder);
    recorder.disconnect();
    sink.disconnect();
  }
  const b64 = (samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  let device_ = null;
  if (native) {
    // interleaved stereo f32 of the blocks the device played; the left channel is enough
    const bytes = new Uint8Array(await native.invoke('cue_capture', { start: false }));
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const left = all.filter((_, i) => i % 2 === 0);
    const stats = await native.invoke('cue_stats');
    device_ = { left: b64(left), stats };
  }
  return {
    sampleRate: ctx.sampleRate,
    main: b64(recorded[0]),
    cue: b64(recorded[1]),
    device: device_,
  };
}

export async function probe({ page }) {
  const notes = {
    code: CODE,
    scope: 'headless Chromium, one fake output device: the cue stream is verified, a second physical device is not',
  };
  // a cue needs an output on another device: the browser's <audio> + setSinkId, or a native one
  const engine = await page.evaluate(async () => ({
    canCue: typeof canCue === 'function' ? canCue() : null,
    setSinkId: typeof HTMLMediaElement.prototype.setSinkId,
    native: !!window.__TAURI_INTERNALS__,
    // listed only for the native cue: the browser's listing asks for the microphone (device labels)
    devices: window.__TAURI_INTERNALS__ && typeof getCueDevices === 'function' ? await getCueDevices() : [],
  }));
  if (!engine.canCue) {
    return {
      status: 'wall',
      metrics: { setSinkId: engine.setSinkId, headline: 'no cue output in this engine' },
      notes: {
        ...notes,
        evidence: `HTMLMediaElement.prototype.setSinkId is ${engine.setSinkId} and no native cue output is registered, so nothing can play on a second device`,
      },
    };
  }
  // desktop: the silent ALSA device the harness provides, so the cue isn't heard on the speakers
  const device = engine.native ? 'strudel_null' : 'System Standard';
  if (engine.native && !engine.devices.includes(device)) {
    return { status: 'not-run', metrics: { devices: engine.devices }, notes: { ...notes, reason: `no "${device}" device for a silent native cue (see the desktop harness)` } };
  }
  const out = await page.evaluate(cueInPage, { code: CODE, seconds: SECONDS, device }, { timeoutMs: (SECONDS + 60) * 1000 });
  if (out.missing) return { status: 'fail', metrics: { headline: `no ${out.missing}` }, notes: { ...notes, error: `no ${out.missing} in the page` } };
  if (out.error) return { status: 'fail', metrics: {}, notes: { ...notes, error: out.error } };
  const main = decodeFloat32(out.main);
  const cue = decodeFloat32(out.cue);
  const level = (samples) => ({ main: toneDb(samples, out.sampleRate, MAIN_FREQ), cue: toneDb(samples, out.sampleRate, CUE_FREQ) });
  const onMain = level(main);
  const onCue = level(cue);
  const onDevice = out.device ? level(decodeFloat32(out.device.left)) : null;
  const metrics = {
    mainOutput: onMain,
    cueOutput: onCue,
    separationOnMainDb: onMain.main - onMain.cue,
    separationOnCueDb: onCue.cue - onCue.main,
    ...(out.device && { deviceOutput: onDevice, separationOnDeviceDb: onDevice.cue - onDevice.main, deviceStats: out.device.stats }),
    recordedSamples: main.length,
  };
  metrics.headline = `cue ${metrics.separationOnMainDb.toFixed(0)} dB below main on the main output, main ${metrics.separationOnCueDb.toFixed(0)} dB below cue on the cue`;
  const fail = (error) => ({ status: 'fail', metrics, notes: { ...notes, error } });
  if (!(onMain.main > PRESENT_DB)) return fail('the main pattern is missing from the main output');
  if (!(onCue.cue > PRESENT_DB)) return fail('the cued pattern is missing from the cue output');
  if (!(metrics.separationOnMainDb >= MIN_SEPARATION_DB)) return fail(`the cued pattern is audible on the main output (${metrics.separationOnMainDb.toFixed(1)} dB)`);
  if (!(metrics.separationOnCueDb >= MIN_SEPARATION_DB)) return fail(`the main pattern leaks into the cue (${metrics.separationOnCueDb.toFixed(1)} dB)`);
  if (out.device) {
    if (!(onDevice.cue > PRESENT_DB)) return fail('the native cue output played no cue on the device');
    if (!(metrics.separationOnDeviceDb >= MIN_SEPARATION_DB)) return fail(`the main pattern leaks into the device cue (${metrics.separationOnDeviceDb.toFixed(1)} dB)`);
  }
  return { status: 'pass', metrics, notes };
}
