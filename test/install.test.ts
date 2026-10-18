import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installAgents, listBundledAgents } from "../src/install"

describe("install: bundled agents", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opencode-team-install-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("lists all 8 expected worker agent definition files", async () => {
    const agents = await listBundledAgents()
    expect(agents.sort()).toEqual([
      "critic.md",
      "debugger.md",
      "executor-high.md",
      "executor-low.md",
      "executor-medium.md",
      "memory-extractor.md",
      "planner.md",
      "verifier.md",
    ])
  })

  it("copies bundled agents into target .opencode/agents/", async () => {
    const installed = await installAgents(tmpDir)
    expect(installed.length).toBe(8)

    const writtenFiles = await readdir(join(tmpDir, ".opencode", "agents"))
    expect(writtenFiles.length).toBe(8)
    expect(writtenFiles).toContain("planner.md")
    expect(writtenFiles).toContain("verifier.md")
    expect(writtenFiles).toContain("memory-extractor.md")
  })
})
