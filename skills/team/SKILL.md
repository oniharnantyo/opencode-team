---
name: team
description: Parallel subagent team executor. Use when the user explicitly asks to run a team of subagents or workers in parallel, uses "team N:agent-type" phrasing (e.g. "team 3:executor-medium fix all TypeScript errors"), or asks to fan one goal out across planner/executor/verifier workers on a shared task list. Do not trigger for ordinary tasks a single agent can do directly.
---

# Team — Parallel Subagent Executor

Spawn N coordinated subagents working a shared task list, then verify their work with a
fresh pass. Pipeline: **team-plan → team-exec → team-verify → team-fix (loop) → report**.

## Syntax

- `team 3:executor-medium "fix all TypeScript errors"` — 3 medium-tier executor workers in parallel
- `team "small task"` — you decompose and pick the default team (executors + 1 verifier)
- Worker types: `planner`, `debugger`, `verifier`, `critic`, and `executor` in three complexity tiers — `executor-low`, `executor-medium`, `executor-high` (defined in this plugin's `agents/`; pick a tier per Phase 1)
- Cap the team at **5** workers. Broadcasts are expensive; more workers ≠ faster.

## Rules of the runtime (why the protocol looks like this)

- Workers are **ephemeral and stateless**: they share no memory with you and die when done.
  Every dispatch prompt must be fully self-contained.
- There is **no atomic task claiming**: workers cannot grab work. You pre-assign owners.
- Parallelism comes from dispatching **all worker `subagent` tool calls in one message**. Sequential
  dispatches when tasks are independent are an anti-pattern.
- Never put secrets in worker prompts. Pass file pointers (`src/x.ts:40-80`), not file dumps.

## Phase 0 — Initialize the team workspace

Create the shared state at `.team/` in the project root:

```bash
mkdir -p .team/handoffs && node -e '
const fs = require("fs");
const tasks = [
  { id: "1", title: "Fix null handling in src/a.ts", owner: "executor-medium", status: "pending" },
  { id: "2", title: "Fix imports in src/b.ts", owner: "executor-low", status: "pending" }
];
fs.writeFileSync(".team/state.json", JSON.stringify({
  goal: "<the user goal>",
  status: "active",
  created: new Date().toISOString(),
  tasks: tasks
}, null, 2));
'
```

Task IDs are strings ("1", "2", ...). Schema: `{goal, status: active|done, created, tasks: [{id, title, owner, status}]}`.

## Phase 1 — team-plan

Decompose the goal into **file-scoped subtasks**:

- One file cluster per task; **two tasks must never edit the same file** (workers race).
- 3–6 tasks is the sweet spot; give each task verifiable acceptance criteria
  (a test that can pass, a build that can go green, a grep that can hit).
- Pre-assign each task an `owner` type. For a large goal, dispatch one `planner`
  worker first to produce the decomposition, review it, then continue.
- Pick the executor tier by task complexity:
  - a single obvious edit in one file → `executor-low`
  - a scoped multi-file change with clear criteria → `executor-medium`
  - structural, cross-cutting, or invariant-sensitive work → `executor-high`
  When torn between two tiers, take the higher one.
- Write the plan into `.team/state.json`. Add `.team/` to `.gitignore`.

## Phase 2 — team-exec (parallel dispatch)

Dispatch all workers **in one turn** by invoking the `subagent` tool multiple times.
Each worker prompt must include:

1. The worker's role and its exact task (title, files, acceptance criteria).
2. Context the worker cannot discover cheaply: conventions found, related tests, gotchas.
3. The output contract (below).

While workers run, the plugin's hooks log every dispatch/completion to `.team/log.md`
automatically — consult it if you lose track after a compaction.

**Worker output contract** (put this verbatim in every dispatch prompt):

> End your final message with exactly `STATUS: DONE` or `STATUS: BLOCKED`, then
> **Changes Made** (each with `file:line` references and one-line rationale),
> **Verification** (the actual build/test commands run and their fresh output),
> and a 1–2 sentence **Summary**.

As each worker returns, mark its task done:

```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(".team/state.json", "utf8"));
for (const t of d.tasks) {
  if (t.id === "<task-id>") t.status = "done";
}
fs.writeFileSync(".team/state.json", JSON.stringify(d, null, 2));
'
```

If a worker returns `STATUS: BLOCKED`, do not re-dispatch the same prompt blindly —
read its blocker, adjust the task, or route it to `debugger` in the fix loop.

## Phase 3 — team-verify

After all tasks are done, dispatch **one** `verifier` worker with the acceptance
criteria and how to check them. Verification is a separate pass — **never
self-approve work from your own context**. Accept only `PASS` / `FAIL` /
`INCOMPLETE` with fresh evidence (test output, build exit code, diagnostics).

## Phase 4 — team-fix (loop)

On `FAIL`: dispatch `debugger` (root cause, minimal fix) and/or the same
`executor-<tier>` that owned the failed item, then re-verify. **Max 3 loops**, then
report honestly what still fails and why. A red report is better than a false green one.

## Phase 5 — shutdown

1. Mark the run finished:

```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(".team/state.json", "utf8"));
d.status = "done";
fs.writeFileSync(".team/state.json", JSON.stringify(d, null, 2));
'
```

2. Write a handoff doc at `.team/handoffs/<date>-<slug>.md` — 10–20 lines:
   decisions made, rejected alternatives, risks left behind.
3. Final report to the user: per-task outcome with `file:line` evidence, the
   verification result, and any open items.

## Supporting hooks (installed by this plugin)

| Hook | Team support |
| --- | --- |
| `session.hook("context")` | If `.team/state.json` is active, injects the goal + progress so a session resumes instead of re-planning; dynamically tunes reasoning effort for executor tiers |
| `session.hook("compaction")` | Injects state reminder and replays trailing dispatch log lines after compaction |
| `tool.hook("execute.before")` | Bash guard checks shell commands; logs worker dispatch to `.team/log.md` |
| `tool.hook("execute.after")` | Logs worker completion or error to `.team/log.md`; increments failure count on error |
| `shell.hook("create.before")` | Guards low-level shell commands against destructive patterns |
| `permission.hook("evaluate")` | Blocks destructive commands and auto-approves recognized safe commands (when enabled) |
| `event.subscribe` | Listens for idle session events and logs status reminders |
