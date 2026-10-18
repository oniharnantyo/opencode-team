import { parseToggle } from "./guard"

/**
 * Plugin options, read from ctx.options (the object form of a `plugins` entry).
 *
 * Both the oh-my-zcode snake_case toggle names and camelCase are accepted, so
 * a config migrated from the ZCode plugin keeps working:
 *
 *   { "package": "opencode-team",
 *     "options": { "bash_guard": false, "auto_approve_safe_commands": true } }
 */
export interface TeamOptions {
  /** Block clearly destructive shell commands. oh-my-zcode: `bash_guard`. */
  readonly bashGuard: boolean
  /**
   * Auto-approve shell calls whose every segment is a recognized read-only /
   * standard test-build command. oh-my-zcode: `auto_approve_safe_commands`.
   * Only enable in trusted projects: test/build commands run project code.
   */
  readonly autoApproveSafeCommands: boolean
  /** Where shared team state lives, relative to the project directory. */
  readonly teamDir: string
  /** Worker cap advertised to the lead and enforced in the skill text. */
  readonly maxWorkers: number
  /** How many trailing .team/log.md lines to replay after a compaction. */
  readonly logTail: number
  /** Inject goal + progress into the model context whenever a run is active. */
  readonly stateReminder: boolean
  /** Nudge once per session when a run goes idle with open tasks. */
  readonly idleNudge: boolean
  /**
   * Copy the bundled worker agents into the project's .opencode/agents/team/
   * on setup. Off by default: plugin startup should not write to a repository.
   * Prefer `npx opencode-team agents`, or turn this on for managed setups.
   */
  readonly installAgents: boolean
}

const DEFAULTS: TeamOptions = {
  bashGuard: true,
  autoApproveSafeCommands: false,
  teamDir: ".team",
  maxWorkers: 5,
  logTail: 10,
  stateReminder: true,
  idleNudge: true,
  installAgents: false,
}

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key]
  }
  return undefined
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function resolveOptions(raw: Record<string, unknown> | undefined): TeamOptions {
  const source = raw ?? {}
  const teamDir = String(pick(source, "team_dir", "teamDir") ?? DEFAULTS.teamDir).trim()
  return {
    bashGuard: parseToggle(pick(source, "bash_guard", "bashGuard"), DEFAULTS.bashGuard),
    autoApproveSafeCommands: parseToggle(
      pick(source, "auto_approve_safe_commands", "autoApproveSafeCommands"),
      DEFAULTS.autoApproveSafeCommands,
    ),
    teamDir: teamDir || DEFAULTS.teamDir,
    maxWorkers: positiveInt(pick(source, "max_workers", "maxWorkers"), DEFAULTS.maxWorkers),
    logTail: positiveInt(pick(source, "log_tail", "logTail"), DEFAULTS.logTail),
    stateReminder: parseToggle(pick(source, "state_reminder", "stateReminder"), DEFAULTS.stateReminder),
    idleNudge: parseToggle(pick(source, "idle_nudge", "idleNudge"), DEFAULTS.idleNudge),
    installAgents: parseToggle(pick(source, "install_agents", "installAgents"), DEFAULTS.installAgents),
  }
}