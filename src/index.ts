import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin, Skill } from "@opencode/plugin"
import { commandOf, findDenyRule, isAutoApprovable } from "./guard"
import { BUNDLED_SKILLS_DIR, installAgents } from "./install"
import { resolveOptions } from "./options"
import {
  activeState,
  appendLog,
  extractStatus,
  failureText,
  flattenResult,
  mutateState,
  progressOf,
  readLogTail,
  reminderText,
  taskLabelOf,
  teamDirPath,
  timestamp,
  workerOf,
} from "./state"

export { findDenyRule, isAutoApprovable } from "./guard"
export { installAgents, listBundledAgents } from "./install"
export { resolveOptions, type TeamOptions } from "./options"
export * from "./state"

const SHELL_TOOLS = new Set(["bash", "execute", "shell", "terminal", "run_command", "run_shell_command"])
const SUBAGENT_TOOLS = new Set(["subagent", "agent", "task"])

const FALLBACK_SKILL_CONTENT = `# Team — Parallel Subagent Executor
Spawn coordinated subagents working a shared task list at .team/state.json, then verify with verifier.
`

export default Plugin.define({
  id: "opencode-team",
  setup(ctx) {
    const options = resolveOptions(ctx.options as Record<string, unknown> | undefined)
    const projectDir = ctx.location?.directory ?? process.cwd()
    const teamDir = teamDirPath(projectDir, options.teamDir)

    // Optionally install bundled agents into .opencode/agents/
    if (options.installAgents) {
      void installAgents(projectDir).catch(() => {})
    }

    // Register team skill
    ctx.skill.transform((editor) => {
      let content = FALLBACK_SKILL_CONTENT
      const skillPath = join(BUNDLED_SKILLS_DIR, "team", "SKILL.md")
      try {
        content = readFileSync(skillPath, "utf8")
      } catch {
        // Fallback to minimal content
      }

      editor.add(
        Skill.Info.make({
          id: "team" as any,
          name: "team" as any,
          description: "Parallel subagent team executor",
          autoinvoke: false,
          path: skillPath as any,
          content,
        }),
      )
    })

    // Register /team slash command
    ctx.command.transform((editor) => {
      editor.add({
        name: "team",
        description: "Spawn coordinated subagents on a shared goal using the team skill",
        async execute(inv) {
          const text = inv.prompt?.text?.trim() ?? ""
          const promptText = text
            ? `Use the team skill to execute this goal with parallel subagents: ${text}`
            : "Use the team skill to plan and execute subagent tasks on the current goal."
          await ctx.session.prompt({
            sessionID: inv.sessionID,
            text: promptText,
          })
        },
      })
    })

    // Register agent model overrides if specified in plugin options
    if (options.models && ctx.agent?.transform) {
      ctx.agent.transform((editor) => {
        for (const [agentName, modelDef] of Object.entries(options.models ?? {})) {
          editor.update(agentName, (agent) => {
            if (typeof modelDef === "string") {
              const slash = modelDef.indexOf("/")
              if (slash !== -1) {
                agent.model = {
                  providerID: modelDef.slice(0, slash) as any,
                  id: modelDef.slice(slash + 1) as any,
                }
              } else {
                agent.model = {
                  providerID: "default" as any,
                  id: modelDef as any,
                }
              }
            } else if (modelDef && typeof modelDef === "object") {
              const provider = (modelDef.providerID ?? modelDef.provider ?? "default") as string
              const modelId = (modelDef.id ?? modelDef.model ?? "") as string
              if (modelId) {
                agent.model = {
                  providerID: provider as any,
                  id: modelId as any,
                }
              }
            }
          })
        }
      })
    }

    // Hook session context: inject state reminder and tune reasoning effort
    ctx.session.hook("context", async (event) => {
      const agentId = String(event.agent ?? "").toLowerCase()
      if (agentId.includes("executor-low")) {
        event.options.reasoningEffort = "low"
      } else if (agentId.includes("executor-high")) {
        event.options.reasoningEffort = "high"
      }

      if (options.stateReminder) {
        const state = await activeState(teamDir)
        if (state) {
          event.system.push({
            type: "text",
            text: reminderText(state, options.teamDir),
          })
        }
      }
    })

    // Hook session compaction: inject state reminder and recent dispatch log lines
    ctx.session.hook("compaction", async (event) => {
      if (options.stateReminder) {
        const state = await activeState(teamDir)
        if (state) {
          const tail = await readLogTail(teamDir, options.logTail)
          const parts = [reminderText(state, options.teamDir)]
          if (tail.length > 0) {
            parts.push("\nRecent team dispatch log:\n" + tail.join("\n"))
          }
          event.system.push({
            type: "text",
            text: parts.join("\n"),
          })
        }
      }
    })

    // Hook tool execute before: bash guard & subagent dispatch logging
    ctx.tool.hook("execute.before", async (event) => {
      const toolName = event.tool.toLowerCase()

      // Bash guard
      if (options.bashGuard && SHELL_TOOLS.has(toolName)) {
        const command = commandOf(event.input)
        if (command) {
          const rule = findDenyRule(command)
          if (rule) {
            throw new Error(`[opencode-team] Blocked destructive shell command (${rule.label}): ${command}`)
          }
        }
      }

      // Subagent dispatch logging
      if (SUBAGENT_TOOLS.has(toolName)) {
        const state = await activeState(teamDir)
        if (state) {
          const worker = workerOf(event.input)
          const label = taskLabelOf(event.input)
          await appendLog(teamDir, `[${timestamp()}] DISPATCH ${worker}: ${label}`)
        }
      }
    })

    // Hook tool execute after: subagent return/failure logging
    ctx.tool.hook("execute.after", async (event) => {
      const toolName = event.tool.toLowerCase()
      if (!SUBAGENT_TOOLS.has(toolName)) return

      const state = await activeState(teamDir)
      if (!state) return

      const worker = workerOf(event.input)
      const label = taskLabelOf(event.input)

      if (event.status === "completed") {
        const text = flattenResult(event.result)
        const status = extractStatus(text)
        await appendLog(teamDir, `[${timestamp()}] RETURN ${worker} (${status}): ${label}`)
      } else if (event.status === "error") {
        const err = failureText(event.error)
        await appendLog(teamDir, `[${timestamp()}] FAILED ${worker} (${err}): ${label}`)
        await mutateState(teamDir, (s) => {
          s.failures = (s.failures ?? 0) + 1
        })
      }
    })

    // Hook shell create before: intercept lower-level shell commands
    ctx.shell.hook("create.before", (event) => {
      if (options.bashGuard && event.command) {
        const rule = findDenyRule(event.command)
        if (rule) {
          throw new Error(`[opencode-team] Blocked destructive shell command (${rule.label}): ${event.command}`)
        }
      }
    })

    // Hook permission evaluate: block destructive actions, auto-approve safe commands
    ctx.permission.hook("evaluate", (event) => {
      const candidates: string[] = []
      for (const res of event.resources ?? []) {
        if (typeof res === "string" && res) candidates.push(res)
      }
      if (event.metadata) {
        const cmd = commandOf(event.metadata)
        if (cmd) candidates.push(cmd)
      }

      // Destructive command check
      if (options.bashGuard) {
        for (const cmd of candidates) {
          const rule = findDenyRule(cmd)
          if (rule) {
            event.effect = "deny"
            event.message = `[opencode-team] Blocked destructive command (${rule.label}): ${cmd}`
            return
          }
        }
      }

      // Safe command auto-approval check
      if (options.autoApproveSafeCommands && candidates.length > 0) {
        if (candidates.every((cmd) => isAutoApprovable(cmd))) {
          event.effect = "allow"
        }
      }
    })

    // Idle monitoring
    const abortController = new AbortController()
    if (options.idleNudge && ctx.event?.subscribe) {
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: abortController.signal })) {
            const evType = (ev as { type?: string }).type ?? ""
            const evStatus = (ev as { status?: string }).status ?? ""
            if (evType === "session.idle" || evStatus === "idle") {
              const state = await activeState(teamDir)
              if (state) {
                const { open, total } = progressOf(state)
                if (open.length > 0) {
                  await appendLog(
                    teamDir,
                    `[${timestamp()}] IDLE: session idle with ${open.length}/${total} tasks open`,
                  )
                }
              }
            }
          }
        } catch {
          // Aborted or subscription closed
        }
      })()
    }

    return () => {
      abortController.abort()
    }
  },
})
