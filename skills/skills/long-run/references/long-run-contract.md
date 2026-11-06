# Long-running work contract

Provenance: adapted from the pi-harness `long-run` skill (`skills/long-run/SKILL.md`
at commit `5f25692`), archived during the Skill Foundry migration and restored as a
local addition. The workflow below is otherwise unchanged; only its frontmatter was
dropped to fit the bundle standard.

Own one long-running process from launch or attachment through a clear milestone or terminal verdict.

## Boundary

This skill manages agent-side process lifecycle. It does not design application logging, production observability, experiment hypotheses, or build systems. Use `experiment_ledger` separately when comparing pre-registered experimental arms.

## Hard rules

- Define success, failure, readiness, and the observation deadline before launch.
- Launch once, then retain the job/run ID and log location.
- Use managed background tools instead of blocking shell calls or `sleep`/`tail` loops.
- Do not infer success from one log line; use process state, exit status, and required output/milestones.
- A timeout means “not observed within the bound,” not necessarily “process failed.”
- Before relaunching, confirm the original process is dead or intentionally stopped.
- Stop only the owned job/run. Never use a broad process-kill pattern.
- Preserve logs and record the final verdict; do not paste large raw logs into durable memory.

## Choose the manager

| Work type | Preferred manager | Why |
|---|---|---|
| Build, full suite, one-off generator, local server | `bg_run` | Detached command with logs and exit state |
| Training, download, pretokenization, recurring metrics | `run_deck` | Durable run registry, parsed vitals, GPU/process state |
| Externally started tracked run | `run_deck attach` | Register once with log and process pattern |
| Short bounded readiness/milestone wait | `run_deck watch` or managed status polling | Waits without shell sleep loops |
| Periodic idle observation or completion notification | `run_monitor` over `bg_run`/`run_deck` | Edge-triggered checks; terminal edges run `scripts/run-monitor-check.js` without starting a model turn |
| Experiment with pass bars or A/B arms | `experiment_ledger` plus `run_deck` | Preserves pre-registered gates and run linkage |

Use the native manager available in the current harness. If neither exists, use the bounded fallback below.

## Workflow

### 1. Write the run contract

Before launch, state:

- exact command and working directory;
- expected duration class;
- owned outputs and log path;
- readiness or progress milestone;
- terminal success/failure condition;
- bounded observation window;
- cleanup behavior.

For experiments, open or check the experiment ledger before consuming compute. Do not rerun a settled arm.

### 2. Launch or attach

For builds, suites, generators, and servers:

- start with `bg_run` and a descriptive name;
- retain the returned job ID;
- do not start a second copy because status is quiet.

For training/download/pretokenization:

- use `run_deck launch` with a stable name and log path; or
- use `run_deck attach` for an already running process;
- retain the run ID for every later status, note, and finish operation.

### 3. Confirm startup

Make one bounded check that the process is alive or has already exited. For a required near-term milestone, use `run_deck watch` with a specific regular expression and bounded timeout. When the user asks for periodic monitoring over a longer window, start one `run_monitor` for the retained job/run id with an explicit interval, observation deadline, and optional literal milestone text.

Classify the result:

- **started:** alive, no milestone yet;
- **ready/progressing:** required milestone observed and process state consistent;
- **finished:** process exited and terminal evidence is available;
- **failed:** nonzero exit, explicit fatal signal, invalid output, or failed gate;
- **unknown:** manager/log state is insufficient.

### 4. Monitor without busy waiting

On later turns, query `bg_run status/logs` or `run_deck status` once. If `run_monitor` is available and periodic notification was requested, let its edge-triggered timer observe the target and end the turn; terminal edges run the script checker and show its target probe. Its terminal checks are script-backed and never start a model turn. Do not start an automation loop or duplicate the monitor. Report only new, relevant information:

- alive/exit state;
- current step or progress;
- recent loss/throughput/skips/NaN indicators when applicable;
- readiness signal;
- changed resource pressure;
- first actionable error.

Do not emit repeated identical status summaries.

### 5. Conclude

When terminal:

- capture exit status and concise evidence;
- use `run_deck finish` for registered runs with `finished`, `failed`, `killed`, or `shipped` plus useful metrics;
- note partial artifacts and whether they are valid;
- stop the managed job only when requested or clearly required by the run contract;
- report how to inspect retained logs.

## Bounded fallback

If no managed background tool exists:

1. create a task-owned log and exit-status file in a safe temporary or repository runtime directory;
2. launch exactly one background process and record its PID;
3. check PID, exit-status file, and a bounded log tail together;
4. use increasing polling intervals and a fixed deadline;
5. stop only that recorded PID;
6. clearly report that lifecycle guarantees are degraded.

Do not use an unbounded `while`, `watch`, or repeated `sleep; tail` loop.

## Tool failure fallback

- Invalid launch arguments: correct the manager request; do not switch immediately to shell.
- Missing log: verify the configured path and process state before relaunching.
- Watch timeout: call status; classify as alive/unknown/terminal rather than failed by assumption.
- Truncated logs: request the manager's bounded log tail or spill artifact.
- Stale process match on attach: verify the specific PID/log pairing before accepting it.

## Output contract

```markdown
## Long Run: <name>
- Manager/ID: ...
- Command scope: ...
- Contract: milestone=...; deadline=...; success=...
- State: started | progressing | ready | finished | failed | unknown
- Latest evidence: ...
- Exit/verdict: ...
- Logs/artifacts: ...
- Next observation or cleanup: ...
```

## Anti-patterns

- Blocking on a full build or suite in an ordinary command call
- Polling with shell `sleep`, `tail`, and `nvidia-smi` compounds
- Launching duplicate jobs after a quiet interval
- Declaring success from log text while the process is still failing
- Treating a bounded watch timeout as a process failure
- Killing by executable name or broad pattern rather than owned ID
- Recording raw logs or secrets in durable notes
