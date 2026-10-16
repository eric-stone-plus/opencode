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

// The same call through node:child_process — exactly how the deleted auto-updater
// reached git. A `$`-only scan cannot see it, so the shape is banned outright:
// none of these files has a legitimate reason to spawn git directly.
const SPAWN_GIT = /\b(?:Bun\.spawn|spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*["'`]git(?:["'`\s])/

// The revision the seat is expected to carry. A re-vendor must update this line in
// the same commit (bun run update-skills prints the revision) — that friction is the
// freeze working, and it is what stops a silent refresh from landing unnoticed.
const PINNED_REVISION = "49dd158d1076134a641b33efb035946536778336"

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

  test("no source outside the operator scripts carries a skills-refresh path", () => {
    // The retired mechanism lived in a plugin, but a refresh path in core or in the
    // CLI would be the same self-evolution with a different address.
    const packages = path.join(ROOT, "packages")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name) && /mattpocock|mpskills|vendor-skills|update-skills/.test(readFileSync(full, "utf8")))
          offenders.push(path.relative(ROOT, full))
      }
    }
    walk(packages)
    expect(offenders).toEqual([])
  })

  test("no plugin shells out to a git write", () => {
    const offenders = plugins().filter((file) => {
      const body = readFileSync(path.join(PLUGIN_DIR, file), "utf8")
      if (SPAWN_GIT.test(body)) return true
      return gitCalls(body).some((call) => /\b(fetch|clone|commit|push|reset|checkout|add)\b/.test(call))
    })
    expect(offenders).toEqual([])
  })

  test("the operator update path performs no git write", () => {
    // Strip an optional `-C <path>` and require the verb to be a read.
    const verb = (call: string) => call.replace(/^-C\s+\S+\s+/, "").split(/\s+/)[0]
    for (const script of ["script/vendor-skills.ts", "script/update-skills.ts"]) {
      const body = read(script)
      expect(body).not.toMatch(SPAWN_GIT)
      const calls = gitCalls(body)
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.map(verb).filter((name) => name !== "rev-parse")).toEqual([])
    }
  })

  test("the provenance pin is the frozen revision", () => {
    const provenance = read("skills/PROVENANCE.md")
    expect(provenance).toContain(`- Revision: \`${PINNED_REVISION}\``)
    expect(provenance).toContain("Frozen (owner decision 2026-10-16)")
  })

  test("the operator update command exists", () => {
    // bootstrap/README.md, skills/PROVENANCE.md and the seat rules all tell the
    // operator to run `bun run update-skills`; a documented command that does not
    // exist is worse than no documentation.
    const scripts = JSON.parse(read("package.json")).scripts ?? {}
    expect(scripts["update-skills"]).toBeDefined()
    expect(scripts["vendor-skills"]).toBeDefined()
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
