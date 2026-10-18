import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activeState,
  appendLog,
  extractStatus,
  failureText,
  flattenResult,
  mutateState,
  progressOf,
  readLogTail,
  readState,
  reminderText,
  summaryText,
  taskLabel,
  taskLabelOf,
  type TeamState,
  workerOf,
  writeState,
} from "../src/state"

describe("state: disk persistence", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opencode-team-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("writes and reads state.json accurately", async () => {
    const initialState: TeamState = {
      goal: "Implement authentication",
      status: "active",
      created: "2026-10-18T10:00:00Z",
      tasks: [
        { id: "1", title: "Add auth route", owner: "executor-medium", status: "pending", files: ["src/auth.ts"] },
        { id: "2", title: "Add auth test", owner: "executor-low", status: "pending", files: ["test/auth.test.ts"] },
      ],
    }

    await writeState(tmpDir, initialState)
    const read = await readState(tmpDir)

    expect(read).toBeDefined()
    expect(read?.goal).toBe("Implement authentication")
    expect(read?.status).toBe("active")
    expect(read?.tasks.length).toBe(2)
  })

  it("mutates existing state.json", async () => {
    const state: TeamState = {
      goal: "Refactor database",
      status: "active",
      created: "2026-10-18T10:00:00Z",
      tasks: [{ id: "1", title: "Migrate schema", owner: "executor-high", status: "pending" }],
    }
    await writeState(tmpDir, state)

    const updated = await mutateState(tmpDir, (s) => {
      s.tasks[0]!.status = "done"
      s.failures = 1
    })

    expect(updated?.tasks[0]?.status).toBe("done")
    expect(updated?.failures).toBe(1)

    const read = await readState(tmpDir)
    expect(read?.tasks[0]?.status).toBe("done")
    expect(read?.failures).toBe(1)
  })

  it("returns active state only when status is 'active'", async () => {
    const active: TeamState = {
      goal: "Active task",
      status: "active",
      created: "2026-10-18",
      tasks: [],
    }
    await writeState(tmpDir, active)
    expect(await activeState(tmpDir)).toBeDefined()

    await mutateState(tmpDir, (s) => {
      s.status = "done"
    })
    expect(await activeState(tmpDir)).toBeUndefined()
  })

  it("appends and reads trailing log entries", async () => {
    await appendLog(tmpDir, "Line 1")
    await appendLog(tmpDir, "Line 2")
    await appendLog(tmpDir, "Line 3")

    const tail = await readLogTail(tmpDir, 2)
    expect(tail).toEqual(["Line 2", "Line 3"])
  })
})

describe("state: formatting and progress", () => {
  const sampleState: TeamState = {
    goal: "Fix CSS layout",
    status: "active",
    created: "2026-10-18",
    tasks: [
      { id: "1", title: "Navbar style", owner: "executor-low", status: "done" },
      { id: "2", title: "Sidebar responsive", owner: "executor-medium", status: "pending" },
    ],
  }

  it("computes progress correctly", () => {
    const progress = progressOf(sampleState)
    expect(progress.done).toBe(1)
    expect(progress.total).toBe(2)
    expect(progress.open.length).toBe(1)
    expect(progress.open[0]?.id).toBe("2")
  })

  it("generates readable reminder text", () => {
    const text = reminderText(sampleState, ".team")
    expect(text).toContain("[opencode-team] Active team run — Fix CSS layout")
    expect(text).toContain("Progress: 1/2 tasks done.")
    expect(text).toContain("#2 (executor-medium) Sidebar responsive")
  })

  it("generates summary text", () => {
    const summary = summaryText(sampleState)
    expect(summary).toContain("status: active")
    expect(summary).toContain("goal: Fix CSS layout")
    expect(summary).toContain("progress: 1/2 done")
    expect(summary).toContain("open: 2")
  })
})

describe("state: contracts and extraction helpers", () => {
  it("extracts STATUS contract from subagent responses", () => {
    expect(extractStatus("Everything worked!\nSTATUS: DONE\nChanges Made: none")).toBe("DONE")
    expect(extractStatus("I am blocked.\nSTATUS: BLOCKED\nMissing permissions")).toBe("BLOCKED")
    expect(extractStatus("I finished the work without the token.")).toBe("no STATUS line found")
  })

  it("flattens subagent tool results", () => {
    expect(flattenResult("simple text")).toBe("simple text")
    expect(flattenResult({ content: [{ text: "part 1" }, { text: "part 2" }] })).toBe("part 1\npart 2")
    expect(flattenResult({ output: "output text" })).toBe("output text")
  })

  it("extracts worker type from various input property shapes", () => {
    expect(workerOf({ agent: "executor-medium" })).toBe("executor-medium")
    expect(workerOf({ agentID: "verifier" })).toBe("verifier")
    expect(workerOf({ subagent_type: "debugger" })).toBe("debugger")
    expect(workerOf({})).toBe("agent")
  })

  it("extracts task label preferring description over prompt", () => {
    expect(taskLabelOf({ description: "Inspect unit test failure" })).toBe("Inspect unit test failure")
    expect(taskLabelOf({ prompt: "First line of prompt\nSecond line" })).toBe("First line of prompt")
    expect(taskLabelOf({})).toBe("(no description)")
  })

  it("extracts failure error text cleanly", () => {
    expect(failureText(new Error("Process timed out"))).toBe("Process timed out")
    expect(failureText({ message: "Network error\nDetails here" })).toBe("Network error")
    expect(failureText("Raw string error")).toBe("Raw string error")
  })
})
