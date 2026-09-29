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
