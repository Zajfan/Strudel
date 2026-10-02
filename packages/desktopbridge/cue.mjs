// The desktop app's cue (headphone) output. WebKitGTK can't play on a second device, so the cue mix
// is streamed to the Rust backend (src-tauri/src/audio/cue.rs), which plays it with cpal on the
// chosen device. Registered as superdough's cue output provider when running in Tauri; until the
// VersaTone engine replaces this native backend (docs/superpowers/plans/2026-10-02-native-desktop-audio.md).
import { Invoke } from './utils.mjs';
import { setCueOutputProvider } from '@strudel/webaudio';

// frames per chunk sent to Rust: ~23 ms at 44.1 kHz, so ~43 calls a second
const CHUNK_FRAMES = 1024;

const TAP_PROCESSOR = `
class StrudelCueTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(${CHUNK_FRAMES} * 2);
    this.frames = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const left = input[0];
    if (!left) return true;
    const right = input[1] ?? left;
    for (let i = 0; i < left.length; i++) {
      this.chunk[this.frames * 2] = left[i];
      this.chunk[this.frames * 2 + 1] = right[i];
      if (++this.frames === ${CHUNK_FRAMES}) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(${CHUNK_FRAMES} * 2);
        this.frames = 0;
      }
    }
    return true;
  }
}
registerProcessor('strudel-cue-tap', StrudelCueTap);
`;

const loadedContexts = new WeakSet();
async function loadTap(audioContext) {
  if (loadedContexts.has(audioContext)) return;
  const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'application/javascript' }));
  try {
    await audioContext.audioWorklet.addModule(url);
    loadedContexts.add(audioContext);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// the system default, as superdough names it, is no particular device for Rust
const deviceArg = (name) => (name && name !== 'System Standard' ? name : null);

function createNativeCueOutput(audioContext) {
  const destination = new GainNode(audioContext, { channelCount: 2, channelCountMode: 'explicit' });
  let device = null;
  let tap;
  let silent;
  let closed = false;
  const start = () => Invoke('cue_start', { device: deviceArg(device), sampleRate: audioContext.sampleRate, channels: 2 });
  let started = start().catch((err) => console.error('[cue] could not start the native cue output', err));
  loadTap(audioContext)
    .then(() => {
      if (closed) return;
      tap = new AudioWorkletNode(audioContext, 'strudel-cue-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      tap.port.onmessage = (e) => {
        // a raw body: interleaved little-endian f32
        Invoke('cue_write', new Uint8Array(e.data.buffer)).catch(() => {});
      };
      destination.connect(tap);
      // the tap must be pulled by the graph to run, without being heard
      silent = new GainNode(audioContext, { gain: 0 });
      tap.connect(silent).connect(audioContext.destination);
    })
    .catch((err) => console.error('[cue] could not load the cue tap', err));
  return {
    destination,
    async setDevice(name) {
      device = name;
      await started;
      await Invoke('cue_stop');
      started = start();
      await started;
    },
    disconnect() {
      closed = true;
      destination.disconnect();
      tap?.disconnect();
      silent?.disconnect();
      Invoke('cue_stop').catch(() => {});
    },
  };
}

export const nativeCueProvider = {
  available: () => true,
  create: createNativeCueOutput,
  listDevices: async () => ['System Standard', ...(await Invoke('cue_devices'))],
};

setCueOutputProvider(nativeCueProvider);
