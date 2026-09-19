#!/usr/bin/env bun
/**
 * Keep personal `main` on top of official OpenCode.
 *
 * Official default branch is `dev` (anomalyco/opencode).
 * This fork publishes a single `main`.
 *
 *   bun run sync-upstream              fetch, rebase, install, build, push
 *   bun run sync-upstream --no-rebuild skip the binary rebuild
 *   bun run sync-upstream --continue   after fixing rebase conflicts
 */
import { $ } from "bun"
import { homedir } from "os"
import path from "path"
import { existsSync } from "fs"
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "fs/promises"

const ROOT = path.resolve(import.meta.dirname, "..")
const UPSTREAM_URL = "https://github.com/anomalyco/opencode.git"
const UPSTREAM_BRANCH = "dev"
const LOCAL_BRANCH = "main"
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
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const location = await mustGit(["rev-parse", "--git-path", state], directory)
    if (existsSync(path.resolve(directory, location))) {
      throw new Error(
        "Finish the rebase first: resolve files, then `git add` and `git rebase --continue`.\n" +
          "When git rebase is done, run: bun run sync-upstream --continue",
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
      ancestry.error || `Rebase onto upstream/${UPSTREAM_BRANCH} is not complete. Run bun run sync-upstream first.`,
    )
  }
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
  const noRebuild = process.argv.includes("--no-rebuild")
  const resume = process.argv.includes("--continue")
  await assertSyncReady(ROOT, resume)

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
      console.log(`rebasing ${LOCAL_BRANCH} onto ${onto}…`)
      const rebase = await git(["rebase", onto])
      if (!rebase.ok) {
        throw new Error(
          `${rebase.error || rebase.text}\n\nConflict. Fix files, then:\n` +
            "  git add -A && git rebase --continue\n" +
            "  bun run sync-upstream --continue\n" +
            "To abort: git rebase --abort",
        )
      }
    }
  }

  await assertSyncReady(ROOT, true)
  const personal = await mustGit(["log", "--oneline", `upstream/${UPSTREAM_BRANCH}..HEAD`])
  if (personal) {
    console.log("kept on top of upstream:")
    console.log(personal)
  } else {
    console.log("warning: no personal commits on top of upstream (main == upstream/dev)")
  }

  const pkg = path.join(ROOT, "packages/opencode")
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const binary = process.platform === "win32" ? "opencode.exe" : "opencode"
  const built = path.join(
    pkg,
    "dist",
    `opencode-${process.platform === "win32" ? "windows" : process.platform}-${arch}`,
    "bin",
    binary,
  )
  if (!noRebuild) {
    console.log("installing dependencies from bun.lock…")
    const install = await $`bun install --frozen-lockfile`.cwd(ROOT).nothrow()
    if (install.exitCode !== 0) throw new Error(`Dependency install failed (${install.exitCode})`)

    console.log(`rebuilding ${process.platform}-${process.arch} binary…`)
    const build = await $`bun run script/build.ts --single --skip-install`.cwd(pkg).nothrow()
    if (build.exitCode !== 0) throw new Error(`Build failed (${build.exitCode})`)
    if (!existsSync(built)) throw new Error(`Built binary missing: ${built}`)
  }

  // A failed install/build must not publish an unverified rebase. Also catch
  // tracked files accidentally changed by package lifecycle/build scripts.
  await assertSyncReady(ROOT, true)
  console.log("pushing origin/main (force-with-lease)…")
  await mustGit(["push", "--force-with-lease", "origin", LOCAL_BRANCH])

  const tuiSrc = path.join(ROOT, "tui.json")
  const tuiDest = path.join(homedir(), ".config", "opencode", "tui.json")
  if (existsSync(tuiSrc)) {
    await mkdir(path.dirname(tuiDest), { recursive: true })
    await copyFile(tuiSrc, tuiDest)
    console.log(`installed ${tuiDest} (app_exit none)`)
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

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
