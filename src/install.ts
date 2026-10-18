import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const BUNDLED_AGENTS_DIR = join(__dirname, "../agents")
export const BUNDLED_SKILLS_DIR = join(__dirname, "../skills")

export interface InstalledItem {
  name: string
  sourcePath: string
  targetPath: string
}

/**
 * List all bundled agent markdown files.
 */
export async function listBundledAgents(): Promise<string[]> {
  try {
    const files = await readdir(BUNDLED_AGENTS_DIR)
    return files.filter((f) => f.endsWith(".md"))
  } catch {
    return []
  }
}

/**
 * Copy bundled worker agents into the target project's `.opencode/agents/` folder.
 */
export async function installAgents(projectDir: string, subfolder = ""): Promise<InstalledItem[]> {
  const targetDir = join(projectDir, ".opencode", "agents", subfolder)
  await mkdir(targetDir, { recursive: true })

  const files = await listBundledAgents()
  const installed: InstalledItem[] = []

  for (const file of files) {
    const sourcePath = join(BUNDLED_AGENTS_DIR, file)
    const targetPath = join(targetDir, file)
    const content = await readFile(sourcePath, "utf8")
    await writeFile(targetPath, content, "utf8")
    installed.push({
      name: file.replace(/\.md$/, ""),
      sourcePath,
      targetPath,
    })
  }

  return installed
}
