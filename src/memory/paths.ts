import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, resolve } from "node:path"
import { join } from "node:path"

export const MEMORY_INDEX_NAME = "MEMORY.md"

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

export function projectKey(projectDir: string): string {
  const abs = resolve(projectDir)
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16)
  return `${slugify(basename(abs))}-${hash}`
}

/**
 * Returns the project memory directory path.
 * Checks for an existing ~/.kiro/memories/projects/... directory first for backward compatibility,
 * otherwise defaults to ~/.opencode/memories/projects/<slug>-<hash16>/memory.
 */
export function resolveMemoryRoot(projectDir: string, customBaseDir?: string): string {
  const key = projectKey(projectDir)
  const home = homedir()

  if (customBaseDir) {
    return resolve(customBaseDir, key, "memory")
  }

  // Check if ~/.kiro memory already exists for this project (backward compatibility)
  const kiroPath = join(home, ".kiro", "memories", "projects", key, "memory")
  if (existsSync(kiroPath)) {
    return kiroPath
  }

  return join(home, ".opencode", "memories", "projects", key, "memory")
}

/**
 * Creates and returns the project memory root directory.
 */
export async function ensureMemoryRoot(projectDir: string, customBaseDir?: string): Promise<string> {
  const root = resolveMemoryRoot(projectDir, customBaseDir)
  await mkdir(root, { recursive: true })
  return root
}
