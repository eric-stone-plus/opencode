#!/usr/bin/env bun
/**
 * Operator-driven update of the vendored mattpocock skills.
 *
 * The auto-refresh plugin (`bootstrap/plugin/mpskills-update.ts`) was deleted on
 * 2026-10-16 (skills freeze): no fetch, no re-vendor, and no auto-commit while
 * the agent runs. This script is the deliberate replacement. It vendors from an
 * explicit checkout and installs the result into the seat, and does nothing
 * else: it never fetches, never commits, never pushes. The operator reviews the
 * diff and commits.
 *
 * Procedure (also in bootstrap/README.md § "Updating the vendored skills"):
 *
 *   git -C ~/.cache/opencode/mattpocock-upstream fetch origin main
 *   git -C ~/.cache/opencode/mattpocock-upstream checkout <ref>
 *   bun run update-skills --source ~/.cache/opencode/mattpocock-upstream
 *   git diff --stat skills          # review the vendored change
 *   git add skills
 *   git commit -m "chore: vendor mattpocock skills (<ref8>)"
 *   bun run check-drift
 *
 * `vendor-skills` rewrites `skills/` from scratch (and re-applies the UNFLAG and
 * description patches) — it is the only supported update path. `installSkills`
 * is the same rm+cp-per-skill install the sync script uses, so skills upstream
 * removed disappear from the seat and unrelated user skills are left alone.
 */
import { homedir } from "node:os"
import path from "node:path"
import { $ } from "bun"

const ROOT = path.resolve(import.meta.dirname, "..")
const flag = process.argv.indexOf("--source")
// No cwd fallback: an empty `--source` (or a missing value) must fail here, not resolve to the
// current directory and re-vendor from whatever checkout happens to be around.
const raw = flag === -1 ? process.env.MATTPOCOCK_SKILLS : process.argv[flag + 1]
if (!raw) throw new Error("usage: bun run update-skills --source <checkout>")
const source = path.resolve(raw)

const revision = (await $`git -C ${source} rev-parse HEAD`.quiet().nothrow()).text().trim()
if (!revision) throw new Error(`not a git checkout, or empty: ${source}`)

const vendored = await $`bun run ${path.join(ROOT, "script/vendor-skills.ts")} --source ${source}`.cwd(ROOT).nothrow()
process.stdout.write(vendored.stdout)
process.stderr.write(vendored.stderr)
if (vendored.exitCode !== 0) throw new Error(`vendor-skills failed (${vendored.exitCode})`)

const { installSkills } = await import("./sync-upstream")
const installed = await installSkills(
  path.join(ROOT, "skills"),
  path.join(homedir(), ".config", "opencode", "skills"),
)

console.log(`vendored ${revision.slice(0, 9)} and installed ${installed} skills`)
console.log(`next: review \`git diff --stat skills\`, commit "chore: vendor mattpocock skills (${revision.slice(0, 8)})", then \`bun run check-drift\``)
