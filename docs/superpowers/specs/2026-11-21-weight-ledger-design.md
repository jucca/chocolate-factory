# Playbook weight ledger

Chocolate Factory playbook runs shell out to an opaque worker with a short `prompt.md`. The factory never sees model tokens or a price. [token-optimizer](https://github.com/alexgreensh/token-optimizer) measures and compresses context inside Claude Code, Cursor, and similar hosts. Its Cursor hooks do not observe background workers, and its license is PolyForm Noncommercial. This design does not vendor that code, install those hooks, or change prompts, worker commands, or gates.

It adds a display-only weight ledger. Each worker dispatch records how much text the factory handed the worker, how large the report and worktree diff were, and how long the call took. The cockpit shows one score:

`weight = (prompt + report + diff) / 1024 + seconds`

The formula id is `kib-plus-seconds-v1`. The cockpit prints that formula next to the numbers. The score is not tokens and not dollars.

## Decisions

- Record at dispatch time into the existing runtime SQLite database. One row per `WorkerPort.run`, including an implement-to-default fallback.
- Roll a phase attempt up by summing its dispatch weights. Roll a run up by summing those same weights. Do not add phase wall-clock time on top.
- A missing measurement stores null and stays out of the sums. The ledger never substitutes a zero to mean "unknown".
- Simulator runs do not dispatch workers, so their ledger is empty.
- Weight is not evidence and does not affect spec, plan, verify, or commit.
- Existing runs are not backfilled.

## Architecture

The server wraps the playbook `WorkerPort` in `RecordingWorker`, outside `dispatchWorker`. Phase code still calls `dispatchWorker`. Every `port.run` becomes one sample. A path that is not `.chocolate/runtime/runs/<runId>/attempt-<n>` (a unit directory under that attempt still matches) writes no row. The run id and attempt come from that path. The phase is the run's current phase in SQLite at the start of the call. A missing run row writes no sample.

Stored fields: `id` (UUID), `run_id`, `attempt`, `phase`, `unit_id`, `role`, `prompt_bytes`, `report_bytes`, `diff_bytes`, `duration_ms`, `weight`, `formula_id`, `created_at` (ISO-8601, same clock style as the other run tables). Byte counts and `duration_ms` are integers. `weight` is a real number. Unknown measurements are SQL NULL.

Measurements around that one call:

- Prompt bytes are the UTF-8 length of `task.prompt`.
- Report bytes are the byte length of `worker-report.md` when that file exists and can be read. When the file is absent, report bytes are the UTF-8 length of the report notes, or `0` when the notes are empty.
- Diff bytes are taken before the call: the byte length of `git diff --binary HEAD`, plus the on-disk sizes of untracked, non-ignored files. Parallel dispatches each see the worktree at their own start.
- Duration is that call's monotonic wall clock, in milliseconds. The formula divides it by 1000.

When prompt bytes, report bytes, diff bytes, and duration are all numbers, `weight = (prompt_bytes + report_bytes + diff_bytes) / 1024 + duration_ms / 1000`. Otherwise `weight` is null. `formula_id` is always `kib-plus-seconds-v1` on rows this version writes.

## Components

- `src/engine/playbook/weight.ts` is pure. It computes `kib-plus-seconds-v1` or returns null when any required input is null.
- `src/engine/playbook/worktreeWeight.ts` measures diff bytes in a repo and returns null when git fails. It counts streamed diff bytes and file sizes. It does not add methods to `GitPort`.
- `src/engine/playbook/recordingWorker.ts` implements `WorkerPort`. It measures, calls the inner worker, and inserts one sample. It depends on the inner port, the run store, and `worktreeWeight`.
- `SqliteRunStore` gains a `weight_samples` table plus insert and list-by-run. Rows live in `.chocolate/runtime/`.
- `GET /api/runs/:id` adds the weight block below. `RunDetail` is the only surface that renders it. The roadmap, gates, and worker commands do not read it.

The server constructs `new RecordingWorker(new ProcessWorker(...), store, measureDiff)`.

Weight block:

```ts
{
  formulaId: 'kib-plus-seconds-v1';
  formula: 'weight = (prompt + report + diff) / 1024 + seconds';
  total: number | null;
  phases: { attempt: number; phase: string; total: number | null; sampleCount: number }[];
  samples: {
    id: string;
    attempt: number;
    phase: string;
    unitId: string;
    role: 'default' | 'implement';
    promptBytes: number;
    reportBytes: number | null;
    diffBytes: number | null;
    durationMs: number | null;
    weight: number | null;
  }[];
}
```

`total` is the sum of sample weights whose formula id is `kib-plus-seconds-v1` and whose weight is present. It is null when no such weight exists. Each phase entry groups one attempt and phase. Its `sampleCount` includes null-weight samples. Its `total` sums only present weights in that group, and is null when the group has none.

The run page shows the formula, the run total, one subtotal per phase attempt, and one row per dispatch with attempt, phase, unit, role, the four inputs, and the weight. A null input or a null weight reads "unmeasured". A null subtotal or run total reads "unmeasured". An empty sample list reads "No worker dispatches". A simulator run takes that empty state. A null total is not shown as `0`.

## Data flow

1. A playbook advance enters the phase, which calls `dispatchWorker` with the server's `RecordingWorker`.
2. Parse `runId` and `attempt` from the attempt directory. Read `phase` from the run row. Insert nothing when the path does not parse or the run row is missing.
3. Measure diff bytes. A git failure continues with a null diff.
4. Time the inner `ProcessWorker.run`. That writes `prompt.md`, runs the configured command, and reads `worker-report.md`. The prompt string and the command are unchanged.
5. Measure report bytes and duration. Compute weight. Insert the sample.
6. Return the inner report untouched.

An implement spawn failure calls `port.run` again with role `default`. That second call is a second sample. The phase then writes evidence and reaches the same gate as today.

## Error handling

- Git cannot measure the diff: store the sample with `diff_bytes` and `weight` null. The inner report is returned as usual.
- `worker-report.md` exists but cannot be read: `report_bytes` and `weight` are null. Do not substitute the notes string.
- No report file: use the notes byte length, or `0` when the notes are empty.
- The run directory is not an attempt path, or the run row is missing: insert nothing and return the inner report.
- The inner worker throws: store a sample for the time already spent, apply the same report-byte rules, then rethrow. Report bytes are `0` only when no report file was written and the notes are empty.
- The SQLite insert throws: let it propagate. A failed ledger write fails the phase the same way a failed event write does.
- A negative monotonic duration stores null `duration_ms` and null `weight`.
- Rollups add only `kib-plus-seconds-v1` samples with a present weight. A null-weight sample stays visible and stays out of the sum.
- Parallel dispatches insert independently. There is no shared worktree snapshot.

## Testing

Existing playbook phase tests stay on a plain worker port and must still pass.

- `weight.ts` returns the formula result for known inputs, returns `0` when every input is `0`, and returns null when any required input is null.
- `worktreeWeight.ts`, in a temporary git repo, returns `0` on a clean tree. After a tracked edit, it returns the byte length of `git diff --binary HEAD` for that repo. An untracked non-ignored file adds that file's on-disk size. Git failure returns null.
- `RecordingWorker` inserts one sample for an attempt-directory task, copies prompt and report byte lengths, stores `kib-plus-seconds-v1`, and returns the inner report unchanged. A non-attempt path inserts nothing. A thrown inner worker still inserts, then the exception propagates. A diff failure stores a null weight and still returns the report.
- `dispatchWorker` through the wrapper records two samples when the implement role fails to spawn and the default role runs.
- The run-detail API returns the formula id, the samples, phase-attempt sums, and the run total. Null-weight samples are listed and excluded from the sums. A run with no samples returns an empty list and a null total.

The run page is checked in the browser on a playbook run that has samples and on a simulator run that has none.

## Out of scope

- Parsing worker stdout, Cursor `state.vscdb`, or Claude session files.
- Compressing prompts, capping logs, or rewriting `explore.md` and CI logs.
- Token counts, prices, savings headlines, and host-plugin install steps.
- A composite that mixes a second formula into the same total.
- Putting weight on the roadmap or using it as a gate.
