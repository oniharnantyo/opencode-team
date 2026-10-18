import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"
import { readLogTail, readState, writeState } from "../src/state"

describe("plugin: lifecycle & hooks", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "opencode-team-plugin-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("exports a valid OpenCode v2 plugin definition", () => {
    expect(plugin.id).toBe("opencode-team")
    expect(typeof plugin.setup).toBe("function")
  })

  it("registers skill, command, and lifecycle hooks upon setup", async () => {
    const skillsRegistered: any[] = []
    const commandsRegistered: any[] = []
    const sessionHooks: Record<string, Function> = {}
    const toolHooks: Record<string, Function> = {}
    const shellHooks: Record<string, Function> = {}
    const permissionHooks: Record<string, Function> = {}

    const mockCtx: any = {
      location: { directory: tmpDir },
      options: {
        bash_guard: true,
        auto_approve_safe_commands: true,
        team_dir: ".team",
        models: {
          "executor-low": "openai/gpt-4o-mini",
        },
      },
      skill: {
        transform: (fn: any) =>
          fn({
            add: (skill: any) => skillsRegistered.push(skill),
          }),
      },
      command: {
        transform: (fn: any) =>
          fn({
            add: (cmd: any) => commandsRegistered.push(cmd),
          }),
      },
      agent: {
        transform: (fn: any) => {
          const agentsMap: Record<string, any> = {
            "executor-low": { id: "executor-low", name: "executor-low" },
          }
          fn({
            update: (id: string, updater: any) => {
              if (agentsMap[id]) updater(agentsMap[id])
            },
          })
          mockCtx._agentsMap = agentsMap
        },
      },
      session: {
        hook: (name: string, handler: Function) => {
          sessionHooks[name] = handler
        },
        prompt: async () => {},
      },
      tool: {
        hook: (name: string, handler: Function) => {
          toolHooks[name] = handler
        },
      },
      shell: {
        hook: (name: string, handler: Function) => {
          shellHooks[name] = handler
        },
      },
      permission: {
        hook: (name: string, handler: Function) => {
          permissionHooks[name] = handler
        },
      },
      event: {
        subscribe: () => ({
          [Symbol.asyncIterator]: async function* () {},
        }),
      },
    }

    const cleanup = await plugin.setup(mockCtx)
    expect(typeof cleanup).toBe("function")

    // Skill registered
    expect(skillsRegistered.length).toBe(1)
    expect(skillsRegistered[0].name).toBe("team")

    // Slash command registered
    expect(commandsRegistered.length).toBe(1)
    expect(commandsRegistered[0].name).toBe("team")

    // Agent model override applied
    expect(mockCtx._agentsMap["executor-low"].model).toEqual({
      providerID: "openai",
      id: "gpt-4o-mini",
    })

    // Session hooks
    expect(sessionHooks["context"]).toBeDefined()
    expect(sessionHooks["compaction"]).toBeDefined()

    // Tool hooks
    expect(toolHooks["execute.before"]).toBeDefined()
    expect(toolHooks["execute.after"]).toBeDefined()

    // Shell & permission hooks
    expect(shellHooks["create.before"]).toBeDefined()
    expect(permissionHooks["evaluate"]).toBeDefined()

    // Test reasoning effort tuning in context hook
    const lowEffortEvent = { agent: "executor-low", options: {} as any, system: [] }
    await sessionHooks["context"]!(lowEffortEvent)
    expect(lowEffortEvent.options.reasoningEffort).toBe("low")

    const highEffortEvent = { agent: "executor-high", options: {} as any, system: [] }
    await sessionHooks["context"]!(highEffortEvent)
    expect(highEffortEvent.options.reasoningEffort).toBe("high")

    // Write active state into tmpDir/.team/state.json
    const teamDir = join(tmpDir, ".team")
    await writeState(teamDir, {
      goal: "Test goal",
      status: "active",
      created: "2026-10-18",
      tasks: [{ id: "1", title: "Task 1", owner: "executor-medium", status: "pending" }],
    })

    // Test context reminder injection
    const contextEvent = { agent: "lead", options: {} as any, system: [] as any[] }
    await sessionHooks["context"]!(contextEvent)
    expect(contextEvent.system.length).toBe(1)
    expect(contextEvent.system[0].text).toContain("[opencode-team] Active team run — Test goal")

    // Test bash guard blocking destructive tool calls
    expect(
      toolHooks["execute.before"]!({
        tool: "bash",
        input: { command: "rm -rf /" },
      }),
    ).rejects.toThrow("Blocked destructive shell command")

    // Test subagent dispatch logging
    await toolHooks["execute.before"]!({
      tool: "subagent",
      input: { agent: "executor-medium", description: "Write feature" },
    })

    let logs = await readLogTail(teamDir, 10)
    expect(logs.some((l) => l.includes("DISPATCH executor-medium: Write feature"))).toBe(true)

    // Test subagent completion logging
    await toolHooks["execute.after"]!({
      tool: "subagent",
      input: { agent: "executor-medium", description: "Write feature" },
      status: "completed",
      result: "STATUS: DONE\nFinished code",
    })

    logs = await readLogTail(teamDir, 10)
    expect(logs.some((l) => l.includes("RETURN executor-medium (DONE): Write feature"))).toBe(true)

    // Test subagent failure logging and state increment
    await toolHooks["execute.after"]!({
      tool: "subagent",
      input: { agent: "executor-medium", description: "Write feature" },
      status: "error",
      error: new Error("Test timeout failure"),
    })

    logs = await readLogTail(teamDir, 10)
    expect(logs.some((l) => l.includes("FAILED executor-medium (Test timeout failure)"))).toBe(true)
    const currentState = await readState(teamDir)
    expect(currentState?.failures).toBe(1)

    // Test permission evaluation hook
    const denyEvent: any = { resources: ["rm -rf ~"], effect: "prompt" }
    permissionHooks["evaluate"]!(denyEvent)
    expect(denyEvent.effect).toBe("deny")

    const allowEvent: any = { resources: ["npm test"], effect: "prompt" }
    permissionHooks["evaluate"]!(allowEvent)
    expect(allowEvent.effect).toBe("allow")

    if (typeof cleanup === "function") {
      cleanup()
    }
  })
})
