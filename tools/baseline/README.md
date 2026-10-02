# Browser baseline probes

Manual instrumentation for a **disposable browser profile**, not application code.
These probes replace the editor buffer and play quiet audio. They measure Web Audio
API scheduling and output amplitude; they cannot verify physical speaker output,
DAC timing, or every possible audio underrun.

1. Build the website with Node 22 (`pnpm build`). Serve `website/dist` on localhost
   with `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: credentialless`, matching `website/astro.config.mjs`.
2. Load the editor and wait until `window.strudelMirror` exists. Before the first
   mouse interaction, execute `browser-instrumentation.js` in the browser console.
   It records contexts, scheduled source starts, errors, and destination analysers.
3. Click the page once to initialize audio. Execute `browser-audio.js` and await
   its returned promise. It checks a five-second synthesized melody. Expect a
   running context, positive RMS, scheduled starts, no late starts, and no errors.
4. Execute `browser-stress.js` and await its result. It runs 32 notes per second
   for ten seconds, replacing C4 with C5 halfway through. Check the event count,
   lead times, grid deviation, new pitch, no starts after stop, and errors.
5. Execute `browser-samples.js` and await its result. It plays TR-909 kick samples
   for four seconds. Expect sample starts and nonzero RMS without errors. This
   requires the default external sample banks to be reachable.
6. Close the disposable browser. The instrumentation modifies native prototypes;
   reload before any uninstrumented measurement. Run scripts sequentially, once
   per fresh profile for directly comparable results.

The probes return observations, not automated pass/fail gates. Inspect error
arrays and confirm nonzero event counts; a zero-event run is not a timing pass.
`browser-stress.js` reports whether the scheduler uses a shared worker. The recorded
baseline uses the default, unsynchronized Cyclist scheduler; it does not establish
cross-tab synchronization accuracy.

For deterministic scheduler assertions without a browser:

```sh
pnpm exec vitest run packages/core/test/cyclist.test.mjs
```

See `docs/development-baseline.md` for the measured results and limitations.
