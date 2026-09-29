# Capability probes

Scoreboard for sub-project #0. Design:
`docs/superpowers/specs/2026-09-28-capability-matrix-design.md`.

Tooling only, not application code. Use Node 22.

```sh
node tools/capabilities/run.mjs --tier cli             # all CLI probes
node tools/capabilities/run.mjs --tier desktop --only BUILD-0
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

Browser probes run in a page, as in `tools/baseline/README.md`. Save their
output as `{ "results": { "<ID>": { status, metrics, notes } } }` and ingest it.
