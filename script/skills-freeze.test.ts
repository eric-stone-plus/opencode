import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// Skills freeze + no self-evolution (owner decision 2026-10-16). The mattpocock
// skill set is pinned at the revision recorded in skills/PROVENANCE.md, the mode
// architecture has a single tracked source, and nothing the agent runs may
// rewrite the seat on its own. These assertions fail if an auto-update path, or
// a retired instruction document, is reintroduced.
const ROOT = path.resolve(import.meta.dir, "..")
const PLUGIN_DIR = path.join(ROOT, "bootstrap", "plugin")
const plugins = () => readdirSync(PLUGIN_DIR).filter((file) => file.endsWith(".ts"))
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8")

// Shell invocations of git inside a Bun `$` template literal. Prose in a
// docstring may describe `git commit`; only a real call can perform one.
const gitCalls = (body: string) => [...body.matchAll(/\$`git\s+([^`]*)`/g)].map((match) => match[1].trim())

describe("skills freeze", () => {
  test("the auto-updater and its battery are gone", () => {
    expect(existsSync(path.join(PLUGIN_DIR, "mpskills-update.ts"))).toBe(false)
    expect(existsSync(path.join(ROOT, "script", "mpskills-update.test.ts"))).toBe(false)
  })

  test("no plugin carries a skills-refresh path", () => {
    const offenders = plugins().filter((file) =>
      /mattpocock|mpskills|vendor-skills|update-skills/.test(readFileSync(path.join(PLUGIN_DIR, file), "utf8")),
    )
    expect(offenders).toEqual([])
  })

  test("no plugin shells out to a git write", () => {
    const offenders = plugins().filter((file) => {
      const calls = gitCalls(readFileSync(path.join(PLUGIN_DIR, file), "utf8"))
      return calls.some((call) => /\b(fetch|clone|commit|push|reset|checkout|add)\b/.test(call))
    })
    expect(offenders).toEqual([])
  })

  test("the operator update path performs no git write", () => {
    // Strip an optional `-C <path>` and require the verb to be a read.
    const verb = (call: string) => call.replace(/^-C\s+\S+\s+/, "").split(/\s+/)[0]
    for (const script of ["script/vendor-skills.ts", "script/update-skills.ts"]) {
      const calls = gitCalls(read(script))
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.map(verb).filter((name) => name !== "rev-parse")).toEqual([])
    }
  })

  test("the provenance pin is present and names the revision", () => {
    const provenance = read("skills/PROVENANCE.md")
    expect(provenance).toMatch(/- Revision: `[0-9a-f]{40}`/)
    expect(provenance).toContain("Frozen (owner decision 2026-10-16)")
  })
})

describe("mode architecture has one tracked source", () => {
  test("both cards are managed, mirrored, and carry a Harness section", () => {
    for (const card of ["agent/auto.md", "agent/goal.md"]) {
      const bundle = read(path.join("bootstrap", card))
      expect(bundle).toBe(read(path.join("dotfiles/opencode", card)))
      expect(bundle).toContain("# Harness")
      expect(bundle).toMatch(/^mode: primary$/m)
    }
  })

  test("the seat rules file is tracked and carries the no-self-evolution rule", () => {
    const rules = read("bootstrap/AGENTS.md")
    expect(rules).toBe(read("dotfiles/opencode/AGENTS.md"))
    expect(rules).toContain("## Seat architecture: no self-evolution")
    expect(rules).toContain("**No auto-commits.**")
  })

  test("no tracked config lists the retired instruction documents", () => {
    for (const config of ["opencode.jsonc", "bootstrap/config/opencode.jsonc"]) {
      const body = read(config)
      expect(body).not.toMatch(/^\s*"instructions"\s*:/m)
      expect(body).not.toContain("autonomy.md")
      expect(body).not.toContain("AGENTS.goal.md")
    }
  })
})
