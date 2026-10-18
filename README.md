# opencode-team

[![npm version](https://img.shields.io/npm/v/opencode-team.svg)](https://www.npmjs.com/package/opencode-team)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Parallel subagent team executor plugin for [OpenCode](https://opencode.ai) — ported from `oh-my-zcode` 0.4.0 and the `/team` orchestration architecture.

`opencode-team` equips OpenCode with coordinated multi-agent pipelines, safety guard hooks, structured team state tracking, and specialized worker agents.

---

## Architecture Overview

```
                      ┌──────────────────────┐
                      │    Lead Agent / TUI  │
                      └──────────┬───────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
      Phase 1: Plan       Phase 2: Exec       Phase 3: Verify
      [planner]         [executor-low]          [verifier]
                        [executor-medium]            │
                        [executor-high]              ▼
                                 │            Phase 4: Fix Loop
                                 │              [debugger]
                                 ▼
                     Shared State & Logging
                   .team/state.json & log.md
```

1. **Phase 0 — Initialize Workspace**: Sets up `.team/state.json` and `.team/handoffs/`.
2. **Phase 1 — team-plan**: Decomposes goals into 3–6 file-scoped subtasks with pre-assigned worker tiers. No two workers touch the same file.
3. **Phase 2 — team-exec**: Dispatches worker subagents in parallel (multi-tool calls in a single turn). Hooks log dispatch/return events automatically.
4. **Phase 3 — team-verify**: Dedicated `verifier` runs fresh build/test evidence and produces a `PASS` / `FAIL` verdict.
5. **Phase 4 — team-fix**: On failure, routes blockers to `debugger` and executor for up to 3 bounded fix loops.
6. **Phase 5 — shutdown**: Marks run complete and writes an architectural handoff document in `.team/handoffs/`.

---

## Features

- **Coordinated Team Skill (`team`) & Slash Command (`/team`)**: Run `team 3:executor-medium "fix TypeScript errors"` or `/team <goal>`.
- **7 Bundled Worker Agents** (`mode: subagent`):
  - `planner`: File-scoped task decomposition with verifiable acceptance criteria.
  - `executor-low`: Fast, single-file edits with minimal reasoning overhead.
  - `executor-medium`: Scoped multi-file changes with clear criteria.
  - `executor-high`: Invariant-heavy, structural changes with deep reasoning.
  - `debugger`: Root-cause isolation and minimal green-build fixes.
  - `verifier`: Evidence-based verification gate (no self-approval).
  - `critic`: Adversarial review of plans and code diffs before acceptance.
- **Safety Guards (Bash Guard)**:
  - Hooks `tool.execute.before`, `shell.create.before`, and `permission.evaluate`.
  - Blocks destructive commands: `rm -rf /` or `~`, git force-push (`--force`, `-f`), system power commands (`reboot`, `shutdown`), raw disk writes (`mkfs`, `dd of=/dev/`), SQL `DROP TABLE/DATABASE`, world-writable `chmod -R 777 /`, and shell history wipes.
  - Optional auto-approval for safe read/test commands (`git status`, `ls`, `cat`, `npm test`, `pytest`, `cargo test`, `go test`, `tsc`).
- **Dynamic Reasoning Effort**: Automatically tunes `reasoningEffort` to `"low"` for `executor-low` and `"high"` for `executor-high`.
- **State & Compaction Resilience**: Injects `.team/state.json` reminders and replays trailing dispatch history (`.team/log.md`) after context compaction.
- **CLI Binary (`opencode-team`)**: Inspect status, stream logs, and install agents into `.opencode/agents/`.

---

## Installation & Configuration

### 1. Configure in `opencode.json` / `opencode.jsonc`

Add `opencode-team` to your plugins array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-team",
      "options": {
        "bashGuard": true,
        "autoApproveSafeCommands": false,
        "teamDir": ".team",
        "maxWorkers": 5,
        "logTail": 10,
        "stateReminder": true,
        "idleNudge": true,
        "installAgents": false
      }
    }
  ]
}
```

For a local checkout or development:

```jsonc
{
  "plugins": [
    "./path/to/opencode-team"
  ]
}
```

### 2. Options Reference

Both camelCase and oh-my-zcode `snake_case` keys are supported for backward compatibility:

| Option | Snake_case Key | Default | Description |
| --- | --- | --- | --- |
| `bashGuard` | `bash_guard` | `true` | Block destructive shell commands |
| `autoApproveSafeCommands` | `auto_approve_safe_commands` | `false` | Auto-approve recognized read/test commands |
| `teamDir` | `team_dir` | `".team"` | Relative directory for team state and logs |
| `maxWorkers` | `max_workers` | `5` | Maximum recommended concurrent workers |
| `logTail` | `log_tail` | `10` | Number of recent dispatch log lines to replay after compaction |
| `stateReminder` | `state_reminder` | `true` | Inject active goal and progress into context |
| `idleNudge` | `idle_nudge` | `true` | Log reminders when a run goes idle with open tasks |
| `installAgents` | `install_agents` | `false` | Copy bundled agents into `.opencode/agents/` on startup |
| `models` | `agent_models` | `{}` | Model overrides per worker agent (e.g. `{"executor-low": "openai/gpt-4o-mini"}`) |

---

### 3. Configuring Agent Models

You can configure models for the team worker agents in three flexible ways:

#### Option A: Inside Plugin Options (`opencode.json` / `opencode.jsonc`)

Override models directly under the plugin configuration:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-team",
      "options": {
        "models": {
          "planner": "anthropic/claude-3-7-sonnet",
          "executor-low": "openai/gpt-4o-mini",
          "executor-medium": "anthropic/claude-3-7-sonnet",
          "executor-high": "anthropic/claude-3-7-sonnet",
          "debugger": "anthropic/claude-3-7-sonnet",
          "verifier": "anthropic/claude-3-7-sonnet",
          "critic": "anthropic/claude-3-7-sonnet"
        }
      }
    }
  ]
}
```

#### Option B: OpenCode Top-Level `agents` Block (`opencode.json`)

OpenCode natively allows configuring model, system prompt, or options for any agent:

```jsonc
{
  "agents": {
    "executor-low": {
      "model": "openai/gpt-4o-mini"
    },
    "executor-high": {
      "model": "anthropic/claude-3-7-sonnet"
    }
  }
}
```

#### Option C: Agent Markdown Frontmatter (`.opencode/agents/<name>.md`)

Specify `model` directly in the frontmatter of any agent definition:

```yaml
---
name: executor-low
description: Fast implementation worker
mode: subagent
model: openai/gpt-4o-mini
---
```

## Worker Agents

Worker agent files are located in `agents/` and can be discovered automatically or copied into `.opencode/agents/`:

| Agent | Complexity | Mode | Role |
| --- | --- | --- | --- |
| `planner` | Planning | subagent | Decomposes goals into non-overlapping file tasks |
| `executor-low` | Low reasoning | subagent | Trivial 1-file edits, fast verification |
| `executor-medium` | Standard | subagent | Scoped multi-file changes with tests |
| `executor-high` | High reasoning | subagent | Structural, architecture-adjacent changes |
| `debugger` | Diagnostic | subagent | Root-cause analysis, stack trace isolation |
| `verifier` | Read-only | subagent | Independent validation with fresh command evidence |
| `critic` | Adversarial | subagent | Pre-commit quality gate reviewing plans and diffs |

To install the bundled agents into your project's `.opencode/agents/` directory:

```bash
npx opencode-team agents --install
```

---

## CLI Usage

The `opencode-team` binary provides quick insight into ongoing team runs:

```bash
# Check current team progress and open tasks
opencode-team status

# View recent dispatch and completion logs
opencode-team log 20

# List bundled worker agents
opencode-team agents

# Install worker agents into .opencode/agents/
opencode-team agents --install

# Initialize a new team workspace
opencode-team init "Migrate authentication to JWT"
```

---

## Development & Testing

```bash
# Install dependencies
bun install

# Run test suite
bun test

# Type check
bun run typecheck
```

---

## License

[MIT](LICENSE) © Oni Harnantyo
