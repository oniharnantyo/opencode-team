import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireLock,
  checkExtractionGates,
  daysSinceLastExtraction,
  ensureMemoryRoot,
  forgetMemory,
  formatMemoryContext,
  isExtractionRunning,
  listMemories,
  mainAgentSavedThisTurn,
  parseMemoryFrontmatter,
  projectKey,
  readMemoryIndex,
  releaseLock,
  resolveMemoryRoot,
  saveMemory,
  slugify,
  STAMP_LAST_EXTRACTION,
  STAMP_TURN_START,
  STAMP_USER_PROSE,
  stampTurn,
} from "../src/memory/index"

describe("memory: paths", () => {
  it("slugifies directory names correctly", () => {
    expect(slugify("My Cool Project!")).toBe("my-cool-project")
    expect(slugify("---test---")).toBe("test")
    expect(slugify("")).toBe("project")
  })

  it("produces deterministic projectKey with 16-char sha256 hash", () => {
    const key1 = projectKey("/path/to/my-project")
    const key2 = projectKey("/path/to/my-project")
    const key3 = projectKey("/different/path/my-project")

    expect(key1).toBe(key2)
    expect(key1.startsWith("my-project-")).toBe(true)
    expect(key1.length).toBe("my-project-".length + 16)
    // Different directory paths must produce different hashes even with same basename
    expect(key1).not.toBe(key3)
  })

  it("resolves memory root with customBaseDir", () => {
    const root = resolveMemoryRoot("/my/project", "/custom/base")
    expect(root).toContain("/custom/base")
    expect(root).toContain("memory")
  })
})

describe("memory: store & recall", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opencode-team-mem-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("saves a memory file with frontmatter and updates MEMORY.md", async () => {
    await saveMemory(tmpDir, {
      name: "prefers-tabs",
      description: "User prefers tabs over spaces in Python files.",
      type: "user",
      content: "Always indent Python with tabs instead of spaces.",
      title: "Python Tabs Preference",
    })

    const indexContent = await readMemoryIndex(tmpDir)
    expect(indexContent).toBeDefined()
    expect(indexContent).toContain("- [Python Tabs Preference](prefers-tabs.md) — User prefers tabs over spaces in Python files.")

    const fileContent = await readFile(join(tmpDir, "prefers-tabs.md"), "utf8")
    const parsed = parseMemoryFrontmatter(fileContent)
    expect(parsed.name).toBe("prefers-tabs")
    expect(parsed.description).toBe("User prefers tabs over spaces in Python files.")
    expect(parsed.type).toBe("user")
    expect(parsed.body).toBe("Always indent Python with tabs instead of spaces.")
  })

  it("updates existing memory instead of creating a duplicate", async () => {
    await saveMemory(tmpDir, {
      name: "prefers-tabs",
      description: "Old description",
      type: "user",
      content: "Old body",
    })

    await saveMemory(tmpDir, {
      name: "prefers-tabs",
      description: "New updated description",
      type: "user",
      content: "New updated body",
    })

    const memories = await listMemories(tmpDir)
    expect(memories.length).toBe(1)
    expect(memories[0]?.description).toBe("New updated description")
    expect(memories[0]?.content).toBe("New updated body")

    const indexContent = await readMemoryIndex(tmpDir)
    const matches = indexContent?.split("\n").filter((l) => l.includes("prefers-tabs.md"))
    expect(matches?.length).toBe(1)
  })

  it("formats memory context for session injection", async () => {
    await saveMemory(tmpDir, {
      name: "staging-env",
      description: "Deployments must pass staging first.",
      type: "project",
      content: "Staging URL: https://staging.example.com",
    })

    // Without auto-capture stamp
    const contextNoStamp = await formatMemoryContext(tmpDir)
    expect(contextNoStamp).toContain("Contents of")
    expect(contextNoStamp).toContain("Auto-capture has not run for this project yet.")

    // With auto-capture stamp
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400
    await writeFile(join(tmpDir, STAMP_LAST_EXTRACTION), String(twoDaysAgo), "utf8")

    const contextWithStamp = await formatMemoryContext(tmpDir)
    expect(contextWithStamp).toContain("Memory last updated 2 day(s) ago by auto-capture.")
  })

  it("forgets memories matching a topic and updates MEMORY.md", async () => {
    await saveMemory(tmpDir, {
      name: "rule-a",
      description: "Rule A about staging",
      type: "project",
      content: "staging details",
    })
    await saveMemory(tmpDir, {
      name: "rule-b",
      description: "Rule B about production",
      type: "project",
      content: "production details",
    })

    const forgotten = await forgetMemory(tmpDir, "staging")
    expect(forgotten).toEqual(["rule-a.md"])

    const remaining = await listMemories(tmpDir)
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.name).toBe("rule-b")

    const index = await readMemoryIndex(tmpDir)
    expect(index).not.toContain("rule-a.md")
    expect(index).toContain("rule-b.md")
  })
})

describe("memory: gates & stamping", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opencode-team-gates-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("stamps turn start and evaluates user prose threshold", async () => {
    // Under 3 words -> no prose
    await stampTurn(tmpDir, "ok go")
    const proseShort = await readFile(join(tmpDir, STAMP_USER_PROSE), "utf8")
    expect(proseShort.trim()).toBe("0")

    // >= 3 words -> real prose
    await stampTurn(tmpDir, "please remember this rule")
    const proseLong = await readFile(join(tmpDir, STAMP_USER_PROSE), "utf8")
    expect(proseLong.trim()).toBe("1")
  })

  it("gate blocks on recursion sentinel", async () => {
    await stampTurn(tmpDir, "please remember this rule")
    process.env.OPENCODE_MEMORY_EXTRACTOR = "1"
    try {
      const gate = await checkExtractionGates(tmpDir)
      expect(gate.canExtract).toBe(false)
      expect(gate.reason).toContain("recursion sentinel")
    } finally {
      delete process.env.OPENCODE_MEMORY_EXTRACTOR
    }
  })

  it("gate blocks if user prompt had no prose", async () => {
    await stampTurn(tmpDir, "ok")
    const gate = await checkExtractionGates(tmpDir)
    expect(gate.canExtract).toBe(false)
    expect(gate.reason).toContain("prose words")
  })

  it("gate stands down if main agent modified memory during the turn", async () => {
    // Simulate turn started 10 seconds ago
    const past = Math.floor(Date.now() / 1000) - 10
    await writeFile(join(tmpDir, STAMP_TURN_START), String(past), "utf8")
    await writeFile(join(tmpDir, STAMP_USER_PROSE), "1", "utf8")

    // Write a memory now (mtime > turnStart)
    await saveMemory(tmpDir, {
      name: "test-save",
      description: "Saved by main agent",
      type: "project",
      content: "content",
    })

    const gate = await checkExtractionGates(tmpDir)
    expect(gate.canExtract).toBe(false)
    expect(gate.reason).toContain("main agent already modified memory")
  })

  it("gate blocks if extraction lock is active and fresh", async () => {
    await stampTurn(tmpDir, "long enough user prompt to pass")
    await acquireLock(tmpDir)

    const running = await isExtractionRunning(tmpDir)
    expect(running).toBe(true)

    const gate = await checkExtractionGates(tmpDir)
    expect(gate.canExtract).toBe(false)
    expect(gate.reason).toContain("currently running")

    await releaseLock(tmpDir)
    const runningAfter = await isExtractionRunning(tmpDir)
    expect(runningAfter).toBe(false)
  })
})
