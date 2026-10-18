import { describe, expect, it } from "bun:test"
import { resolveOptions } from "../src/options"

describe("options: resolveOptions", () => {
  it("uses sensible defaults when options are undefined", () => {
    const opts = resolveOptions(undefined)
    expect(opts.bashGuard).toBe(true)
    expect(opts.autoApproveSafeCommands).toBe(false)
    expect(opts.teamDir).toBe(".team")
    expect(opts.maxWorkers).toBe(5)
    expect(opts.logTail).toBe(10)
    expect(opts.stateReminder).toBe(true)
    expect(opts.idleNudge).toBe(true)
    expect(opts.installAgents).toBe(false)
  })

  it("supports oh-my-zcode snake_case options for backward compatibility", () => {
    const opts = resolveOptions({
      bash_guard: false,
      auto_approve_safe_commands: true,
      team_dir: ".custom-team",
      max_workers: 8,
      log_tail: 25,
      state_reminder: false,
      idle_nudge: false,
      install_agents: true,
    })
    expect(opts.bashGuard).toBe(false)
    expect(opts.autoApproveSafeCommands).toBe(true)
    expect(opts.teamDir).toBe(".custom-team")
    expect(opts.maxWorkers).toBe(8)
    expect(opts.logTail).toBe(25)
    expect(opts.stateReminder).toBe(false)
    expect(opts.idleNudge).toBe(false)
    expect(opts.installAgents).toBe(true)
  })

  it("supports camelCase options", () => {
    const opts = resolveOptions({
      bashGuard: false,
      autoApproveSafeCommands: true,
      teamDir: ".team-v2",
      maxWorkers: 3,
      logTail: 15,
      stateReminder: false,
      idleNudge: false,
      installAgents: true,
    })
    expect(opts.bashGuard).toBe(false)
    expect(opts.autoApproveSafeCommands).toBe(true)
    expect(opts.teamDir).toBe(".team-v2")
    expect(opts.maxWorkers).toBe(3)
    expect(opts.logTail).toBe(15)
  })

  it("handles string numbers and sanitizes invalid values", () => {
    const opts = resolveOptions({
      maxWorkers: "4",
      logTail: "-5", // negative -> should fallback
    })
    expect(opts.maxWorkers).toBe(4)
    expect(opts.logTail).toBe(10)
  })
})
