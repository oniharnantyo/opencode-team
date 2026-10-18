#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(__dirname, "..")
const BUNDLED_AGENTS_DIR = join(ROOT_DIR, "agents")

const HELP = `opencode-team CLI — Parallel subagent team executor for OpenCode

Usage:
  opencode-team [command] [options]

Commands:
  status [dir]       Show active team state, progress, and tasks (default dir: .team)
  log [lines]        Show trailing lines from .team/log.md (default: 20)
  memory [subcmd]    Inspect project memory (show, list, path)
  agents             List bundled worker agents
  agents --install   Install bundled agents into .opencode/agents/ in the current project
  init [goal]        Initialize .team/state.json and .team/handoffs/ workspace
  help, --help, -h   Show this help message

Options:
  --dir <path>       Custom team state directory (default: .team)
`

function parseArgs(args) {
  let command = "status"
  let teamDir = ".team"
  let count = 20
  let goal = ""
  let install = false
  let subcmd = ""

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h" || arg === "help") {
      return { command: "help" }
    }
    if (arg === "--dir" && i + 1 < args.length) {
      teamDir = args[++i]
      continue
    }
    if (arg === "--install" || arg === "-i" || arg === "install") {
      install = true
      continue
    }
    if (i === 0 && !arg.startsWith("-")) {
      command = arg
      continue
    }
    if (command === "memory" && !subcmd && !arg.startsWith("-")) {
      subcmd = arg
      continue
    }
    if (command === "log" && /^\d+$/.test(arg)) {
      count = Number.parseInt(arg, 10)
      continue
    }
    if (command === "init") {
      goal = goal ? `${goal} ${arg}` : arg
      continue
    }
    if (command === "status" && !arg.startsWith("-")) {
      teamDir = arg
      continue
    }
  }

  return { command, teamDir, count, goal, install, subcmd }
}

async function readJson(path) {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function cmdStatus(teamDir) {
  const statePath = join(process.cwd(), teamDir, "state.json")
  const state = await readJson(statePath)
  if (!state) {
    console.log(`No active team state found at ${teamDir}/state.json`)
    console.log(`Run 'opencode-team init "Your goal"' to start a new run.`)
    return
  }

  const tasks = Array.isArray(state.tasks) ? state.tasks : []
  const doneTasks = tasks.filter((t) => t.status === "done")
  const openTasks = tasks.filter((t) => t.status !== "done")

  console.log(`\n=== opencode-team status ===`)
  console.log(`Status:    ${state.status ?? "unknown"}`)
  console.log(`Goal:      ${state.goal || "(no goal specified)"}`)
  console.log(`Created:   ${state.created || "(unknown)"}`)
  console.log(`Progress:  ${doneTasks.length}/${tasks.length} tasks completed`)
  if (state.failures) {
    console.log(`Failures:  ${state.failures}`)
  }

  if (openTasks.length > 0) {
    console.log(`\nOpen tasks:`)
    for (const t of openTasks) {
      console.log(`  [${t.status ?? "pending"}] #${t.id ?? "?"} (${t.owner ?? "unknown"}) ${t.title ?? ""}`)
      if (t.files && t.files.length > 0) {
        console.log(`     files: ${t.files.join(", ")}`)
      }
      if (t.acceptance) {
        console.log(`     acceptance: ${t.acceptance}`)
      }
    }
  }

  if (doneTasks.length > 0) {
    console.log(`\nCompleted tasks:`)
    for (const t of doneTasks) {
      console.log(`  [done] #${t.id ?? "?"} (${t.owner ?? "unknown"}) ${t.title ?? ""}`)
    }
  }
  console.log("")
}

async function cmdLog(teamDir, lines) {
  const logPath = join(process.cwd(), teamDir, "log.md")
  try {
    const content = await readFile(logPath, "utf8")
    const allLines = content
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
    const tail = allLines.slice(-lines)
    if (tail.length === 0) {
      console.log(`Log file is empty at ${teamDir}/log.md`)
      return
    }
    console.log(`\n=== Recent team dispatch log (${tail.length} lines) ===`)
    for (const line of tail) {
      console.log(line)
    }
    console.log("")
  } catch {
    console.log(`No log file found at ${teamDir}/log.md`)
  }
}

async function cmdAgents(install) {
  let files = []
  try {
    files = (await readdir(BUNDLED_AGENTS_DIR)).filter((f) => f.endsWith(".md"))
  } catch (err) {
    console.error("Failed to read bundled agents directory:", err.message)
    return
  }

  if (install) {
    const targetDir = join(process.cwd(), ".opencode", "agents")
    await mkdir(targetDir, { recursive: true })
    console.log(`\nInstalling ${files.length} bundled agents to ${targetDir}:`)
    for (const file of files) {
      const src = join(BUNDLED_AGENTS_DIR, file)
      const dst = join(targetDir, file)
      const content = await readFile(src, "utf8")
      await writeFile(dst, content, "utf8")
      console.log(`  ✓ ${file} -> .opencode/agents/${file}`)
    }
    console.log(`Done! Worker agents are ready for OpenCode.\n`)
    return
  }

  console.log(`\n=== Bundled worker agents (${files.length}) ===`)
  for (const file of files) {
    const agentName = file.replace(/\.md$/, "")
    const content = await readFile(join(BUNDLED_AGENTS_DIR, file), "utf8")
    const descMatch = /description:\s*([^\n]+)/.exec(content)
    const desc = descMatch ? descMatch[1].trim() : "(no description)"
    console.log(`- ${agentName.padEnd(16)}: ${desc}`)
  }
  console.log(`\nRun 'opencode-team agents --install' to copy these into .opencode/agents/`)
  console.log("")
}

async function cmdInit(teamDir, goalText) {
  const targetDir = join(process.cwd(), teamDir)
  const handoffsDir = join(targetDir, "handoffs")
  await mkdir(handoffsDir, { recursive: true })

  const statePath = join(targetDir, "state.json")
  let existing = await readJson(statePath)
  if (existing && existing.status === "active") {
    console.log(`An active run already exists at ${teamDir}/state.json`)
    console.log(`Goal: ${existing.goal}`)
    return
  }

  const initial = {
    goal: goalText || "New team task",
    status: "active",
    created: new Date().toISOString(),
    tasks: [],
  }

  await writeFile(statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8")
  console.log(`\nInitialized team workspace at ${teamDir}/:`)
  console.log(`  ✓ ${teamDir}/state.json`)
  console.log(`  ✓ ${teamDir}/handoffs/`)
  console.log(`Goal: "${initial.goal}"`)
  console.log(`Tip: Add "${teamDir}/" to your .gitignore.\n`)
}

function getMemoryRoot(projectDir = process.cwd()) {
  const abs = resolve(projectDir)
  const slug = basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16)
  const key = `${slug}-${hash}`
  const home = homedir()
  const kiroPath = join(home, ".kiro", "memories", "projects", key, "memory")
  if (existsSync(kiroPath)) return kiroPath
  return join(home, ".opencode", "memories", "projects", key, "memory")
}

async function cmdMemory(subcmd) {
  const root = getMemoryRoot()

  if (subcmd === "path") {
    console.log(root)
    return
  }

  if (subcmd === "list") {
    if (!existsSync(root)) {
      console.log(`\nNo memories directory found for this project at:\n${root}\n`)
      return
    }
    const files = (await readdir(root)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    if (files.length === 0) {
      console.log(`\nNo memory files found at ${root}\n`)
      return
    }
    console.log(`\n=== Project Memories (${files.length}) ===`)
    console.log(`Location: ${root}\n`)
    for (const f of files) {
      console.log(`- ${f}`)
    }
    console.log("")
    return
  }

  // Default: show MEMORY.md
  const indexPath = join(root, "MEMORY.md")
  if (!existsSync(indexPath)) {
    console.log(`\nNo MEMORY.md index found for this project at:\n${root}\n`)
    console.log(`Use the /memory skill in OpenCode to save your first memory.\n`)
    return
  }

  const content = await readFile(indexPath, "utf8")
  console.log(`\n=== Project Memory Index ===`)
  console.log(`Location: ${root}\n`)
  console.log(content.trim())
  console.log("")
}

async function main() {
  const args = process.argv.slice(2)
  const { command, teamDir, count, goal, install, subcmd } = parseArgs(args)

  switch (command) {
    case "help":
      console.log(HELP)
      break
    case "status":
      await cmdStatus(teamDir)
      break
    case "log":
      await cmdLog(teamDir, count)
      break
    case "memory":
      await cmdMemory(subcmd)
      break
    case "agents":
      await cmdAgents(install)
      break
    case "init":
      await cmdInit(teamDir, goal)
      break
    default:
      console.log(`Unknown command: ${command}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err) => {
  console.error("Error:", err)
  process.exitCode = 1
})
