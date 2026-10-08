import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectDrift, MANAGED_FILES, MIRROR_FILES, SEED_FILES, summarize } from "./check-drift"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-drift-test-"))
  directories.push(directory)
  return directory
}

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
}

// A minimal repo checkout and seat where every mapped file matches.
async function mirror() {
  const root = await temporary()
  const home = await temporary()
  for (const mapping of [...MANAGED_FILES, ...SEED_FILES]) {
    await write(path.join(root, mapping.source), `content of ${mapping.source}\n`)
    await write(path.join(home, mapping.destination), `content of ${mapping.source}\n`)
  }
  for (const [left, right] of MIRROR_FILES) {
    await write(path.join(root, left), `content of ${right}\n`)
    await write(path.join(root, right), `content of ${right}\n`)
  }
  await write(path.join(root, "skills/ask-matt/SKILL.md"), "skill body\n")
  await write(path.join(home, ".config/opencode/skills/ask-matt/SKILL.md"), "skill body\n")
  await write(path.join(root, "skills/LICENSE"), "license\n")
  await write(path.join(home, ".config/opencode/skills/LICENSE"), "license\n")
  await write(path.join(root, "skills/PROVENANCE.md"), "provenance\n")
  await write(path.join(home, ".config/opencode/skills/PROVENANCE.md"), "provenance\n")
  await write(path.join(root, "bootstrap/skills-extra/longrun-stability-audit/SKILL.md"), "orphan skill\n")
  await write(path.join(home, ".config/opencode/skills/longrun-stability-audit/SKILL.md"), "orphan skill\n")
  await write(path.join(root, "bootstrap/config/opencode.jsonc"), "plans: home/eric/.local/share/opencode/plans/\n")
  await write(path.join(home, ".config/opencode/opencode.jsonc"), `plans: ${home.replace(/^\//, "")}/.local/share/opencode/plans/\n`)
  return { root, home }
}

function row(rows: Awaited<ReturnType<typeof collectDrift>>, label: string) {
  return rows.find((entry) => entry.label === label)
}

const cleanTotals = { ok: MANAGED_FILES.length + SEED_FILES.length + MIRROR_FILES.length + 5, drift: 0, missing: 0, seed: 0 }

describe("collectDrift", () => {
  test("a mirrored seat reports no drift", async () => {
    const { root, home } = await mirror()
    expect(summarize(await collectDrift(root, home))).toEqual(cleanTotals)
  })

  test("a managed file that differs is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/tui.json"), "edited\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "tui.json")).toEqual({ label: "tui.json", status: "drift", detail: "~/.config/opencode/tui.json differs" })
    expect(summarize(rows).drift).toBe(1)
  })

  test("a missing seat file is missing, not drift", async () => {
    const { root, home } = await mirror()
    await rm(path.join(home, ".config/agent-hooks/run-cases.ts"))
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/agent-hooks/run-cases.ts")?.status).toBe("missing")
    expect(summarize(rows).drift).toBe(0)
  })

  test("a seed file that differs keeps its status and is not drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/agent/goal.md"), "machine-pinned model\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "dotfiles/opencode/agent/goal.md")).toEqual({
      label: "dotfiles/opencode/agent/goal.md",
      status: "seed",
      detail: "differs (seed keeps local tuning)",
    })
    expect(summarize(rows).drift).toBe(0)
  })

  test("a changed file inside a vendored skill is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/skills/ask-matt/SKILL.md"), "edited skill\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "skills/ask-matt")).toEqual({
      label: "skills/ask-matt",
      status: "drift",
      detail: "content differs: SKILL.md",
    })
  })

  test("an extra file inside a vendored skill is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/skills/ask-matt/EXTRA.md"), "hand-added\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "skills/ask-matt")?.detail).toBe("extra in seat: EXTRA.md")
  })

  test("an unrelated skill in the seat is not reported", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/skills/user-skill/SKILL.md"), "user skill\n")
    const rows = await collectDrift(root, home)
    expect(rows.some((entry) => entry.label.includes("user-skill"))).toBe(false)
    expect(summarize(rows).drift).toBe(0)
  })

  test("a drifted skills-extra copy is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/skills/longrun-stability-audit/SKILL.md"), "edited orphan\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/skills-extra/longrun-stability-audit")?.status).toBe("drift")
  })

  test("a live config that evolved past the bundle snapshot is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/opencode.jsonc"), "plans: changed\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/config/opencode.jsonc")).toEqual({
      label: "bootstrap/config/opencode.jsonc",
      status: "drift",
      detail: "live config differs; refresh the snapshot from the live file",
    })
  })

  test("an agent-hook rewritten for the target home is ok", async () => {
    const { root, home } = await mirror()
    await write(path.join(root, "bootstrap/agent-hooks/block-unsafe-kill.sh"), "exec /home/eric/.config/agent-hooks/block-unsafe-kill.sh\n")
    await write(path.join(home, ".config/agent-hooks/block-unsafe-kill.sh"), `exec ${home}/.config/agent-hooks/block-unsafe-kill.sh\n`)
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/agent-hooks/block-unsafe-kill.sh")?.status).toBe("ok")
  })

  test("a bundle copy that diverged from its dotfiles mirror is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(root, "bootstrap/AGENTS.goal.md"), "edited bundle copy\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/AGENTS.goal.md")?.status).toBe("drift")
    expect(summarize(rows).drift).toBe(1)
  })

  test("a symlinked seat file is drift", async () => {
    const { root, home } = await mirror()
    const target = path.join(home, ".config/opencode/tui.json")
    await rm(target)
    await symlink(path.join(root, "tui.json"), target)
    const rows = await collectDrift(root, home)
    expect(row(rows, "tui.json")?.status).toBe("drift")
    expect(row(rows, "tui.json")?.detail).toContain("symlink")
  })

  test("a directory where a seat file belongs is drift, not a crash", async () => {
    const { root, home } = await mirror()
    const target = path.join(home, ".config/opencode/tui.json")
    await rm(target)
    await mkdir(target, { recursive: true })
    const rows = await collectDrift(root, home)
    expect(row(rows, "tui.json")?.status).toBe("drift")
    expect(summarize(rows).missing).toBe(0)
  })

  test("a trailing-slash home is normalized", async () => {
    const { root, home } = await mirror()
    expect(summarize(await collectDrift(root, `${home}/`))).toEqual(cleanTotals)
  })

  test("the script exits 0 on a mirrored seat and 1 on drift", async () => {
    const { root, home } = await mirror()
    const script = path.join(import.meta.dir, "check-drift.ts")
    const clean = Bun.spawn([process.execPath, script, "--root", root, "--home", home], { stdout: "pipe", stderr: "pipe" })
    expect(await clean.exited).toBe(0)
    await write(path.join(home, ".config/opencode/tui.json"), "edited\n")
    const drifted = Bun.spawn([process.execPath, script, "--root", root, "--home", home], { stdout: "pipe", stderr: "pipe" })
    expect(await drifted.exited).toBe(1)
  })
})
