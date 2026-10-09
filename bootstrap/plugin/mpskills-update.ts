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
// *this* call is current. That holds because the fork's skill tool re-reads
// SKILL.md at execute time — after this `tool.execute.before` hook — instead
// of serving the InstanceState snapshot taken at system-prompt build. The
// network commands run under `timeout`, so a stalled network bounds this one
// call to well under a minute worst case (first-time clone; an existing
// checkout is faster) — plugin.trigger awaits hooks sequentially, so that
// cost really is paid inline. Any failure is swallowed and the stale on-disk
// copy is served instead of blocking the skill load. A lockfile keeps two
// concurrent skill calls (this box runs more than one opencode server at a
// time) from racing the same checkout and REPO git state; the loser just
// skips and serves whatever is on disk.
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
      const home = process.env.HOME ?? homedir()
      try {
        if (hookInput.tool !== "skill") return
        const name = String((output.args as { name?: unknown })?.name ?? "")
        if (!name) return
        if (!(await Bun.file(path.join(REPO, "skills", name, "SKILL.md")).exists())) return

        if (await throttled(home)) return
        const sh = input.$.nothrow()
        await withLock(sh, home, () => refreshIfStillDue(sh, home))
      } catch (err) {
        console.error(`mpskills-update: ${err instanceof Error ? err.message : String(err)}`)
        // Failures outside the refresh path (lock resolution, marker I/O) must
        // back off too, or a persistent one retries on every skill call.
        await markChecked(home, false).catch(() => {})
      }
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
// The lock lives in REPO's git dir, not $HOME: REPO's git state is the shared
// resource, and two seats sharing the checkout must serialize even with
// different HOME directories. The owner token inside the file means a holder
// whose lock was stale-broken by a peer never deletes the peer's lock when it
// finally finishes. Breaking a stale lock is still check-then-act (the double
// read narrows the window; it is not atomic), but a live holder is bounded by
// per-command timeouts well under STALE_LOCK_MS, so only a pathologically
// stalled machine can lose its lock mid-refresh. A second, per-HOME lock
// guards the upstream checkout and the install target, which are keyed by HOME
// rather than REPO. If the git dir cannot be resolved there is no lock that
// actually guards REPO, so the refresh is skipped (and backed off) rather than
// run under a per-HOME lock that would not serialize the seats.
async function withLock(sh: PluginInput["$"], home: string, fn: () => Promise<void>) {
  const repoLock = await lockPathFor(sh)
  if (!repoLock) {
    console.error("mpskills-update: cannot resolve REPO git dir; skipping refresh")
    await markChecked(home, false)
    return
  }
  const homeLock = path.join(cacheDir(home), "mpskills-update.lock")
  await Bun.$`mkdir -p ${path.dirname(repoLock)}`.quiet()
  await Bun.$`mkdir -p ${path.dirname(homeLock)}`.quiet()
  const repoToken = await acquireLock(repoLock)
  if (!repoToken) return
  try {
    const homeToken = await acquireLock(homeLock)
    if (!homeToken) return
    try {
      await fn()
    } finally {
      await releaseLock(homeLock, homeToken)
    }
  } finally {
    await releaseLock(repoLock, repoToken)
  }
}

async function lockPathFor(sh: PluginInput["$"]) {
  const dir = await run(sh`timeout 3 git -C ${REPO} rev-parse --absolute-git-dir`, "git-dir")
    .then((result) => result.text().trim())
    .catch(() => undefined)
  return dir ? path.join(dir, "mpskills-update.lock") : undefined
}

async function acquireLock(lockPath: string): Promise<string | undefined> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(lockPath, "wx").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return undefined
      throw err
    })
    if (handle) {
      try {
        await handle.writeFile(token)
        await handle.close()
        return token
      } catch (error) {
        // A failed token write would leave an empty, mtime-fresh lock that
        // blocks peers for the full stale window; remove it before rethrowing.
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
        throw error
      }
    }
    if (!(await staleLock(lockPath))) return undefined
    // Check-then-act is racy: another process may break the same stale lock
    // between the observation and the rm. Only break it when a second read
    // still shows the same stale token/mtime.
    const before = await Bun.file(lockPath).text().catch(() => undefined)
    if (!(await staleLock(lockPath))) continue
    if ((await Bun.file(lockPath).text().catch(() => undefined)) !== before) continue
    await rm(lockPath, { force: true })
  }
  return undefined
}

function staleLock(lockPath: string) {
  return stat(lockPath)
    .then((info) => Date.now() - info.mtimeMs > STALE_LOCK_MS)
    .catch(() => false)
}

async function releaseLock(lockPath: string, token: string) {
  const current = await Bun.file(lockPath).text().catch(() => undefined)
  if (current !== token) return
  await rm(lockPath, { force: true })
}

// The throttle must track what REPO has *committed*, not the working tree:
// after a failed run that rewrote skills/ but failed to commit, the working
// tree already shows the new revision, and gating on it would turn every
// retry into a no-op until the next upstream release.
async function committedRevision(sh: PluginInput["$"]) {
  const result = await run(sh`timeout 3 git -C ${REPO} show HEAD:skills/PROVENANCE.md`, "show").catch(
    () => undefined,
  )
  return result?.text().match(/^- Revision: `([0-9a-f]+)`/m)?.[1]
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

  const before = await committedRevision(sh)
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
  await run(sh`timeout 3 git -C ${REPO} commit --quiet --only -m ${message} -- skills`, "commit")
}
