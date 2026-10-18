import { existsSync } from "node:fs"
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const STAMP_TURN_START = ".turn-start"
export const STAMP_USER_PROSE = ".user-prose"
export const STAMP_LAST_EXTRACTION = ".last-extraction"
export const LOCK_NAME = ".extract.lock"
export const MEMORY_LOG_NAME = ".extract.log"
export const LOCK_STALE_SECONDS = 600
export const MIN_PROSE_WORDS = 3

export async function readStamp(root: string, name: string): Promise<string> {
  try {
    const content = await readFile(join(root, name), "utf8")
    return content.trim()
  } catch {
    return ""
  }
}

/**
 * Stamps turn start epoch and user prose flag.
 */
export async function stampTurn(root: string, promptText: string): Promise<void> {
  const epoch = Math.floor(Date.now() / 1000)
  const words = promptText.trim().split(/\s+/).filter(Boolean)
  const hasProse = words.length >= MIN_PROSE_WORDS ? "1" : "0"

  try {
    await writeFile(join(root, STAMP_TURN_START), String(epoch), "utf8")
    await writeFile(join(root, STAMP_USER_PROSE), hasProse, "utf8")
  } catch {
    // Stamping failure is non-fatal
  }
}

/**
 * Stand-down gate: true if a *.md was modified after .turn-start,
 * meaning the agent already wrote a memory this turn.
 */
export async function mainAgentSavedThisTurn(root: string): Promise<boolean> {
  const stamp = await readStamp(root, STAMP_TURN_START)
  const turnStart = Number.parseInt(stamp.split(/\s+/)[0] ?? "", 10)
  if (!Number.isFinite(turnStart) || turnStart <= 0) {
    return true // Missing or invalid stamp -> conservative skip
  }

  try {
    const files = await readdir(root)
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      try {
        const fileStat = await stat(join(root, file))
        const mtimeSec = Math.floor(fileStat.mtimeMs / 1000)
        if (mtimeSec > turnStart) {
          return true
        }
      } catch {
        // Skip inaccessible file
      }
    }
  } catch {
    return true
  }

  return false
}

/**
 * Lock gate: true when .extract.lock holds an epoch younger than 600s.
 */
export async function isExtractionRunning(root: string): Promise<boolean> {
  const stamp = await readStamp(root, LOCK_NAME)
  const tokens = stamp.split(/\s+/)
  if (tokens.length === 0 || !tokens[tokens.length - 1]) return false

  const epoch = Number.parseInt(tokens[tokens.length - 1]!, 10)
  if (!Number.isFinite(epoch)) return false

  const now = Math.floor(Date.now() / 1000)
  return now - epoch < LOCK_STALE_SECONDS
}

export interface GateEvaluation {
  canExtract: boolean
  reason?: string
}

/**
 * Evaluates all gates prior to triggering memory extraction.
 */
export async function checkExtractionGates(root: string): Promise<GateEvaluation> {
  // 1. Recursion sentinel
  if (process.env.OPENCODE_MEMORY_EXTRACTOR === "1" || process.env.OMK_MEMORY_EXTRACTOR === "1") {
    return { canExtract: false, reason: "recursion sentinel set" }
  }

  // 2. Memory root must exist
  if (!existsSync(root)) {
    return { canExtract: false, reason: "memory root directory does not exist" }
  }

  // 3. User prose check
  const userProse = await readStamp(root, STAMP_USER_PROSE)
  if (userProse !== "1") {
    return { canExtract: false, reason: "user prompt had fewer than 3 prose words" }
  }

  // 4. Stand-down gate (agent already saved memory this turn)
  if (await mainAgentSavedThisTurn(root)) {
    return { canExtract: false, reason: "main agent already modified memory this turn" }
  }

  // 5. Concurrency lock gate
  if (await isExtractionRunning(root)) {
    return { canExtract: false, reason: "extraction currently running" }
  }

  return { canExtract: true }
}

export async function acquireLock(root: string): Promise<void> {
  const epoch = Math.floor(Date.now() / 1000)
  await writeFile(join(root, LOCK_NAME), `${process.pid} ${epoch}`, "utf8")
}

export async function releaseLock(root: string): Promise<void> {
  try {
    await unlink(join(root, LOCK_NAME))
  } catch {
    // If unlink fails, overwrite with 0 so it expires immediately
    await writeFile(join(root, LOCK_NAME), "0", "utf8").catch(() => {})
  }
}

export async function touchLastExtraction(root: string): Promise<void> {
  const epoch = Math.floor(Date.now() / 1000)
  await writeFile(join(root, STAMP_LAST_EXTRACTION), String(epoch), "utf8").catch(() => {})
}
