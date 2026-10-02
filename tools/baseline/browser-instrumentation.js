window.__baseline = { errors: [], contexts: [], starts: [], analysers: [] };
addEventListener('error', (e) => __baseline.errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => __baseline.errors.push(String(e.reason)));
const AC = window.AudioContext;
window.AudioContext = class extends AC {
  constructor(...args) {
    super(...args);
    __baseline.contexts.push(this);
  }
};
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (destination, ...args) {
  if (destination instanceof AudioDestinationNode) {
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 2048;
    connect.call(this, analyser);
    __baseline.analysers.push(analyser);
  }
  return connect.call(this, destination, ...args);
};
for (const C of [OscillatorNode, AudioBufferSourceNode]) {
  const start = C.prototype.start;
  C.prototype.start = function (when, ...args) {
    __baseline.starts.push({ when, now: this.context.currentTime, type: C.name });
    return start.call(this, when, ...args);
  };
}
