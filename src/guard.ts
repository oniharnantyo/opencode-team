/**
 * Shell safety ported from oh-my-zcode's hooks/scripts/guard_hook.py.
 *
 * Two independent decisions:
 *   - findDenyRule(): clearly destructive commands, blocked outright.
 *   - isAutoApprovable(): commands whose every segment is a recognized
 *     read-only / standard test-build invocation, auto-approved at the
 *     permission prompt (opt-in).
 *
 * The denylist is deliberately conservative — a missed exotic beats a false
 * positive blocking legitimate work. Recursive/forced deletes are only blocked
 * when aimed at paths outside any project (/, ~, $HOME).
 */

export interface DenyRule {
  readonly label: string;
  readonly pattern: RegExp;
}

/** A destructive command match, or nothing to object to. */
export function findDenyRule(command: string): DenyRule | undefined {
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) return rule
  }
  return undefined
}

export const DENY_RULES: readonly DenyRule[] = [
  {
    label: "recursive/forced delete at / or ~",
    pattern: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+(--\s+)?(?:\/[\S]*|~\/?[\S]*|\$HOME[\S]*)/i,
  },
  {
    label: "force push",
    pattern: /\bgit\s+push\b[^;&|<>]*(--force\b|--force-with-lease\b|\s-f\b)/i,
  },
  {
    label: "system power/reboot command",
    pattern: /(?<!npm run )(?<!npx )(?<!make )\b(shutdown|reboot|halt|poweroff)\b/i,
  },
  {
    label: "disk destruction",
    pattern: /\bmkfs\b|\bdd\b[^;&|<>]*of=\/dev\/|\bdiskutil\s+erase/i,
  },
  {
    label: "SQL DROP statement",
    pattern: /\bdrop\s+(table|database|schema)\b/i,
  },
  {
    label: "world-writable chmod at /",
    pattern: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i,
  },
  {
    label: "shell history wipe",
    pattern: /\bhistory\s+-c\b|\brm\b[^;&|<>]*\s(\S*\/)?\.?(bash_)?history\b/i,
  },
]

/** Full-match patterns for one command segment. Anything else gets no opinion. */
const ALLOW_RULES: readonly string[] = [
  String.raw`git\s+(status|log|diff|show|branch|remote|rev-parse|describe|ls-files|shortlog|tag|stash\s+list)\b\S*(\s+\S+)*`,
  String.raw`ls(\s+-\w+)*(\s+\S+)*`,
  String.raw`(cat|head|tail|wc|file|stat|pwd|which|whoami|date|env|printenv|tree|du|df)(\s+\S+)*`,
  String.raw`grep(\s+-\w+)*\s+\S+(\s+\S+)*`,
  String.raw`rg(\s+-\w+)*\s+\S+(\s+\S+)*`,
  String.raw`find\s+\S+(\s+(?:-\w+|[^;\s]+))*`,
  String.raw`cd\s+\S+`,
  String.raw`mkdir(\s+-\w+)*\s+\S+(\s+\S+)*`,
  String.raw`(node|python3?|npm|go|cargo|rustc|tsc|java)\s+(--?v\b|--version\b)`,
  String.raw`npm\s+(test|run\s+\S+)(\s+\S+)*`,
  String.raw`npx\s+(jest|vitest|tsc)(\s+\S+)*`,
  String.raw`(python3?\s+-m\s+)?pytest(\s+\S+)*`,
  String.raw`go\s+(test|build|vet)(\s+\S+)*`,
  String.raw`cargo\s+(test|check|build)(\s+\S+)*`,
  String.raw`tsc(\s+\S+)*`,
  String.raw`make\s+(test|check|build|lint)\b\S*(\s+\S+)*`,
]

const ALLOW_MATCHERS: readonly RegExp[] = ALLOW_RULES.map((rule) => new RegExp(`^(?:${rule})$`))

/** Flags that let a would-be-safe command touch more than it claims to. */
const UNSAFE_SUBSTRINGS: readonly string[] = ["-delete", "-exec", "-fprintf", "sudo "]

export function hasRedirectionOrSubstitution(command: string): boolean {
  return /[>`]|\$\(/.test(command)
}

/** Split on shell operators; the port of guard_hook.py's segment split. */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function isSafeSegment(segment: string): boolean {
  const lowered = segment.toLowerCase()
  if (UNSAFE_SUBSTRINGS.some((bad) => lowered.includes(bad))) return false
  return ALLOW_MATCHERS.some((matcher) => matcher.test(segment))
}

/**
 * True when every segment is a recognized safe invocation. Commands with
 * redirects or substitution are never auto-approved, because their effect is no
 * longer visible in the command text.
 */
export function isAutoApprovable(command: string): boolean {
  if (!command.trim()) return false
  if (hasRedirectionOrSubstitution(command)) return false
  const segments = splitSegments(command)
  if (segments.length === 0) return false
  return segments.every(isSafeSegment)
}

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"])
const FALSY = new Set(["0", "false", "no", "off", "disabled"])
const UNEXPANDED_TEMPLATE = /^\$\{.*\}$/

/** Port of guard_hook.py's flag(): tolerant of strings, JSON booleans, templates. */
export function parseToggle(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === "boolean") return value
  const text = String(value).trim().toLowerCase()
  if (!text || UNEXPANDED_TEMPLATE.test(text)) return fallback
  if (TRUTHY.has(text)) return true
  if (FALSY.has(text)) return false
  return fallback
}

/** The shell command inside a tool-call input, across OpenCode tool shapes. */
export function commandOf(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const candidate = (input as { command?: unknown; cmd?: unknown }).command ?? (input as { cmd?: unknown }).cmd
  return typeof candidate === "string" ? candidate : ""
}