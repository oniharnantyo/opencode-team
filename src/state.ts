import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Shared team state, ported from oh-my-zcode's hooks/scripts/hook.py.
 *
 * `.team/state.json` is the single source of truth for a run; `.team/log.md` is
 * the append-only dispatch ledger. Every helper here is best-effort: a broken or
 * missing state file must never break the session.
 */

export const STATE_NAME = "state.json"
export const LOG_NAME = "log.md"
export const LOG_MAX_BYTES = 512 * 1024

export type TaskStatus = "pending" | "active" | "done"

export interface TeamTask {
  id: string
  title: string
  owner: string
  status: TaskStatus
  files?: string[]
  acceptance?: string
}

export interface TeamState {
  goal: string
  status: "active" | "done"
  created: string
  tasks: TeamTask[]
  failures?: number
}

export interface Progress {
  done: number
  open: TeamTask[]
  total: number
}

export function teamDirPath(projectDir: string, teamDir: string): string {
  return join(projectDir, teamDir)
}

export async function readState(teamDir: string): Promise<TeamState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(teamDir, STATE_NAME), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const state = parsed as Partial<TeamState>
    return { ...state, tasks: Array.isArray(state.tasks) ? state.tasks : [] } as TeamState
  } catch {
    return undefined
  }
}

export async function writeState(teamDir: string, state: TeamState): Promise<void> {
  await mkdir(teamDir, { recursive: true })
  await writeFile(join(teamDir, STATE_NAME), `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

/** Read-modify-write of state.json. Returns the state it wrote, if any. */
export async function mutateState(
  teamDir: string,
  mutate: (state: TeamState) => void,
): Promise<TeamState | undefined> {
  const state = await readState(teamDir)
  if (!state) return undefined
  mutate(state)
  await writeState(teamDir, state)
  return state
}

/** True while a run is active — the guard used by every team hook. */
export async function activeState(teamDir: string): Promise<TeamState | undefined> {
  const state = await readState(teamDir)
  return state?.status === "active" ? state : undefined
}

export async function appendLog(teamDir: string, line: string): Promise<void> {
  try {
    await mkdir(teamDir, { recursive: true })
    const path = join(teamDir, LOG_NAME)
    try {
      const info = await stat(path)
      if (info.size > LOG_MAX_BYTES) await rename(path, `${path}.1`)
    } catch {
      // No log yet, or it cannot be rotated: appending still works.
    }
    await appendFile(path, `${line.replace(/\n+$/, "")}\n`, "utf8")
  } catch {
    // Logging is never allowed to break a session.
  }
}

export async function readLogTail(teamDir: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(join(teamDir, LOG_NAME), "utf8")
    const kept = text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
    return kept.slice(-lines)
  } catch {
    return []
  }
}

export function progressOf(state: TeamState): Progress {
  const done = state.tasks.filter((task) => task.status === "done")
  return { done: done.length, open: state.tasks.filter((task) => task.status !== "done"), total: state.tasks.length }
}

export function taskLabel(task: TeamTask): string {
  return `#${task.id ?? "?"} (${task.owner ?? "?"}) ${task.title ?? ""}`.trim()
}

export function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function dateStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function slug(text: string, max = 48): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (cleaned || "handoff").slice(0, max).replace(/-+$/, "")
}

/** The mid-session reminder: goal, progress, open task IDs, and where to look next. */
export function reminderText(state: TeamState, teamDir: string): string {
  const { done, open, total } = progressOf(state)
  const lines = [
    `[opencode-team] Active team run — ${state.goal || "(no goal recorded)"}`,
    `Progress: ${done}/${total} tasks done.`,
  ]
  if (open.length > 0) lines.push(`Open: ${open.map(taskLabel).join("; ")}`)
  lines.push(
    `Continue the team workflow (team skill) from ${teamDir}/${STATE_NAME} — do not re-plan; ` +
      `the dispatch history is in ${teamDir}/${LOG_NAME}.`,
  )
  return lines.join("\n")
}

export function summaryText(state: TeamState): string {
  const { done, open, total } = progressOf(state)
  const rows = state.tasks.map((task) => `  - [${task.status}] ${taskLabel(task)}`)
  return [
    `status: ${state.status}`,
    `goal: ${state.goal || "(none)"}`,
    `progress: ${done}/${total} done`,
    open.length > 0 ? `open: ${open.map((task) => task.id).join(", ")}` : "open: none",
    state.failures ? `failures: ${state.failures}` : undefined,
    ...rows,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

const STATUS_PATTERN = /STATUS:\s*(DONE|BLOCKED)/

/** Pull the worker's output contract line out of a subagent result. */
export function extractStatus(text: string): string {
  const match = STATUS_PATTERN.exec(text)
  return match?.[1] ?? "no STATUS line found"
}

/** Flatten a subagent tool result into text for STATUS extraction. */
export function flattenResult(result: unknown): string {
  if (typeof result === "string") return result
  if (!result || typeof result !== "object") return ""
  const value = result as { content?: unknown; output?: unknown; metadata?: unknown }
  const parts: string[] = []
  if (typeof value.content === "string") parts.push(value.content)
  else if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      if (typeof entry === "string") parts.push(entry)
      else if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
        parts.push(String((entry as { text: unknown }).text))
      }
    }
  }
  if (typeof value.output === "string") parts.push(value.output)
  if (typeof value.metadata === "object" && value.metadata !== null) {
    const message = (value.metadata as { message?: unknown }).message
    if (typeof message === "string") parts.push(message)
  }
  return parts.join("\n")
}

/** Which worker a `subagent` tool call is dispatching, across input shapes. */
export function workerOf(input: unknown): string {
  if (!input || typeof input !== "object") return "agent"
  const source = input as Record<string, unknown>
  for (const key of ["agentID", "agent_id", "agent", "subagent_type", "agent_type", "subagent"]) {
    const value = source[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return "agent"
}

/** One-line label for a dispatch, preferring the caller's own description. */
export function taskLabelOf(input: unknown): string {
  if (!input || typeof input !== "object") return "(no description)"
  const source = input as Record<string, unknown>
  const description = source.description
  if (typeof description === "string" && description.trim()) return description.trim().slice(0, 160)
  const prompt = source.prompt
  if (typeof prompt === "string") {
    const first = prompt.trim().split("\n")[0]
    if (first) return first.slice(0, 160)
  }
  return "(no description)"
}

/** First line of whatever the runtime reported as the failure. */
export function failureText(error: unknown): string {
  if (!error) return "(no error detail)"
  if (typeof error === "string") return firstLine(error)
  if (typeof error === "object") {
    const source = error as Record<string, unknown>
    for (const key of ["message", "name", "type"]) {
      const value = source[key]
      if (typeof value === "string" && value.trim()) return firstLine(value)
    }
  }
  return "(no error detail)"
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? ""
  return line.slice(0, 160) || "(no error detail)"
}