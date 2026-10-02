# Capability probes

Scoreboard for sub-project #0. Design:
`docs/superpowers/specs/2026-09-28-capability-matrix-design.md`.

Tooling only, not application code. Use Node 22.

```sh
node tools/capabilities/run.mjs --tier cli             # all CLI probes
node tools/capabilities/run.mjs --tier desktop --only BUILD-0
node tools/capabilities/run.mjs --tier browser --only BUILD-0
node tools/capabilities/run.mjs --tier browser --ingest results.json
node tools/capabilities/run.mjs --matrix-only          # regenerate MATRIX.md
```

Each run merges into `results/<date>-<tier>.json` and regenerates `MATRIX.md`
from the newest file per tier. Commit both: they are the evidence.

`--only` rejects an id that isn't a cell of `--tier` (exit code 2, nothing written).

## Merging and provenance

Before writing, the runner carries forward results from the newest existing
`results/*-<tier>.json` file for that tier (any date, not just today's), then
overlays this run's new results on top. Any tier cell still without a result
after that merge is recorded as `{status:'not-run', metrics:{}, notes:{reason:'no
probe yet'}}` — this applies to `--ingest` too.

Every newly produced result (from a probe run or an `--ingest`) gets a `run`
field: `{ ranAt, commit, dirty, thresholds, source: 'probe'|'ingest', node,
platform }`. `thresholds` is a snapshot of the cell's thresholds from
`capabilities.json` at the time the result was produced. `dirty` is true when
`git status --porcelain -- tools/capabilities packages src-tauri` is non-empty.
Carried-forward results keep whatever `run` they already had (or none, for
older files). `MATRIX.md` appends ` ⚠ stale` to a cell whose `run.thresholds`
no longer matches the capability's current thresholds; results without `run`
are never marked stale.

## Writing a probe

Create `probes/<tier>/<ID>.mjs`:

```js
export async function probe({ tier, thresholds, repoRoot, tmpDir, log }) {
  return { status: 'pass', metrics: { headline: 'short summary' }, notes: {} };
}
```

- Statuses: `pass`, `fail`, `wall`, `not-run`. `not-run` never counts as a pass.
- Zero events or zero signal is `fail`.
- `wall` needs `notes.evidence` naming the platform limit, or it becomes `fail`.
- Read limits from `thresholds` (from `capabilities.json`). Never hard-code them.
- Throwing is recorded as `fail`.

## Browser tier

`--tier browser` runs automatically, the same as desktop and cli: it starts a
static server over `website/dist`, launches the Playwright-managed headless
Chromium shell from `~/.cache/ms-playwright`, and drives the REPL over the
Chrome DevTools Protocol (`lib/browser/server.mjs`, `lib/browser/chromium.mjs`,
`lib/browser/cdp.mjs`). Each probe gets a fresh page (already waited for
`window.strudelMirror` and clicked once to unlock audio) via `ctx.page`, plus
`ctx.dist` (`{ path, builtAt, sourceCommit: { sha, committedAt } }`, where
`sourceCommit` is the newest commit touching `packages/` or `website/`). Each
tab is closed (`/json/close/<id>`) after its probe. `ctx.page.errors` holds page
exceptions and error log entries; `ctx.page.warnings` and
`ctx.page.consoleErrors` hold `console.warn`/`console.error` text. The server and
Chromium are started once per run and always closed, even on error. Browser
results' `run` also records `distBuiltAt`.

Browser BUILD-0 does not rebuild: it fails when `website/dist` is older than
the newest source commit. Run `pnpm build` first.

Prerequisites: build the website first (`pnpm build`, producing
`website/dist/index.html`) and have the Playwright Chromium cache installed
(`~/.cache/ms-playwright/chromium_headless_shell-*`). If either is missing,
every browser cell is recorded as `not-run` with a reason naming the missing
prerequisite, instead of failing the whole run.

`--ingest results.json` is still supported for manually produced browser
results (e.g. from `tools/baseline/`, as in `tools/baseline/README.md`).
Save output as `{ "results": { "<ID>": { status, metrics, notes } } }` and
ingest it the same way as before.

## Desktop tier

`--tier desktop` runs the desktop app (src-tauri, Tauri 2) the way users get it: `cargo build
--features custom-protocol` embeds `website/dist`, so build the website first. Probes that export
`usesPage` get a fresh app session through `lib/desktop/harness.mjs`: a private Xvfb display,
`tauri-driver` (a WebDriver server) over `WebKitWebDriver`, and a `page` with the same `evaluate`
and `click` as the browser tier, so most desktop probes re-export the browser probe. Differences
from the browser `page`: no DevTools protocol (`page.send` throws, `page.warnings` stays empty), and
`click` dispatches mouse events from script, because WebKitWebDriver supports neither pointer
actions nor element clicks in the embedded webview.

The app never reaches the user's session: `WAYLAND_DISPLAY` is removed and `GDK_BACKEND=x11` keeps
the window on Xvfb (otherwise GTK opens it on the real Wayland desktop), and
`GST_PLUGIN_FEATURE_RANK=fakeaudiosink:MAX` sends WebKitGTK's audio to a silent GStreamer sink. The app's native audio (the cue) gets `ALSA_CONFIG_PATH` with an extra silent device, `strudel_null`, which the probes select.

Prerequisites: `Xvfb`, `WebKitWebDriver` (WebKitGTK), `tauri-driver` (`cargo install
tauri-driver --locked`), the Tauri 2 Linux libraries (webkit2gtk-4.1, libsoup-3.0), and for
SYNC-1 `aseqdump` (alsa-utils) and an ALSA "Midi Through" port (snd-seq-dummy). Missing harness
prerequisites make the page probes `not-run` with the reason.
