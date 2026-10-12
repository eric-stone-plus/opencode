#!/usr/bin/env bun
/**
 * Keep personal `main` on top of official OpenCode.
 *
 * Official default branch is `dev` (anomalyco/opencode).
 * This fork publishes a single `main`.
 *
 *   bun run sync-upstream              fetch, merge, check, install, build, push
 *   bun run sync-upstream --no-rebuild skip the binary rebuild
 *   bun run sync-upstream --continue   after resolving merge conflicts and committing
 *
 * The flow merges upstream/dev into main (never rebases), then refuses to
 * build or push if upstream reintroduced a self-update path this fork deleted
 * on purpose (see assertForkInvariants). The product is packages/cli (upstream
 * V2); the legacy packages/opencode runtime no longer exists.
 */
import { $ } from "bun"
import { homedir } from "os"
import path from "path"
import { existsSync } from "fs"
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from "fs/promises"

const ROOT = path.resolve(import.meta.dirname, "..")
const UPSTREAM_URL = "https://github.com/anomalyco/opencode.git"
const UPSTREAM_BRANCH = "dev"
const LOCAL_BRANCH = "main"
const MINIMUM_BUN = [1, 4, 2]

export function assertBunVersion(version: string) {
  const found = version.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const order = MINIMUM_BUN.reduce((result, minimum, index) => result || Math.sign((found[index] ?? 0) - minimum), 0)
  if (order < 0) throw new Error(`bun >= ${MINIMUM_BUN.join(".")} is required (found ${version}).`)
}

async function git(args: string[], directory = ROOT) {
  const result = await $`git ${args}`.cwd(directory).nothrow().quiet()
  return {
    ok: result.exitCode === 0,
    text: result.text().trim(),
    error: result.stderr.toString().trim(),
    code: result.exitCode,
  }
}

async function mustGit(args: string[], directory = ROOT) {
  const result = await git(args, directory)
  if (!result.ok) {
    throw new Error(result.error || result.text || `git ${args.join(" ")} failed (${result.code})`)
  }
  return result.text
}

export async function assertSyncReady(directory: string, resume = false) {
  const mergeHead = await mustGit(["rev-parse", "--git-path", "MERGE_HEAD"], directory)
  if (existsSync(path.resolve(directory, mergeHead))) {
    throw new Error(
      "Finish the merge first: resolve files, then `git add -A && git commit --no-edit`.\n" +
        "When the merge is committed, run: bun run sync-upstream --continue\n" +
        "To abort: git merge --abort",
    )
  }
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const location = await mustGit(["rev-parse", "--git-path", state], directory)
    if (existsSync(path.resolve(directory, location))) {
      throw new Error(
        "A rebase is in progress; this script merges and never rebases.\n" +
          "Finish it (`git rebase --continue`) or drop it (`git rebase --abort`), then rerun bun run sync-upstream.",
      )
    }
  }

  const dirty = await mustGit(["status", "--porcelain"], directory)
  if (dirty) throw new Error(`Working tree is dirty. Commit or stash first.\n${dirty}`)
  if (!resume) return

  const branch = await mustGit(["branch", "--show-current"], directory)
  if (branch !== LOCAL_BRANCH) {
    throw new Error(`Continue sync from ${LOCAL_BRANCH}, not ${branch || "detached HEAD"}.`)
  }
  const ancestry = await git(["merge-base", "--is-ancestor", `upstream/${UPSTREAM_BRANCH}`, "HEAD"], directory)
  if (!ancestry.ok) {
    throw new Error(
      ancestry.error ||
        `Merge of upstream/${UPSTREAM_BRANCH} into ${LOCAL_BRANCH} is not complete. Run bun run sync-upstream first.`,
    )
  }
}

// Self-update paths this fork deleted on purpose: the upgrade/uninstall commands
// and the updater's network calls would replace or remove the source-built
// ~/.opencode/bin/opencode (docs/adr/0001-source-built-binary-no-self-upgrade.md).
// A clean upstream merge can bring any of them back silently, so the sync
// refuses to build or push until they are gone again.
export const FORK_DELETED_FILES = [
  "packages/cli/src/commands/handlers/upgrade.ts",
  "packages/cli/src/commands/handlers/uninstall.ts",
]
const CLI_ENTRY = "packages/cli/src/index.ts"
const CLI_COMMANDS = "packages/cli/src/commands/commands.ts"
const FORK_DELETED_LOADERS = ["commands/handlers/upgrade", "commands/handlers/uninstall"]
const FORK_DELETED_SPECS = ["upgrade", "uninstall"]
// ERE for git grep: the release lookup and installer endpoints of the upstream updater.
const UPDATER_NETWORK = "opencode\\.ai/(update/api|v2/install)|formulae\\.brew\\.sh/api/formula/opencode"

export async function assertForkInvariants(directory: string) {
  const problems: string[] = []
  for (const file of FORK_DELETED_FILES) {
    if (existsSync(path.join(directory, file))) problems.push(`${file} exists again`)
  }
  const entry = path.join(directory, CLI_ENTRY)
  if (existsSync(entry)) {
    const source = await readFile(entry, "utf8")
    for (const name of FORK_DELETED_LOADERS) {
      if (source.includes(name)) problems.push(`${CLI_ENTRY} loads ${name}`)
    }
  }
  const commands = path.join(directory, CLI_COMMANDS)
  if (existsSync(commands)) {
    const source = await readFile(commands, "utf8")
    for (const name of FORK_DELETED_SPECS) {
      if (source.includes(`Spec.make("${name}"`)) problems.push(`${CLI_COMMANDS} registers the ${name} command`)
    }
  }
  const calls = await git(["grep", "-n", "-E", UPDATER_NETWORK, "--", "packages/cli/src"], directory)
  if (calls.ok && calls.text) {
    problems.push(`updater network call site(s):\n${calls.text.replace(/^/gm, "      ")}`)
  } else if (!calls.ok && calls.code !== 1) {
    throw new Error(calls.error || `git grep failed (${calls.code})`)
  }
  if (problems.length === 0) return
  throw new Error(
    "Upstream reintroduced self-update paths this fork deleted (they would overwrite the source-built binary):\n" +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      "\nRemove them again, commit, then run: bun run sync-upstream --continue",
  )
}

export async function installBinary(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true })
  // Stage beside the live binary so rename stays atomic, including while the
  // previous inode is executing on Linux (an in-place copy fails with ETXTBSY).
  const staging = await mkdtemp(path.join(path.dirname(destination), ".opencode-install-"))
  try {
    const temporary = path.join(staging, path.basename(destination))
    await copyFile(source, temporary)
    await chmod(temporary, 0o755)
    await rename(temporary, destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function main() {
  assertBunVersion(Bun.version)
  const noRebuild = process.argv.includes("--no-rebuild")
  const resume = process.argv.includes("--continue")
  await assertSyncReady(ROOT, resume)

  // Reuse recorded conflict resolutions across merges: recurring upstream
  // conflicts (e.g. the Zen-provider deletion) auto-resolve after the first
  // manual resolution. Local to this clone; harmless on fresh machines.
  await mustGit(["config", "rerere.enabled", "true"])

  if (!resume) {
    const remotes = await mustGit(["remote"])
    if (!remotes.split("\n").includes("upstream")) {
      await mustGit(["remote", "add", "upstream", UPSTREAM_URL])
      console.log(`added remote upstream -> ${UPSTREAM_URL}`)
    }

    await mustGit(["checkout", LOCAL_BRANCH])
    console.log("fetching upstream…")
    await mustGit(["fetch", "upstream", UPSTREAM_BRANCH])

    const onto = `upstream/${UPSTREAM_BRANCH}`
    const ahead = await mustGit(["rev-list", "--count", `${onto}..HEAD`])
    const behind = await mustGit(["rev-list", "--count", `HEAD..${onto}`])
    console.log(
      `personal commits on ${LOCAL_BRANCH}: ${ahead}; upstream ${UPSTREAM_BRANCH} is ${behind} commit(s) ahead`,
    )

    if (behind === "0") {
      console.log("already up to date with upstream")
    } else {
      console.log(`merging ${onto} into ${LOCAL_BRANCH}…`)
      const merge = await git(["merge", "--no-edit", onto])
      if (!merge.ok) {
        throw new Error(
          `${merge.error || merge.text}\n\nConflict. Fix files, then:\n` +
            "  git add -A && git commit --no-edit\n" +
            "  bun run sync-upstream --continue\n" +
            "To abort: git merge --abort",
        )
      }
    }
  }

  await assertSyncReady(ROOT, true)
  await assertForkInvariants(ROOT)
  const personal = await mustGit(["log", "--oneline", `upstream/${UPSTREAM_BRANCH}..HEAD`])
  if (personal) {
    console.log("kept on top of upstream:")
    console.log(personal)
  } else {
    console.log("warning: no personal commits on top of upstream (main == upstream/dev)")
  }

  const pkg = path.join(ROOT, "packages/cli")
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const binary = process.platform === "win32" ? "opencode.exe" : "opencode"
  const built = path.join(
    pkg,
    "dist",
    `cli-${process.platform === "win32" ? "windows" : process.platform}-${arch}`,
    "bin",
    binary,
  )
  if (!noRebuild) {
    console.log("installing dependencies from bun.lock…")
    const install = await $`bun install --frozen-lockfile`.cwd(ROOT).nothrow()
    if (install.exitCode !== 0) throw new Error(`Dependency install failed (${install.exitCode})`)

    console.log(`rebuilding ${process.platform}-${process.arch} binary…`)
    const build = await $`bun run script/build.ts --single --skip-install --skip-web-ui`.cwd(pkg).nothrow()
    if (build.exitCode !== 0) throw new Error(`Build failed (${build.exitCode})`)
    if (!existsSync(built)) throw new Error(`Built binary missing: ${built}`)

    // Scripts under script/ are part of the harness this fork ships; a broken
    // one (e.g. check-drift or this sync itself) must not ride a push.
    console.log("running script tests…")
    const scriptTests = await $`bun test`.cwd(path.join(ROOT, "script")).nothrow()
    if (scriptTests.exitCode !== 0) throw new Error(`Script tests failed (${scriptTests.exitCode})`)
  }

  // A failed install/build must not publish an unverified merge. Also catch
  // tracked files accidentally changed by package lifecycle/build scripts.
  await assertSyncReady(ROOT, true)
  await assertForkInvariants(ROOT)
  console.log("pushing origin/main…")
  await mustGit(["push", "origin", LOCAL_BRANCH])

  const tuiInstalled = await installTuiConfig(ROOT, path.join(homedir(), ".config", "opencode"))
  if (tuiInstalled) console.log(`installed ${tuiInstalled}`)

  const skillsSrc = path.join(ROOT, "skills")
  if (existsSync(skillsSrc)) {
    const installed = await installSkills(skillsSrc, path.join(homedir(), ".config", "opencode", "skills"))
    console.log(`installed ${installed} vendored skills`)
  }

  const dotfilesSrc = path.join(ROOT, "dotfiles", "opencode")
  if (existsSync(dotfilesSrc)) {
    const report = await installGoalConfig(dotfilesSrc, path.join(homedir(), ".config", "opencode"))
    for (const line of report) console.log(line)
  }

  if (noRebuild) {
    console.log("done (rebuild skipped)")
    return
  }

  const dest = path.join(homedir(), ".opencode", "bin", binary)
  await installBinary(built, dest)
  const version = await $`${dest} --version`.text()
  console.log(`installed ${dest}`)
  console.log(version.trim())
}

// V2 migrates tui.json into cli.json exactly once and ignores later tui.json edits, so the
// deployed keybinds file is cli.json whenever the repo carries one (dotfiles/opencode/cli.json);
// the legacy repo-root tui.json is the fallback that still seeds a fresh config directory.
export async function installTuiConfig(root: string, configDir: string) {
  const cli = path.join(root, "dotfiles", "opencode", "cli.json")
  const legacy = path.join(root, "tui.json")
  const source = existsSync(cli) ? cli : existsSync(legacy) ? legacy : undefined
  if (!source) return undefined
  const destination = path.join(configDir, path.basename(source))
  await mkdir(configDir, { recursive: true })
  await copyFile(source, destination)
  return destination
}

// Replaces each vendored skill directory in place rather than merging into it,
// so a skill dropped upstream disappears instead of lingering with stale
// resources. Unrelated skills the user added by hand are left untouched: a
// name only counts as "ours to remove" if destination's own PROVENANCE.md
// listed it before this call, never merely because it's absent from source.
export async function installSkills(source: string, destination: string) {
  await mkdir(destination, { recursive: true })
  const dropped = (await previouslyVendored(destination)).difference(
    new Set(await readdir(path.join(source))),
  )
  for (const name of dropped) {
    await rm(path.join(destination, name), { recursive: true, force: true })
  }

  const entries = await readdir(source, { withFileTypes: true })
  const skills = entries.filter(
    (entry) => entry.isDirectory() && existsSync(path.join(source, entry.name, "SKILL.md")),
  )
  for (const skill of skills) {
    const target = path.join(destination, skill.name)
    await rm(target, { recursive: true, force: true })
    await cp(path.join(source, skill.name), target, { recursive: true })
  }
  for (const file of entries.filter((entry) => entry.isFile())) {
    await copyFile(path.join(source, file.name), path.join(destination, file.name))
  }
  return skills.length
}

async function previouslyVendored(destination: string): Promise<Set<string>> {
  const provenance = path.join(destination, "PROVENANCE.md")
  if (!existsSync(provenance)) return new Set()
  const text = await readFile(provenance, "utf8")
  return new Set([...text.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].flatMap((match) => (match[1] ? [match[1]] : [])))
}

// Goal-mode config distribution. Managed content (AGENTS.goal.md,
// autonomy.md) is replaced on every sync. The agent definition is a seed:
// installed only when absent, so per-machine tuning (e.g. pinned model or
// variant) survives subsequent syncs. The goal objective is no longer set by a
// /goal command (removed) — goal mode seeds its own goal file.
export async function installGoalConfig(source: string, configDir: string) {
  const report: string[] = []
  const managed: Array<[string, string]> = [
    ["AGENTS.goal.md", "AGENTS.goal.md"],
    ["autonomy.md", "autonomy.md"],
  ]
  for (const [relSrc, relDest] of managed) {
    const src = path.join(source, relSrc)
    if (!existsSync(src)) continue
    const dest = path.join(configDir, relDest)
    await mkdir(path.dirname(dest), { recursive: true })
    await rm(dest, { force: true })
    await copyFile(src, dest)
    report.push(`installed ${dest}`)
  }
  const agentSrc = path.join(source, "agent/goal.md")
  if (existsSync(agentSrc)) {
    const agentDest = path.join(configDir, "agent/goal.md")
    await mkdir(path.dirname(agentDest), { recursive: true })
    if (existsSync(agentDest)) {
      report.push(`kept existing ${agentDest} (agent definition is a seed)`)
    } else {
      await copyFile(agentSrc, agentDest)
      report.push(`installed ${agentDest}`)
    }
  }
  return report
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
