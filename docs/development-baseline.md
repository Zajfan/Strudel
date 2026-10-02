# StrudelLang development baseline

## Scope

Develop Strudel further before considering a NexisLang port. Separate evidence
about language expressiveness, pattern evaluation, audio scheduling, and editor
usability. A passing event snapshot does not establish correct audio playback.

## Reproduction

Use Node 22, as specified by `.nvmrc`. The first inspection used Node 26.7.0;
verification uses the locally available Node 22.22.2. Installed Vitest is 3.2.7.

```sh
pnpm run jsdoc-json
pnpm exec vitest run --reporter=dot
pnpm exec vitest bench packages/mini/bench/mini.bench.mjs --run
pnpm dev
```

Generate `doc.json` before running Vitest directly. The root test script includes
this preparation. Do not update snapshots merely to make the baseline pass.

## Initial findings (2026-09-28)

- Direct Vitest execution before documentation generation: 554 tests passed,
  three failed, and the example suite could not import `doc.json`.
- Three tune tests attempted remote sample-map downloads. The test runtime's
  real Web Audio exports overwrote its earlier sample-loading mock. The final
  evaluation scope now explicitly mocks `samples`, consistent with these tests'
  event-only purpose. Real loading still needs separate integration coverage.
- Removed the ambiguous `--version` argument from the root test script. In the
  installed Vitest, `run --version` actually executes tests; it was not a proven
  cause of missing test execution.
- Mini-notation benchmarks selected step calculation while registering cases.
  Both cases could therefore run under the same final global setting. Each
  measured callback now selects its own setting, and teardown restores it.
- The core pattern, signal, and tune benchmarks have similar global-state
  concerns. Their comparison labels are not yet a trustworthy baseline.
- Existing workspace and lockfile edits predate this work. Build-policy settings
  include placeholder strings and package names in workspace globs; installation
  reproducibility needs a separate check before changing dependencies.

## Verified results

Node 22.22.2, Vitest 3.2.7, Linux x86_64, Intel Core i5-12400:

- Full suite after adding scheduler coverage: **22 files passed, 1,057 tests passed**, exit code 0.
- Focused tune suite: **31 tests passed**. No snapshots were rewritten.
- One obsolete MIDI example snapshot remains reported by Vitest for review.
- Corrected mini benchmark: step calculation enabled mean **7.8558 ms**
  (128 samples, RME ±1.53%); disabled **8.3043 ms**
  (121 samples, RME ±2.87%). These include parsing, pattern construction,
  querying and setting the mode. Other checks ran concurrently: these are
  preliminary observations, not a speedup claim or a regression threshold.
- `git diff --check` passed.
- Prettier check passed for all changed files.

## Production and browser validation (2026-09-28)

- **Production build passed**, exit code 0: 77 pages in 606.57 seconds, including
  the generated service worker and 255 precache entries. The installed Astro
  version is 5.18.2. The build ran through its local CLI under Node 22 after
  documentation generation from the initial baseline.
- The first development launch failed with `listen EPERM` inside the sandbox.
  With local binding allowed, Astro reported ready at `127.0.0.1:4321` after
  126 seconds. HTTP requests during concurrent building stalled, so that launch
  alone did not establish editor usability.
- **The generated production editor loaded and hydrated** in headless Chromium
  151.0.7922.34, served locally with the project's cross-origin isolation headers.
  Browser audio was initialized through its first-mousedown handler.
- **Synth playback passed:** a 48 kHz running AudioContext, 11 scheduled starts,
  zero late starts, minimum scheduling lead 110 ms, nonzero signal in 50/50
  sampled windows, peak window RMS 0.01201, no captured runtime errors.
- **Dense pattern and live replacement passed:** 327 oscillator starts at
  32 notes/second, zero late starts, minimum lead 109.97 ms, no deviation from
  the 31.25 ms scheduled grid, C5 observed after replacing C4, and no further
  starts after stopping. Evaluation of the replacement took 7.72 ms in this run.
- **Sample playback passed:** nine AudioBufferSource starts for the TR-909 kick,
  peak window RMS 0.01954, 28 nonzero windows, no captured runtime errors.
- **Deterministic scheduler tests passed:** a 60-second simulated run validates
  over 1,900 dense events for order, uniqueness, scheduled time, duration and
  positive lead. A second test checks live replacement and stopping.

Repeatable browser probes and raw results are in `tools/baseline/`. These measure
scheduled Web Audio timestamps and signal amplitude, not physical speaker output
or acoustic onset timing. They do not prove absence of all device-level underruns.
The tested scheduler is the default unsynchronized Cyclist; shared-worker sync,
background tabs, mobile browsers, long sessions and heavier loads remain separate
experiments. Playback uses a disposable profile with autoplay permitted and real
external sample banks, not the unit-test audio mocks.

This machine was under substantial existing memory pressure (about 13.8 GiB RAM
used and 16 GiB swap fully used), and the checkout is on a FUSE filesystem. Treat
build/startup duration and one-run performance numbers as environment-specific
observations. Do not infer engine capacity or a performance regression from them.

Build warnings remain: conflicting `density` and `fetchSampleMap` re-exports,
large bundles, upstream `eval` usage, and deprecated glob syntax. They did not
prevent this build; they deserve targeted follow-up rather than blanket changes.

## Musical corpus and next experiments

The existing tune snapshots and generated documentation examples form the first
regression corpus. They exercise musical event structure with audio mocked.
Preserve these expectations while extending the corpus with an arranged piece:
reusable bass, percussion and chord parts; named sections; polymetric rhythms;
seeded variation; and a live section replacement at a cycle boundary.

Before implementation, define the exact expected events and transition behavior.
For a future NexisLang comparison, export backend-independent fixtures containing
rational onset/duration, musical values, seed, tempo, and queried time range.
The existing JavaScript snapshot strings alone are not that portable contract.

Measure pattern query time separately from parsing and construction. Sweep event
density and polyphony, record hardware/runtime and repeated-run distributions,
and verify event counts alongside timings. Then add browser measurements for
scheduler lateness, underruns, live-edit latency, and audio output. Local Node
benchmark timings must not be interpreted as browser audio limits.
