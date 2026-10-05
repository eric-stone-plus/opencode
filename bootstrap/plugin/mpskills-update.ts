import path from "node:path"
import { homedir } from "node:os"
import { open, rm, stat } from "node:fs/promises"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

// Refresh the mattpocock skills only when the skill tool is about to load one
// of them — never on a bare opencode launch, and never for skills this fork
// doesn't vendor (the user's own skills-extra, or the built-in
// customize-opencode). Throttled to once per day on success, ~10min on
// failure: calling a mattpocock skill repeatedly in one session should not
// re-hit the network every time, but a transient outage should not lock out
// retries for a full day either.
//
// Blocking by design: the point is that the skill content the model reads in
// *this* call is current. Every external command runs under `timeout`, so a
// stalled network bounds this one call to well under a minute worst case
// (first-time clone; an existing checkout is faster) — plugin.trigger awaits
// hooks sequentially, so that cost really is paid inline. Any failure is
// swallowed and the stale on-disk copy is served instead of blocking the
// skill load. A lockfile keeps two concurrent skill calls (this box runs more
// than one opencode server at a time) from racing the same checkout and REPO
// git state; the loser just skips and serves whatever is on disk.
// The fork checkout this plugin vendors INTO. Resolved at run time: the
// environment override wins, then a HOME-relative default — never a hardcoded
// absolute home, so the same file works on any seat. Machine-specific paths
// (and the mainland-CN git proxy the fetch below needs) belong in that
// machine's environment, not in shipped code.
const REPO =
  process.env.OPENCODE_FORK_REPO ?? path.join(homedir(), "Documents", "Development", "private", "agent-design", "projects", "opencode")
const UPSTREAM_URL = "https://github.com/mattpocock/skills.git"
const THROTTLE_OK_MS = 24 * 60 * 60 * 1000
const THROTTLE_FAIL_MS = 10 * 60 * 1000
const STALE_LOCK_MS = 2 * 60 * 1000

export default (async (input: PluginInput) => {
  return {
    "tool.execute.before": async (hookInput, output) => {
      if (hookInput.tool !== "skill") return
      const name = String((output.args as { name?: unknown })?.name ?? "")
      if (!name) return
      if (!(await Bun.file(path.join(REPO, "skills", name, "SKILL.md")).exists())) return

      const home = process.env.HOME ?? homedir()
      if (await throttled(home)) return
      await withLock(home, () => refreshIfStillDue(input.$.nothrow(), home))
    },
  }
}) satisfies Plugin

async function refreshIfStillDue(sh: PluginInput["$"], home: string) {
  // Re-check inside the lock: a concurrent call may have just finished.
  if (await throttled(home)) return
  const ok = await refresh(sh, home).then(
    () => true,
    (err) => {
      console.error(`mpskills-update: ${err instanceof Error ? err.message : String(err)}`)
      return false
    },
  )
  await markChecked(home, ok)
}

function cacheDir(home: string) {
  return path.join(home, ".cache", "opencode")
}

function markerPath(home: string) {
  return path.join(cacheDir(home), "mattpocock-upstream.last-check")
}

async function throttled(home: string) {
  const marker = Bun.file(markerPath(home))
  if (!(await marker.exists())) return false
  const window = (await marker.text()) === "ok" ? THROTTLE_OK_MS : THROTTLE_FAIL_MS
  return Date.now() - marker.lastModified < window
}

function markChecked(home: string, ok: boolean) {
  return Bun.write(markerPath(home), ok ? "ok" : "fail")
}

// Cross-process advisory lock: exclusive file creation is atomic on POSIX, so
// two opencode servers racing this at once can't both win. The loser skips
// this refresh attempt entirely rather than waiting — serving stale content
// once is cheaper than blocking a tool call on someone else's git operation.
async function withLock(home: string, fn: () => Promise<void>) {
  const lockPath = path.join(cacheDir(home), "mattpocock-upstream.lock")
  await Bun.$`mkdir -p ${cacheDir(home)}`.quiet()
  if (!(await acquireLock(lockPath))) return
  await fn().finally(() => rm(lockPath, { force: true }))
}

async function acquireLock(lockPath: string): Promise<boolean> {
  const handle = await open(lockPath, "wx").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EEXIST") return undefined
    throw err
  })
  if (handle) return handle.close().then(() => true)
  const age = Date.now() - (await stat(lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs
  if (age < STALE_LOCK_MS) return false
  await rm(lockPath, { force: true })
  return acquireLock(lockPath)
}

async function currentRevision() {
  const provenance = Bun.file(path.join(REPO, "skills", "PROVENANCE.md"))
  if (!(await provenance.exists())) return undefined
  return (await provenance.text()).match(/^- Revision: `([0-9a-f]+)`/m)?.[1]
}

async function run(promise: ReturnType<PluginInput["$"]>, label: string) {
  const result = await promise.quiet()
  if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr.toString().trim()}`)
  return result
}

// The cache checkout is a fresh clone with no git config of its own, so the
// fetch/clone below inherit no proxy — on a censored network that silently
// fails and the stale copy is served forever. Reuse the fork checkout's
// configured proxy (or an explicit MPSKILLS_GIT_PROXY override) so the refresh
// travels the same route the user already configured for GitHub.
async function gitProxy(sh: PluginInput["$"]) {
  if (process.env.MPSKILLS_GIT_PROXY) return process.env.MPSKILLS_GIT_PROXY
  const configured = await run(sh`git -C ${REPO} config --get http.proxy`, "proxy").catch(() => undefined)
  return configured?.text().trim() || undefined
}

async function syncCheckout(sh: PluginInput["$"], checkout: string) {
  const proxy = await gitProxy(sh)
  const via = proxy ? [`-c`, `http.proxy=${proxy}`, `-c`, `https.proxy=${proxy}`] : []
  if (await Bun.file(path.join(checkout, ".git", "HEAD")).exists()) {
    await run(sh`timeout 8 git ${via} -C ${checkout} fetch --quiet origin main --depth 1`, "fetch")
    await run(sh`timeout 3 git -C ${checkout} reset --quiet --hard origin/main`, "reset")
    return
  }
  await run(sh`rm -rf ${checkout}`, "clean stale checkout")
  await run(sh`mkdir -p ${path.dirname(checkout)}`, "create cache dir")
  await run(sh`timeout 15 git ${via} clone --quiet --depth 1 ${UPSTREAM_URL} ${checkout}`, "clone")
}

// Vendor + install + commit happen together: a revision bump with no change
// readers care about (e.g. a doc-only commit outside the vendored buckets)
// must not leave a stray commit, so the actual working-tree diff gates it.
async function refresh(sh: PluginInput["$"], home: string) {
  const checkout = path.join(cacheDir(home), "mattpocock-upstream")
  await syncCheckout(sh, checkout)

  const before = await currentRevision()
  const after = (await run(sh`timeout 3 git -C ${checkout} rev-parse HEAD`, "rev-parse")).text().trim()
  if (!after || after === before) return

  await run(sh`timeout 15 bun run vendor-skills --source ${checkout}`.cwd(REPO), "vendor-skills")

  const { installSkills } = (await import(path.join(REPO, "script", "sync-upstream.ts"))) as {
    installSkills: (source: string, destination: string) => Promise<number>
  }
  await installSkills(path.join(REPO, "skills"), path.join(home, ".config", "opencode", "skills"))

  const diff = (await run(sh`timeout 3 git -C ${REPO} status --porcelain -- skills`, "status")).text().trim()
  if (!diff) return

  // --only: commit exactly the skills/ changes, ignoring whatever else might
  // be staged in REPO at the moment this fires (REPO is the user's live
  // checkout, not a scratch clone). No `git add` first — `--only` stages the
  // named paths itself.
  const message = `chore: vendor mattpocock skills refresh (${after.slice(0, 8)})\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
  // --only: commit exactly the skills/ changes, ignoring whatever else might
  // be staged in REPO at the moment this fires (REPO is the user's live
  // checkout, not a scratch clone).
  await run(sh`timeout 3 git -C ${REPO} commit --quiet --only -m ${message} -- skills`, "commit")
}
