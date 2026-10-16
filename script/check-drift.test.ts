import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ABSENT_FILES, collectDrift, MANAGED_FILES, MIRROR_FILES, SEED_FILES, summarize } from "./check-drift"

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
  await write(path.join(root, "bootstrap/config/opencode.jsonc"), "agent: two profiles\n")
  await write(path.join(home, ".config/opencode/opencode.jsonc"), "agent: two profiles\n")
  return { root, home }
}

function row(rows: Awaited<ReturnType<typeof collectDrift>>, label: string) {
  return rows.find((entry) => entry.label === label)
}

const cleanTotals = {
  ok: MANAGED_FILES.length + SEED_FILES.length + MIRROR_FILES.length + ABSENT_FILES.length + 7,
  drift: 0,
  missing: 0,
  seed: 0,
}

describe("collectDrift", () => {
  test("a mirrored seat reports no drift", async () => {
    const { root, home } = await mirror()
    expect(summarize(await collectDrift(root, home))).toEqual(cleanTotals)
  })

  test("a managed file that differs is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/AGENTS.md"), "edited\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "dotfiles/opencode/AGENTS.md")).toEqual({
      label: "dotfiles/opencode/AGENTS.md",
      status: "drift",
      detail: "~/.config/opencode/AGENTS.md differs",
    })
    expect(summarize(rows).drift).toBe(1)
  })

  test("a seed file that differs is seed, not drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/cli.json"), "edited\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "cli.json")).toEqual({ label: "cli.json", status: "seed", detail: "differs (seed keeps local tuning)" })
    expect(summarize(rows)).toEqual({ ok: cleanTotals.ok - 1, drift: 0, missing: 0, seed: 1 })
  })

  test("a missing seat file is missing, not drift", async () => {
    const { root, home } = await mirror()
    await rm(path.join(home, ".config/agent-hooks/run-cases.ts"))
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/agent-hooks/run-cases.ts")?.status).toBe("missing")
    expect(summarize(rows).drift).toBe(0)
  })

  test("a retired seat file that reappears is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/plugin/mpskills-update.ts"), "resurrected\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "~/.config/opencode/plugin/mpskills-update.ts")).toEqual({
      label: "~/.config/opencode/plugin/mpskills-update.ts",
      status: "drift",
      detail: "removed on purpose (2026-10-16); delete it",
    })
    // Two rows fire: the exact-name ABSENT row and the plugin-directory allowlist
    // (defense in depth — a renamed copy is caught by the second one alone).
    expect(summarize(rows).drift).toBe(2)
  })

  test("a retired repo file that comes back is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(root, "bootstrap/autonomy.md"), "resurrected\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/autonomy.md")).toEqual({
      label: "bootstrap/autonomy.md",
      status: "drift",
      detail: "removed on purpose (2026-10-16); delete it",
    })
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
    await write(path.join(home, ".config/opencode/opencode.jsonc"), "agent: changed\n")
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
    await write(path.join(root, "bootstrap/agent/auto.md"), "edited bundle copy\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/agent/auto.md")?.status).toBe("drift")
    expect(summarize(rows).drift).toBe(1)
  })

  test("a symlinked seat file is drift", async () => {
    const { root, home } = await mirror()
    const target = path.join(home, ".config/opencode/cli.json")
    await rm(target)
    await symlink(path.join(root, "cli.json"), target)
    const rows = await collectDrift(root, home)
    expect(row(rows, "cli.json")?.status).toBe("drift")
    expect(row(rows, "cli.json")?.detail).toContain("symlink")
  })

  test("a directory where a seat file belongs is drift, not a crash", async () => {
    const { root, home } = await mirror()
    const target = path.join(home, ".config/opencode/cli.json")
    await rm(target)
    await mkdir(target, { recursive: true })
    const rows = await collectDrift(root, home)
    expect(row(rows, "cli.json")?.status).toBe("drift")
    expect(summarize(rows).missing).toBe(0)
  })

  test("the audit covers exactly the files it claims to cover", () => {
    // The totals are derived from these lists, so a shrunken list would shrink the
    // audit silently. Pin the membership instead.
    expect(MANAGED_FILES.map((mapping) => mapping.source).sort()).toEqual([
      "bootstrap/agent-hooks/block-unsafe-kill.sh",
      "bootstrap/agent-hooks/cases.json",
      "bootstrap/agent-hooks/run-cases.sh",
      "bootstrap/agent-hooks/run-cases.ts",
      "bootstrap/config/environment.d/10-opencode-db.conf",
      "bootstrap/plugin/block-unsafe-kill.ts",
      "bootstrap/plugin/local-tools.ts",
      "bootstrap/plugin/open-code-review.ts",
      "bootstrap/plugin/secret-path-guard.ts",
      "bootstrap/plugin/skill-hints.ts",
      "bootstrap/shell/bashrc-opencode-block.sh",
      "dotfiles/opencode/AGENTS.md",
      "dotfiles/opencode/agent/auto.md",
      "dotfiles/opencode/agent/goal.md",
      "dotfiles/opencode/lib/drawio.py",
      "dotfiles/opencode/skills/drawio/SKILL.md",
      "dotfiles/opencode/skills/marker/SKILL.md",
      "dotfiles/opencode/skills/planning-with-files/SKILL.md",
    ])
    expect(MIRROR_FILES.map(([left, right]) => `${left}|${right}`).sort()).toEqual([
      "bootstrap/AGENTS.md|dotfiles/opencode/AGENTS.md",
      "bootstrap/agent/auto.md|dotfiles/opencode/agent/auto.md",
      "bootstrap/agent/goal.md|dotfiles/opencode/agent/goal.md",
    ])
    expect(ABSENT_FILES.map((entry) => `${entry.root}:${entry.path}`).sort()).toEqual([
      "repo:bootstrap/AGENTS.goal.md",
      "repo:bootstrap/autonomy.md",
      "repo:bootstrap/plugin/mpskills-update.ts",
      "repo:dotfiles/opencode/AGENTS.goal.md",
      "repo:dotfiles/opencode/autonomy.md",
      "repo:script/mpskills-update.test.ts",
      "seat:.config/opencode/AGENTS.goal.md",
      "seat:.config/opencode/autonomy.md",
      "seat:.config/opencode/plugin/mpskills-update.ts",
    ])
  })

  test("an unexpected seat plugin is drift, whatever its name", async () => {
    const { root, home } = await mirror()
    await write(path.join(home, ".config/opencode/plugin/skills-updater.ts"), "export default {}\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "~/.config/opencode/plugin (allowlist)")?.status).toBe("drift")
    expect(row(rows, "~/.config/opencode/plugin (allowlist)")?.detail).toContain("skills-updater.ts")
    expect(summarize(rows).drift).toBe(1)
  })

  test("a renamed refresh mechanism in the bundle is drift", async () => {
    const { root, home } = await mirror()
    await write(path.join(root, "bootstrap/plugin/mpskills-refresh.ts"), "export default {}\n")
    const rows = await collectDrift(root, home)
    expect(row(rows, "bootstrap/plugin (retired refresh mechanisms)")?.status).toBe("drift")
    expect(summarize(rows).drift).toBe(1)
  })

  test("the managed plugins are not flagged by the allowlist", async () => {
    const { root, home } = await mirror()
    const rows = await collectDrift(root, home)
    expect(row(rows, "~/.config/opencode/plugin (allowlist)")?.status).toBe("ok")
    expect(row(rows, "bootstrap/plugin (retired refresh mechanisms)")?.status).toBe("ok")
  })

  test("a trailing-slash home is normalized", async () => {
    const { root, home } = await mirror()
    expect(summarize(await collectDrift(root, `${home}/`))).toEqual(cleanTotals)
  })

  test("the script exits 0 on a mirrored seat and 1 on drift", async () => {
    const { root, home } = await mirror()
    const script = path.join(import.meta.dir, "check-drift.ts")
    const run = () => Bun.spawn([process.execPath, script, "--root", root, "--home", home], { stdout: "pipe", stderr: "pipe" })
    expect(await run().exited).toBe(0)
    // A seed that kept local tuning is not drift, so the audit still passes.
    await write(path.join(home, ".config/opencode/cli.json"), "edited\n")
    expect(await run().exited).toBe(0)
    await write(path.join(home, ".config/opencode/AGENTS.md"), "edited\n")
    expect(await run().exited).toBe(1)
  })
})
