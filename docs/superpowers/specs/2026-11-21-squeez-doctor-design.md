# Squeez doctor check

Chocolate playbook runs spend their tokens inside a worker CLI. [squeez](https://github.com/claudioemmanuel/squeez) is a hook-based compressor for those CLIs: Claude Code, Copilot CLI, OpenCode, Gemini CLI, Codex CLI, Pi, and Hermes. This slice records whether `squeez doctor` succeeds on the machine that runs the factory. The walk continues either way. Gate evidence stays the full command output the engine already records.

`squeez doctor` prints a report and exits 1 when any check is a FAIL. A WARN still exits 0. The factory stores that exit result. It does not parse the report text.

## Decisions

- The check runs once per playbook attempt, on the first phase of that attempt.
- The factory runs `squeez doctor` with no host flag and no extra arguments. Squeez decides which installed CLIs it inspects.
- A missing binary, a non-zero exit, or a timeout is a line in the attempt log. The phase still runs.
- The status line is `ok`, `failed`, or `unavailable`. `ok` means exit 0. WARN lines can still be in the report file.
- `squeez-doctor.txt` receives the adapter's output string. That string is the captured doctor text, or the timeout or size line when those rules apply. `status.md` gains one single-line entry.
- The probe result is not evidence, not a gate input, and not part of a worker prompt.
- `ShellCommandRunner`, worker commands, and the simulator stay as they are.
- The operator installs Squeez. The factory does not run `squeez setup` and does not install the binary.
- The cockpit lists `squeez-doctor.txt` by name through the existing artifact list. This slice adds no viewer for the file body.

## Architecture

The check lives in the playbook engine. A simulator run never calls it.

`PlaybookRunEngine.runPhase` loads the run and throws if the run is unknown, as it does today. It then ensures the attempt directory, calls `recordSqueezDoctor`, and runs the phase. Any phase can be the first phase of an attempt, including a rework that starts at plan. `recordSqueezDoctor` returns immediately when `status.md` already contains a `- squeez-doctor:` line, so doctor runs once per attempt.

The probe is a port, `SqueezDoctor`. The production adapter runs `squeez doctor` with no shell. Tests pass a fake. `PhaseContext` gains a required `squeez` field. `startServer` passes a `ProcessSqueezDoctor`.

## Components

| Unit | What it does | Depends on |
| --- | --- | --- |
| `SqueezDoctor` | Returns one result: `ok`, `failed`, or `unavailable`, plus the text that goes in the report. | Nothing |
| `ProcessSqueezDoctor` | Runs the configured argv, default `squeez doctor`, with no shell. Maps the process result onto the three statuses. | `squeez` on the server process `PATH` |
| `recordSqueezDoctor` | If the status line is already present, it returns without calling the probe. Otherwise it calls the probe, writes `squeez-doctor.txt`, then appends the status line. | `SqueezDoctor`, the attempt directory |
| `PlaybookRunEngine` | Ensures the attempt directory, calls `recordSqueezDoctor`, then runs the phase. | `PhaseContext.squeez` |

```ts
export type SqueezDoctorStatus = 'ok' | 'failed' | 'unavailable';

export interface SqueezDoctorReport {
  status: SqueezDoctorStatus;
  output: string;
}

export interface SqueezDoctor {
  doctor(): Promise<SqueezDoctorReport>;
}
```

`ProcessSqueezDoctor` accepts `command`, `timeoutMs`, and `maxBuffer`. Production uses `['squeez', 'doctor']`, `15000`, and `1024 * 1024`. The child runs in the server process environment. Its working directory is the server process working directory, because the check describes the operator machine rather than the target repo. The call uses `execFile` and does not invoke a shell.

## Data flow

`DispatchRunEngine` sends a playbook run to `PlaybookRunEngine`. For the attempt's first phase, `recordSqueezDoctor` finds no `- squeez-doctor:` line, calls the probe, and writes two things under `.chocolate/runtime/runs/<runId>/attempt-<N>/`:

| File | Contents |
| --- | --- |
| `status.md` | One new line: `- squeez-doctor: ok`, `failed`, or `unavailable` |
| `squeez-doctor.txt` | The probe text |

The phase then runs as it does today. Later phases of that same attempt see the status line and skip the probe, including when the report file is absent. A rework creates `attempt-<N+1>`, which has no line, so doctor runs once for that attempt too. A process restart mid-attempt reads the line from disk and does not run doctor again.

`GET /api/runs/:id` already returns the attempt's filenames, so both files appear in that list. The probe text is not stored as evidence and is not passed to the gate evaluator or the worker prompt. Test output, git output, and command results stay full.

## Error handling

The adapter classifies in this order. Stdout and stderr are concatenated with no added separator.

| Probe result | Status line | Report file |
| --- | --- | --- |
| `ENOENT` or `EACCES` | `unavailable` | The spawn error message |
| The process exceeds `timeoutMs` | `failed` | `squeez doctor timed out after <timeoutMs>ms` |
| Output exceeds `maxBuffer` | `failed` | `squeez doctor report exceeded <maxBuffer> bytes` |
| Exit 0 | `ok` | The concatenated capture. WARN lines stay in the file. An empty capture stays an empty file. |
| A numeric non-zero exit | `failed` | The concatenated capture. When it is empty, the file is `squeez doctor exited <code>`. |
| Any other error | `unavailable` | The error message |

`ProcessSqueezDoctor` always returns a report. It does not throw. The Node error wrapper is not the report body. The doctor text is.

If `recordSqueezDoctor` still receives a throw from the probe, it writes `unavailable` with that error message and returns. The phase then starts. A failure to write `squeez-doctor.txt` or `status.md` propagates, because the attempt log itself could not be recorded. The report file is written first, then the status line.

## Testing

CI does not run a real `squeez` binary. Tests live in `tests/engine/playbook/squeezDoctor.test.ts` unless a case fits an existing file more tightly.

`recordSqueezDoctor` is tested with a fake probe:

- The first call writes `- squeez-doctor:` and `squeez-doctor.txt` with the probe text.
- A second call on the same directory does not call the probe, including when the report file has been removed.
- A probe that throws still writes `unavailable` and returns.
- `ok`, `failed`, and `unavailable` each land on the matching status line.

`ProcessSqueezDoctor` is tested with a Node script and a short time limit:

- Exit 0 maps to `ok`, and the output is stdout followed by stderr.
- A non-zero exit maps to `failed`. An empty capture uses `squeez doctor exited <code>`.
- A missing executable maps to `unavailable`.
- A script that sleeps past the limit maps to `failed`, and the report is the timeout line.

One engine test builds `PlaybookRunEngine` with a counting fake and calls `runPhase` twice for the same attempt. The first call writes the line and the file. The second call does not call the probe again, whether that phase returns or throws. A fake that returns `failed` still lets the phase finish. A simulator advance creates no `squeez-doctor.txt`.

`tests/engine/playbook/feature.test.ts` and `tests/engine/playbook/bug.test.ts` pass a fake whose `doctor()` returns `{ status: 'ok', output: '' }`. Their existing assertions stay. Phase tests call the phase functions directly and do not gain a probe.

## Out of scope

- Installing Squeez, running `squeez setup`, or adding a config key for the host or the binary path.
- Inferring a host from `workers.default.command` or `workers.implement.command`.
- Piping `ShellCommandRunner` output through `squeez filter`.
- Rendering the report body or the status line in the cockpit.
- Failing a claim, a phase, or a gate because doctor is `failed` or `unavailable`.
