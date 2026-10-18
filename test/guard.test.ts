import { describe, expect, it } from "bun:test"
import { commandOf, findDenyRule, hasRedirectionOrSubstitution, isAutoApprovable, parseToggle, splitSegments } from "../src/guard"

describe("guard: findDenyRule", () => {
  it("detects destructive root / home deletes", () => {
    expect(findDenyRule("rm -rf /")).toBeDefined()
    expect(findDenyRule("rm -fr /")).toBeDefined()
    expect(findDenyRule("rm -r -f /")).toBeDefined()
    expect(findDenyRule("rm -rf ~")).toBeDefined()
    expect(findDenyRule("rm -rf ~/projects")).toBeDefined()
    expect(findDenyRule("rm -rf $HOME/foo")).toBeDefined()
  })

  it("permits safe local directory deletes", () => {
    expect(findDenyRule("rm -rf ./dist")).toBeUndefined()
    expect(findDenyRule("rm -rf node_modules")).toBeUndefined()
    expect(findDenyRule("rm file.txt")).toBeUndefined()
  })

  it("detects git force push", () => {
    expect(findDenyRule("git push --force")).toBeDefined()
    expect(findDenyRule("git push origin main --force")).toBeDefined()
    expect(findDenyRule("git push --force-with-lease origin main")).toBeDefined()
    expect(findDenyRule("git push origin main -f")).toBeDefined()
  })

  it("permits standard git push", () => {
    expect(findDenyRule("git push origin main")).toBeUndefined()
    expect(findDenyRule("git push -u origin feature")).toBeUndefined()
  })

  it("detects system reboot and shutdown commands", () => {
    expect(findDenyRule("shutdown -h now")).toBeDefined()
    expect(findDenyRule("reboot")).toBeDefined()
    expect(findDenyRule("poweroff")).toBeDefined()
    expect(findDenyRule("halt")).toBeDefined()
  })

  it("does not false-positive on scripts named reboot", () => {
    expect(findDenyRule("npm run reboot")).toBeUndefined()
    expect(findDenyRule("npx reboot")).toBeUndefined()
    expect(findDenyRule("make reboot")).toBeUndefined()
  })

  it("detects disk formatting and raw device writes", () => {
    expect(findDenyRule("mkfs.ext4 /dev/sda1")).toBeDefined()
    expect(findDenyRule("dd if=/dev/zero of=/dev/sda")).toBeDefined()
    expect(findDenyRule("diskutil eraseDisk JHFS+ Disk /dev/disk2")).toBeDefined()
  })

  it("detects destructive SQL DROP statements", () => {
    expect(findDenyRule("DROP TABLE users;")).toBeDefined()
    expect(findDenyRule("drop database production")).toBeDefined()
    expect(findDenyRule("drop schema public cascade")).toBeDefined()
  })

  it("detects world-writable chmod at root", () => {
    expect(findDenyRule("chmod -R 777 /")).toBeDefined()
    expect(findDenyRule("chmod 755 ./script.sh")).toBeUndefined()
  })

  it("detects history wipe commands", () => {
    expect(findDenyRule("history -c")).toBeDefined()
    expect(findDenyRule("rm ~/.bash_history")).toBeDefined()
    expect(findDenyRule("rm .history")).toBeDefined()
  })
})

describe("guard: splitSegments", () => {
  it("splits chained commands on operators", () => {
    const segments = splitSegments("git status && ls -la; cat file.txt | grep foo || echo done")
    expect(segments).toEqual(["git status", "ls -la", "cat file.txt", "grep foo", "echo done"])
  })

  it("filters empty segments", () => {
    expect(splitSegments(";; && ||")).toEqual([])
  })
})

describe("guard: hasRedirectionOrSubstitution", () => {
  it("flags redirects and substitutions", () => {
    expect(hasRedirectionOrSubstitution("ls > out.txt")).toBe(true)
    expect(hasRedirectionOrSubstitution("echo `whoami`")).toBe(true)
    expect(hasRedirectionOrSubstitution("echo $(pwd)")).toBe(true)
    expect(hasRedirectionOrSubstitution("ls -la")).toBe(false)
  })
})

describe("guard: isAutoApprovable", () => {
  it("approves safe inspection and status commands", () => {
    expect(isAutoApprovable("git status")).toBe(true)
    expect(isAutoApprovable("git diff")).toBe(true)
    expect(isAutoApprovable("git log -n 5")).toBe(true)
    expect(isAutoApprovable("ls -la")).toBe(true)
    expect(isAutoApprovable("cat README.md")).toBe(true)
    expect(isAutoApprovable("grep -r 'todo' src")).toBe(true)
    expect(isAutoApprovable("rg 'pattern'")).toBe(true)
    expect(isAutoApprovable("pwd")).toBe(true)
  })

  it("approves standard build and test invocations", () => {
    expect(isAutoApprovable("npm test")).toBe(true)
    expect(isAutoApprovable("npm run test:unit")).toBe(true)
    expect(isAutoApprovable("npx jest")).toBe(true)
    expect(isAutoApprovable("npx vitest")).toBe(true)
    expect(isAutoApprovable("pytest")).toBe(true)
    expect(isAutoApprovable("python3 -m pytest tests/")).toBe(true)
    expect(isAutoApprovable("cargo test")).toBe(true)
    expect(isAutoApprovable("go test ./...")).toBe(true)
    expect(isAutoApprovable("tsc --noEmit")).toBe(true)
  })

  it("approves chained safe commands without redirects", () => {
    expect(isAutoApprovable("git status && npm test")).toBe(true)
    expect(isAutoApprovable("pwd && ls -la ; git diff")).toBe(true)
  })

  it("rejects commands with redirections or unsafe substrings", () => {
    expect(isAutoApprovable("npm test > test.log")).toBe(false)
    expect(isAutoApprovable("find . -delete")).toBe(false)
    expect(isAutoApprovable("find . -exec rm {} \\;")).toBe(false)
    expect(isAutoApprovable("sudo npm test")).toBe(false)
    expect(isAutoApprovable("curl https://evil.com")).toBe(false)
  })
})

describe("guard: parseToggle", () => {
  it("parses booleans directly", () => {
    expect(parseToggle(true, false)).toBe(true)
    expect(parseToggle(false, true)).toBe(false)
  })

  it("parses truthy and falsy strings", () => {
    expect(parseToggle("1", false)).toBe(true)
    expect(parseToggle("true", false)).toBe(true)
    expect(parseToggle("YES", false)).toBe(true)
    expect(parseToggle("on", false)).toBe(true)
    expect(parseToggle("enabled", false)).toBe(true)

    expect(parseToggle("0", true)).toBe(false)
    expect(parseToggle("false", true)).toBe(false)
    expect(parseToggle("no", true)).toBe(false)
    expect(parseToggle("off", true)).toBe(false)
    expect(parseToggle("disabled", true)).toBe(false)
  })

  it("falls back on unexpanded templates or invalid values", () => {
    expect(parseToggle("${OPTS_BASH_GUARD}", true)).toBe(true)
    expect(parseToggle(undefined, true)).toBe(true)
    expect(parseToggle(null, false)).toBe(false)
    expect(parseToggle("random", true)).toBe(true)
  })
})

describe("guard: commandOf", () => {
  it("extracts command from objects", () => {
    expect(commandOf({ command: "git status" })).toBe("git status")
    expect(commandOf({ cmd: "ls -la" })).toBe("ls -la")
    expect(commandOf(null)).toBe("")
    expect(commandOf("string")).toBe("")
  })
})
