import { readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MEMORY_INDEX_NAME } from "./paths"

export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryEntry {
  name: string
  description: string
  type: MemoryType
  content: string
  title?: string
}

export interface MemoryItem {
  name: string
  filename: string
  path: string
  description: string
  type: MemoryType
  content: string
}

const EXTRACTION_MARKER = ".last-extraction"
const SECONDS_PER_DAY = 86400

/**
 * Calculates days since last extraction.
 */
export async function daysSinceLastExtraction(root: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(root, EXTRACTION_MARKER), "utf8")
    const epoch = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10)
    if (!Number.isFinite(epoch) || epoch <= 0) return undefined
    const now = Math.floor(Date.now() / 1000)
    return Math.max(0, Math.floor((now - epoch) / SECONDS_PER_DAY))
  } catch {
    return undefined
  }
}

/**
 * Reads MEMORY.md if present.
 */
export async function readMemoryIndex(root: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(root, MEMORY_INDEX_NAME), "utf8")
    return content.trim() ? content : undefined
  } catch {
    return undefined
  }
}

/**
 * Formats the memory index context block for session context injection.
 */
export async function formatMemoryContext(root: string): Promise<string | undefined> {
  const index = await readMemoryIndex(root)
  if (!index) return undefined

  const indexPath = join(root, MEMORY_INDEX_NAME)
  const days = await daysSinceLastExtraction(root)
  const ageNotice =
    days === undefined
      ? "Auto-capture has not run for this project yet."
      : `Memory last updated ${days} day(s) ago by auto-capture.`

  return [
    `Contents of ${indexPath} (persistent memory that survives across conversations):`,
    index,
    ageNotice,
  ].join("\n")
}

/**
 * Parses frontmatter from a memory markdown file.
 */
export function parseMemoryFrontmatter(raw: string): {
  name: string
  description: string
  type: MemoryType
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) {
    return { name: "", description: "", type: "project", body: raw.trim() }
  }

  const yamlBlock = match[1] ?? ""
  const body = (match[2] ?? "").trim()

  const nameMatch = /name:\s*([^\r\n]+)/.exec(yamlBlock)
  const descMatch = /description:\s*([^\r\n]+)/.exec(yamlBlock)
  const typeMatch = /type:\s*([^\r\n]+)/.exec(yamlBlock)

  const name = nameMatch ? nameMatch[1]!.trim() : ""
  const description = descMatch ? descMatch[1]!.trim() : ""
  let typeStr = typeMatch ? typeMatch[1]!.trim().toLowerCase() : "project"
  if (!["user", "feedback", "project", "reference"].includes(typeStr)) {
    typeStr = "project"
  }

  return {
    name,
    description,
    type: typeStr as MemoryType,
    body,
  }
}

/**
 * Saves a single memory file and updates MEMORY.md index.
 */
export async function saveMemory(root: string, memory: MemoryEntry): Promise<void> {
  const slug = memory.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "memory"

  const filename = `${slug}.md`
  const filePath = join(root, filename)

  const fileContent = [
    "---",
    `name: ${slug}`,
    `description: ${memory.description}`,
    "metadata:",
    `  type: ${memory.type}`,
    "---",
    "",
    memory.content.trim(),
    "",
  ].join("\n")

  await writeFile(filePath, fileContent, "utf8")

  // Update or append line in MEMORY.md
  const title = memory.title || memory.name.replace(/-/g, " ")
  const newLine = `- [${title}](${filename}) — ${memory.description}`

  let lines: string[] = []
  try {
    const existing = await readFile(join(root, MEMORY_INDEX_NAME), "utf8")
    lines = existing.split("\n").filter((l) => l.trim().length > 0)
  } catch {
    lines = ["# Memory Index", ""]
  }

  const existingIdx = lines.findIndex((l) => l.includes(`](${filename})`))
  if (existingIdx !== -1) {
    lines[existingIdx] = newLine
  } else {
    lines.push(newLine)
  }

  await writeFile(join(root, MEMORY_INDEX_NAME), `${lines.join("\n")}\n`, "utf8")
}

/**
 * Removes memories matching a given topic.
 * Deletes corresponding files and removes lines from MEMORY.md.
 */
export async function forgetMemory(root: string, topic: string): Promise<string[]> {
  const lowered = topic.toLowerCase().trim()
  const forgotten: string[] = []

  let files: string[] = []
  try {
    files = await readdir(root)
  } catch {
    return []
  }

  for (const file of files) {
    if (!file.endsWith(".md") || file === MEMORY_INDEX_NAME) continue
    const filePath = join(root, file)
    try {
      const content = await readFile(filePath, "utf8")
      const { name, description, body } = parseMemoryFrontmatter(content)
      const textToMatch = `${file} ${name} ${description} ${body}`.toLowerCase()

      if (textToMatch.includes(lowered)) {
        await unlink(filePath).catch(() => {})
        forgotten.push(file)
      }
    } catch {
      // Continue to next file
    }
  }

  if (forgotten.length > 0) {
    try {
      const existing = await readFile(join(root, MEMORY_INDEX_NAME), "utf8")
      const updatedLines = existing
        .split("\n")
        .filter((line) => !forgotten.some((f) => line.includes(`](${f})`)))
      await writeFile(join(root, MEMORY_INDEX_NAME), `${updatedLines.join("\n")}\n`, "utf8")
    } catch {
      // Ignore index rewrite error
    }
  }

  return forgotten
}

/**
 * Lists all memory items in the project store.
 */
export async function listMemories(root: string): Promise<MemoryItem[]> {
  const items: MemoryItem[] = []
  try {
    const files = await readdir(root)
    for (const file of files) {
      if (!file.endsWith(".md") || file === MEMORY_INDEX_NAME) continue
      const filePath = join(root, file)
      try {
        const raw = await readFile(filePath, "utf8")
        const parsed = parseMemoryFrontmatter(raw)
        items.push({
          name: parsed.name || file.replace(/\.md$/, ""),
          filename: file,
          path: filePath,
          description: parsed.description,
          type: parsed.type,
          content: parsed.body,
        })
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Root doesn't exist
  }
  return items
}
