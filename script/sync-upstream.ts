#!/usr/bin/env bun
/**
 * Keep personal `main` on top of official OpenCode.
 *
 * Official default branch is `dev` (anomalyco/opencode).
 * This fork publishes a single `main`.
 *
 *   bun run sync-upstream              fetch, rebase, push, rebuild
 *   bun run sync-upstream --no-rebuild skip the binary rebuild
 *   bun run sync-upstream --continue   after fixing rebase conflicts
 */
import { $ } from "bun"
import { homedir } from "os"
import path from "path"
import { existsSync } from "fs"

const ROOT = path.resolve(import.meta.dirname, "..")
const UPSTREAM_URL = "https://github.com/anomalyco/opencode.git"
const UPSTREAM_BRANCH = "dev"
const LOCAL_BRANCH = "main"
const noRebuild = process.argv.includes("--no-rebuild")
const resume = process.argv.includes("--continue")

process.chdir(ROOT)

async function git(args: string[]) {
  const result = await $`git ${args}`.nothrow().quiet()
  return {
    ok: result.exitCode === 0,
    text: result.text().trim(),
    code: result.exitCode,
  }
}

async function mustGit(args: string[]) {
  const result = await git(args)
  if (!result.ok) {
    console.error(result.text || `git ${args.join(" ")} failed (${result.code})`)
    process.exit(result.code || 1)
  }
  return result.text
}

function rebasing() {
  return existsSync(path.join(ROOT, ".git/rebase-merge")) || existsSync(path.join(ROOT, ".git/rebase-apply"))
}

if (resume) {
  if (rebasing()) {
    console.error("Finish the rebase first: resolve files, then `git add` and `git rebase --continue`.")
    console.error("When git rebase is done, run: bun run sync-upstream --continue")
    process.exit(1)
  }
} else {
  const dirty = await git(["status", "--porcelain"])
  if (dirty.text) {
    console.error("Working tree is dirty. Commit or stash first.")
    console.error(dirty.text)
    process.exit(1)
  }

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
  console.log(`personal commits on ${LOCAL_BRANCH}: ${ahead}; upstream ${UPSTREAM_BRANCH} is ${behind} commit(s) ahead`)

  if (behind === "0") {
    console.log("already up to date with upstream")
  } else {
    console.log(`rebasing ${LOCAL_BRANCH} onto ${onto}…`)
    const rebase = await git(["rebase", onto])
    if (!rebase.ok) {
      console.error(rebase.text)
      console.error("")
      console.error("Conflict. Fix files, then:")
      console.error("  git add -A && git rebase --continue")
      console.error("  bun run sync-upstream --continue")
      console.error("To abort: git rebase --abort")
      process.exit(1)
    }
  }
}

const personal = await mustGit(["log", "--oneline", `upstream/${UPSTREAM_BRANCH}..HEAD`])
if (personal) {
  console.log("kept on top of upstream:")
  console.log(personal)
} else {
  console.log("warning: no personal commits on top of upstream (main == upstream/dev)")
}

console.log("pushing origin/main (force-with-lease)…")
const push = await git(["push", "--force-with-lease", "origin", LOCAL_BRANCH])
if (!push.ok) {
  console.error(push.text)
  process.exit(push.code || 1)
}

if (noRebuild) {
  console.log("done (rebuild skipped)")
  process.exit(0)
}

console.log("rebuilding darwin binary…")
const pkg = path.join(ROOT, "packages/opencode")
const build = await $`bun run script/build.ts --single --skip-install`.cwd(pkg).nothrow()
if (build.exitCode !== 0) {
  console.error(build.text())
  process.exit(build.exitCode || 1)
}

const arch = process.arch === "arm64" ? "arm64" : "x64"
const built = path.join(pkg, "dist", `opencode-${process.platform === "win32" ? "windows" : process.platform}-${arch}`, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
const dest = path.join(homedir(), ".opencode", "bin", "opencode")
if (!existsSync(built)) {
  console.error(`built binary missing: ${built}`)
  process.exit(1)
}
await $`mkdir -p ${path.dirname(dest)}`
await $`cp ${built} ${dest}`
await $`chmod +x ${dest}`
const version = await $`${dest} --version`.text()
console.log(`installed ${dest}`)
console.log(version.trim())
