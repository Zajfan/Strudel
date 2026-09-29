// Records LIVE REPL playback sample-accurately in the page. An AudioWorklet recorder (loaded from a
// Blob URL) taps superdough's final output node, getSuperdoughAudioController().output.destinationGain
// (the GainNode that feeds context.destination; packages/superdough/superdoughoutput.mjs), so it
// hears the true master mix. Oscillator starts are logged with their context time and frequency so
// callers can locate events in the recording.
import { decodeFloat32 } from '../measure.mjs';

// Runs in the page; serialized with toString(), so it must not close over module scope.
// steps: [{ code, seconds }], evaluated in turn while recording; playback stops afterwards.
async function recordLiveScript({ steps }) {
  // A worklet processor name can be registered once per AudioContext, so each recording gets its own.
  window.__capsRecorderCount = (window.__capsRecorderCount ?? 0) + 1;
  const name = `caps-recorder-${window.__capsRecorderCount}`;
  const RECORDER = `
    class CapsRecorder extends AudioWorkletProcessor {
      constructor() {
        super();
        this.chunks = [];
        this.startFrame = null;
        this.recording = true;
        this.port.onmessage = (e) => {
          if (e.data !== 'dump') return;
          this.recording = false;
          const length = this.chunks.reduce((n, c) => n + c.length, 0);
          const out = new Float32Array(length);
          let at = 0;
          for (const c of this.chunks) { out.set(c, at); at += c.length; }
          this.port.postMessage({ startFrame: this.startFrame, samples: out }, [out.buffer]);
        };
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (this.recording && ch) {
          if (this.startFrame === null) this.startFrame = currentFrame;
          this.chunks.push(ch.slice());
        }
        return true;
      }
    }
    registerProcessor('${name}', CapsRecorder);
  `;
  const ctx = getAudioContext();
  if (ctx.state !== 'running') await ctx.resume();
  const m = window.strudelMirror;
  const protoStart = AudioScheduledSourceNode.prototype.start;
  const starts = [];
  const log = [];
  const onLog = (e) => log.push({ time: ctx.currentTime, message: String(e.detail?.message ?? ''), type: e.detail?.type ?? null });
  let tapSource;
  let recorder;
  let sink;
  const stepResults = [];
  let dump;
  try {
    const url = URL.createObjectURL(new Blob([RECORDER], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    tapSource = getSuperdoughAudioController().output.destinationGain;
    recorder = new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2 });
    // Keep the recorder pulled by the graph without adding anything audible.
    sink = new GainNode(ctx, { gain: 0 });
    tapSource.connect(recorder);
    recorder.connect(sink).connect(ctx.destination);
    AudioScheduledSourceNode.prototype.start = function (when = 0, ...rest) {
      if (this instanceof OscillatorNode) starts.push({ when, now: this.context.currentTime, freq: this.frequency.value });
      return protoStart.call(this, when, ...rest);
    };
    document.addEventListener('strudel.log', onLog);
    for (const step of steps) {
      const at = ctx.currentTime;
      m.setCode(step.code);
      await m.evaluate();
      const errorAfterEval = String(m.repl.state.error || '');
      await new Promise((r) => setTimeout(r, step.seconds * 1000));
      stepResults.push({ at, errorAfterEval, errorAfterWait: String(m.repl.state.error || '') });
    }
    dump = await new Promise((resolve) => {
      recorder.port.onmessage = (e) => resolve(e.data);
      recorder.port.postMessage('dump');
    });
  } finally {
    m.stop();
    document.removeEventListener('strudel.log', onLog);
    AudioScheduledSourceNode.prototype.start = protoStart;
    if (tapSource && recorder) tapSource.disconnect(recorder);
    recorder?.disconnect();
    sink?.disconnect();
  }
  const bytes = new Uint8Array(dump.samples.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return {
    error: stepResults[0]?.errorAfterEval ?? '',
    steps: stepResults,
    log,
    b64: btoa(binary),
    startFrame: dump.startFrame,
    sampleRate: ctx.sampleRate,
    starts,
    tap: 'getSuperdoughAudioController().output.destinationGain',
  };
}

// recordLive(page, code, { seconds }) → { left, startFrame, sampleRate, starts, error, steps, log, tap }.
// `code` is one REPL program, or an array of { code, seconds } steps evaluated in turn while recording
// (steps[k].at is the context time of step k's evaluate; log holds the REPL's strudel.log messages).
// `left` is channel 0 of the master mix; sample i is context frame startFrame + i.
export async function recordLive(page, code, { seconds = 3 } = {}) {
  const steps = Array.isArray(code) ? code : [{ code, seconds }];
  const total = steps.reduce((n, s) => n + s.seconds, 0);
  const out = await page.evaluate(recordLiveScript, { steps }, { timeoutMs: (total + 30) * 1000 });
  return { ...out, left: decodeFloat32(out.b64), b64: undefined };
}
