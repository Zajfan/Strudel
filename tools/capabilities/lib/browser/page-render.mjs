// Renders a pattern offline inside the REPL page through the page's own renderPatternAudio, and
// hands the left channel back to Node. The builder must use page globals only (it is sent as source).
import { parseWavHeader } from '../audio.mjs';
import { decodeFloat32 } from '../measure.mjs';
import { withMiniStrings } from './page-scope.mjs';

// Runs in the page. Kept free of closures over Node scope: it is serialized with toString().
async function renderInPageScript({ builderSource, cps, cycles, sampleRate, samples }) {
  if (typeof globalThis.renderPatternAudio !== 'function') {
    return { missing: 'renderPatternAudio' };
  }
  // Indirect eval runs in global scope, so the builder sees the REPL's evalScope globals.
  const pattern = (0, eval)(`(${builderSource})`)();
  const events = pattern.queryArc(0, cycles).filter((h) => h.hasOnset()).length;

  const renderProto = OfflineAudioContext.prototype;
  const anchorProto = HTMLAnchorElement.prototype;
  const originalStartRendering = renderProto.startRendering;
  const originalClick = anchorProto.click;
  const originalCreateObjectURL = URL.createObjectURL;
  let rendering = null;
  let suppressedDownloads = 0;
  let downloaded = null; // the Blob handed to the download link: the WAV file the user would get
  URL.createObjectURL = function (obj) {
    downloaded = obj;
    return originalCreateObjectURL.call(this, obj);
  };
  renderProto.startRendering = function (...args) {
    const p = originalStartRendering.apply(this, args);
    rendering = p;
    return p;
  };
  anchorProto.click = function (...args) {
    if (this.hasAttribute('download')) {
      suppressedDownloads++;
      return undefined;
    }
    return originalClick.apply(this, args);
  };
  let buffer;
  try {
    await globalThis.renderPatternAudio(pattern, cps, 0, cycles, sampleRate, 128, false, 'probe');
    if (!rendering) throw new Error('renderPatternAudio never called OfflineAudioContext.startRendering');
    buffer = await rendering;
  } finally {
    renderProto.startRendering = originalStartRendering;
    anchorProto.click = originalClick;
    URL.createObjectURL = originalCreateObjectURL;
  }
  let wavHeader = null;
  let wavBytes = null;
  if (downloaded instanceof Blob) {
    const head = new Uint8Array(await downloaded.slice(0, 44).arrayBuffer());
    wavHeader = btoa(String.fromCharCode(...head));
    wavBytes = downloaded.size;
  }

  const left = buffer.getChannelData(0);
  const words = new Uint32Array(left.buffer, left.byteOffset, left.length);
  let hash = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    hash ^= words[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let b64 = null;
  if (samples) {
    const bytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    b64 = btoa(binary);
  }
  return {
    b64,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    events,
    hash: hash.toString(16).padStart(8, '0'),
    suppressedDownloads,
    wavHeader,
    wavBytes,
  };
}

// renderInPage(page, builderFn, { cps, cycles, sampleRate }) → { left, length, sampleRate, hash }, plus
// channels, events (onset haps in [0, cycles)) and suppressedDownloads for diagnostics, and `wav`:
// the parsed header of the WAV file renderPatternAudio offered for download (null if none), with
// its size in bytes.
// `samples: false` skips transferring the audio (left is null); the hash is always computed in the page.
export async function renderInPage(page, builderFn, { cps, cycles, sampleRate = 48000, samples = true, timeoutMs } = {}) {
  const out = await withMiniStrings(page, () =>
    page.evaluate(
      renderInPageScript,
      { builderSource: builderFn.toString(), cps, cycles, sampleRate, samples },
      timeoutMs ? { timeoutMs } : undefined,
    ),
  );
  if (out?.missing) throw new Error(`${out.missing} not in page scope`);
  return {
    left: out.b64 == null ? null : decodeFloat32(out.b64),
    length: out.length,
    sampleRate: out.sampleRate,
    hash: out.hash,
    channels: out.channels,
    events: out.events,
    suppressedDownloads: out.suppressedDownloads,
    wav: out.wavHeader == null ? null : { ...parseWavHeader(Buffer.from(out.wavHeader, 'base64')), fileBytes: out.wavBytes },
  };
}
