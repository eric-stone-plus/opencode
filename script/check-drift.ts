// Repo → seat drift audit. Compares the files this checkout deploys (via
// `sync-upstream`, `script/install-local-tools.ts`, and `bootstrap/install.sh`)
// against the live seat, read-only. `bootstrap/verify.sh` is the seat-side
// audit (DB, auth, hook wiring); this is the repo-side counterpart: does the
// seat still match this checkout?
//
// Usage:
//   bun run check-drift [--home <path>] [--root <path>]
//
// Exit 1 on drift or a missing required file. `agent/goal.md` is a seed: it is
// required to exist, but content differences are local tuning and not drift.
// File modes and installer-managed extras outside the mappings below are out of
// scope (verify.sh covers the executable bits it cares about).

import { existsSync, lstatSync, statSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export type Row = {
  label: string
  status: "ok" | "drift" | "missing" | "seed"
  detail?: string
}

type Mapping = {
  source: string
  destination: string
  // install.sh step 5 rewrites the machine-A home anchor for the target home
  // (sed with /g); on this machine the rewrite is the identity.
  home?: boolean
}

// Managed files: the seat copy must be byte-identical to the repo copy.
export const MANAGED_FILES: Mapping[] = [
  { source: "dotfiles/opencode/AGENTS.goal.md", destination: ".config/opencode/AGENTS.goal.md" },
  { source: "dotfiles/opencode/autonomy.md", destination: ".config/opencode/autonomy.md" },
  { source: "tui.json", destination: ".config/opencode/tui.json" },
  { source: "bootstrap/agent-hooks/block-unsafe-kill.sh", destination: ".config/agent-hooks/block-unsafe-kill.sh", home: true },
  { source: "bootstrap/agent-hooks/cases.json", destination: ".config/agent-hooks/cases.json", home: true },
  { source: "bootstrap/agent-hooks/run-cases.sh", destination: ".config/agent-hooks/run-cases.sh", home: true },
  { source: "bootstrap/agent-hooks/run-cases.ts", destination: ".config/agent-hooks/run-cases.ts", home: true },
  { source: "bootstrap/plugin/block-unsafe-kill.ts", destination: ".config/opencode/plugin/block-unsafe-kill.ts" },
  { source: "bootstrap/plugin/mpskills-update.ts", destination: ".config/opencode/plugin/mpskills-update.ts" },
  { source: "bootstrap/plugin/secret-path-guard.ts", destination: ".config/opencode/plugin/secret-path-guard.ts" },
  { source: "bootstrap/plugin/open-code-review.ts", destination: ".config/opencode/plugin/open-code-review.ts" },
  { source: "bootstrap/shell/bashrc-opencode-block.sh", destination: ".config/opencode/shell/bashrc-opencode-block.sh" },
  { source: "bootstrap/config/environment.d/10-opencode-db.conf", destination: ".config/environment.d/10-opencode-db.conf" },
  { source: "dotfiles/opencode/tools/planning.ts", destination: ".config/opencode/tools/planning.ts" },
  { source: "dotfiles/opencode/tools/drawio.ts", destination: ".config/opencode/tools/drawio.ts" },
  { source: "dotfiles/opencode/tools/marker.ts", destination: ".config/opencode/tools/marker.ts" },
  { source: "dotfiles/opencode/lib/local-tools.ts", destination: ".config/opencode/lib/local-tools.ts" },
  { source: "dotfiles/opencode/lib/drawio.py", destination: ".config/opencode/lib/drawio.py" },
  { source: "dotfiles/opencode/skills/planning-with-files/SKILL.md", destination: ".config/opencode/skills/planning-with-files/SKILL.md" },
  { source: "dotfiles/opencode/skills/drawio/SKILL.md", destination: ".config/opencode/skills/drawio/SKILL.md" },
  { source: "dotfiles/opencode/skills/marker/SKILL.md", destination: ".config/opencode/skills/marker/SKILL.md" },
]

// Bundle ↔ dotfiles mirrors: install.sh deploys the bundle copies to the same
// seat paths sync-upstream fills from dotfiles/; the two repo copies must stay
// byte-identical or the seat flips sources between runs.
export const MIRROR_FILES: Array<[string, string]> = [
  ["bootstrap/AGENTS.goal.md", "dotfiles/opencode/AGENTS.goal.md"],
  ["bootstrap/autonomy.md", "dotfiles/opencode/autonomy.md"],
  ["bootstrap/agent/goal.md", "dotfiles/opencode/agent/goal.md"],
]

// Seed file: required to exist; content may differ (per-machine tuning).
export const SEED_FILES: Mapping[] = [
  { source: "dotfiles/opencode/agent/goal.md", destination: ".config/opencode/agent/goal.md" },
]

async function sameContent(left: string, right: string) {
  const [a, b] = await Promise.all([Bun.file(left).bytes(), Bun.file(right).bytes()])
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory() ? (await tree(path.join(root, entry.name))).map((f) => path.join(entry.name, f)) : [entry.name],
    ),
  )
  return files.flat().sort()
}

// Full both-ways comparison of a source tree against its seat copy.
async function directoryDiff(source: string, destination: string): Promise<string | undefined> {
  const [wanted, present] = await Promise.all([tree(source), tree(destination)])
  const missing = wanted.filter((file) => !present.includes(file))
  const extra = present.filter((file) => !wanted.includes(file))
  if (missing.length) return `missing in seat: ${missing.slice(0, 3).join(", ")}`
  if (extra.length) return `extra in seat: ${extra.slice(0, 3).join(", ")}`
  for (const file of wanted) {
    if (!(await sameContent(path.join(source, file), path.join(destination, file)))) return `content differs: ${file}`
  }
  return undefined
}

// The seat is arbitrary filesystem state: a directory where a file belongs, a
// broken symlink inside a skill, or an unreadable file must be reported as a
// row, not abort the audit with a stack trace.
async function guard(label: string, build: () => Promise<Row>): Promise<Row> {
  try {
    return await build()
  } catch (error) {
    return { label, status: "drift", detail: `unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const rewriteHome = (text: string, home: string) => text.replaceAll("/home/eric", () => home)

async function fileRow(root: string, home: string, mapping: Mapping, seed = false): Promise<Row> {
  const label = mapping.source
  const src = path.join(root, mapping.source)
  const dest = path.join(home, mapping.destination)
  if (!existsSync(src)) return { label, status: "missing", detail: "repo copy missing (check the mapping)" }
  if (!existsSync(dest)) return { label, status: "missing", detail: `seat copy missing: ~/${mapping.destination}` }
  if (lstatSync(dest).isSymbolicLink()) return { label, status: "drift", detail: `seat copy is a symlink: ~/${mapping.destination}` }
  const expected = mapping.home ? rewriteHome(await Bun.file(src).text(), home) : await Bun.file(src).text()
  if (expected !== (await Bun.file(dest).text())) {
    return seed
      ? { label, status: "seed", detail: "differs (seed keeps local tuning)" }
      : { label, status: "drift", detail: `~/${mapping.destination} differs` }
  }
  return { label, status: "ok" }
}

async function mirrorRow(root: string, left: string, right: string): Promise<Row> {
  const src = path.join(root, left)
  const other = path.join(root, right)
  if (!existsSync(src)) return { label: left, status: "missing", detail: "repo copy missing (check the mapping)" }
  if (!existsSync(other)) return { label: left, status: "missing", detail: `repo copy missing: ${right}` }
  if ((await Bun.file(src).text()) !== (await Bun.file(other).text())) {
    return { label: left, status: "drift", detail: `differs from ${right}` }
  }
  return { label: left, status: "ok" }
}

async function dirRow(root: string, home: string, source: string, destination: string): Promise<Row> {
  const src = path.join(root, source)
  const dest = path.join(home, destination)
  if (!existsSync(src)) return { label: source, status: "missing", detail: "repo copy missing (check the mapping)" }
  if (!existsSync(dest)) return { label: source, status: "missing", detail: `seat copy missing: ~/${destination}` }
  if (lstatSync(dest).isSymbolicLink()) return { label: source, status: "drift", detail: `seat copy is a symlink: ~/${destination}` }
  const reason = await directoryDiff(src, dest)
  return reason ? { label: source, status: "drift", detail: reason } : { label: source, status: "ok" }
}

async function skillRows(root: string, home: string): Promise<Row[]> {
  const source = path.join(root, "skills")
  if (!existsSync(source)) return [{ label: "skills", status: "missing", detail: "repo copy missing (check --root)" }]
  const entries = await readdir(source, { withFileTypes: true })
  const skills = entries.filter((entry) => entry.isDirectory() && existsSync(path.join(source, entry.name, "SKILL.md")))
  return Promise.all([
    ...entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        guard(path.join("skills", entry.name), () =>
          fileRow(root, home, { source: path.join("skills", entry.name), destination: `.config/opencode/skills/${entry.name}` }),
        ),
      ),
    ...skills.map((entry) =>
      guard(path.join("skills", entry.name), () =>
        dirRow(root, home, path.join("skills", entry.name), `.config/opencode/skills/${entry.name}`),
      ),
    ),
  ])
}

async function skillsExtraRows(root: string, home: string): Promise<Row[]> {
  const source = path.join(root, "bootstrap/skills-extra")
  if (!existsSync(source)) return [{ label: "bootstrap/skills-extra", status: "missing", detail: "repo copy missing (check --root)" }]
  const entries = await readdir(source, { withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        guard(path.join("bootstrap/skills-extra", entry.name), () =>
          dirRow(root, home, path.join("bootstrap/skills-extra", entry.name), `.config/opencode/skills/${entry.name}`),
        ),
      ),
  )
}

// install.sh converges the live config FROM the bundle snapshot (step 2 sed
// replaces the first anchor per line — no /g — with an escaped literal). A
// stale snapshot would overwrite a live config that evolved past it, so
// compare after applying the same transformation. The `--link` seat mode is
// not modeled (documented unused; it keeps the bundle copy unrewritten).
async function configSnapshotRow(root: string, home: string): Promise<Row> {
  const label = "bootstrap/config/opencode.jsonc"
  const source = path.join(root, label)
  const destination = path.join(home, ".config/opencode/opencode.jsonc")
  if (!existsSync(source)) return { label, status: "missing", detail: "repo copy missing (check the mapping)" }
  if (!existsSync(destination)) return { label, status: "missing", detail: "seat copy missing: ~/.config/opencode/opencode.jsonc" }
  const seatHome = home.replace(/^\//, "")
  const expected = (await Bun.file(source).text())
    .split("\n")
    .map((line) => line.replace("home/eric/.local/share/opencode/plans/", () => `${seatHome}/.local/share/opencode/plans/`))
    .join("\n")
  if (expected !== (await Bun.file(destination).text())) {
    return { label, status: "drift", detail: "live config differs; refresh the snapshot from the live file" }
  }
  return { label, status: "ok" }
}

export async function collectDrift(root: string, home: string): Promise<Row[]> {
  // install.sh normalizes a trailing slash before rewriting; match it so
  // `--home ~/` does not misreport the config row.
  const seat = home.replace(/\/+$/, "") || "/"
  return [
    ...(await Promise.all(MANAGED_FILES.map((mapping) => guard(mapping.source, () => fileRow(root, seat, mapping))))),
    ...(await Promise.all(SEED_FILES.map((mapping) => guard(mapping.source, () => fileRow(root, seat, mapping, true))))),
    ...(await Promise.all(MIRROR_FILES.map(([left, right]) => guard(left, () => mirrorRow(root, left, right))))),
    await guard("bootstrap/config/opencode.jsonc", () => configSnapshotRow(root, seat)),
    ...(await skillRows(root, seat)),
    ...(await skillsExtraRows(root, seat)),
  ]
}

export function summarize(rows: Row[]) {
  const count = (status: Row["status"]) => rows.filter((row) => row.status === status).length
  return { ok: count("ok"), drift: count("drift"), missing: count("missing"), seed: count("seed") }
}

if (import.meta.main) {
  const value = (flag: string) => {
    const index = process.argv.indexOf(flag)
    if (index === -1) return undefined
    const argument = process.argv[index + 1]
    if (!argument || argument.startsWith("--")) throw new Error(`${flag} needs a value`)
    return argument
  }
  const root = value("--root") ?? path.resolve(import.meta.dir, "..")
  const home = value("--home") ?? homedir()
  if (!existsSync(root)) throw new Error(`root does not exist: ${root}`)
  if (!statSync(root).isDirectory()) throw new Error(`root is not a directory: ${root}`)
  const rows = await collectDrift(root, home)
  for (const row of rows) console.log(`${row.status.padEnd(7)} ${row.label}${row.detail ? ` — ${row.detail}` : ""}`)
  const totals = summarize(rows)
  console.log(`\n== check-drift: ${totals.ok} ok, ${totals.drift} drift, ${totals.missing} missing, ${totals.seed} seed ==`)
  if (totals.drift || totals.missing) {
    console.log("converge: bun run sync-upstream (repo files) or bash bootstrap/install.sh (bundle files)")
    process.exitCode = 1
  }
}
