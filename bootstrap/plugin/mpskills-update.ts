import path from "node:path"
import { homedir } from "node:os"
import { open, rm, stat, type FileHandle } from "node:fs/promises"
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
// finally finishes. A stale lock is only broken when its recorded pid is dead,
// and the break runs under a single-breaker marker (exclusive create) whose
// own owner must be dead before a peer may evict it, so a live holder is never
// evicted no matter how long its git operation runs and at most one breaker
// ever removes a given stale lock. Pid liveness is local to the PID namespace
// (single-host deployment of this fork); seats sharing a checkout across
// machines or containers are not supported by this lock. A dead owner's pid
// reused by an unrelated live process keeps the stale lock unbreakable until
// that process exits — the refresh then skips rather than risk a double run;
// a live-but-permanently-stuck breaker (SIGSTOP) blocks breaking the same way.
// A stall inside a breaker's final marker-readback→rm gap can still pair two
// breakers; only a kernel lock would close that residue.
// A second, per-HOME lock guards the upstream checkout and the install target,
// which are keyed by HOME rather than REPO. If the git dir cannot be resolved
// there is no lock that actually guards REPO, so the refresh is skipped (and
// backed off) rather than run under a per-HOME lock that would not serialize
// the seats.
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
        // The lock is ours while our inode is the one at the path: a peer that
        // broke an empty lock past the stale window and re-acquired shows its
        // own inode there, and our token lives only in the unlinked file. A
        // transient read error must not make an owned lock look stolen and
        // wedge every later refresh on this live pid.
        return (await ownsPath(handle, lockPath)) ? token : undefined
      } catch (error) {
        // A failed token write can leave an empty lock that a peer already
        // broke and re-acquired past the stale window; remove the path only
        // while it is still the inode this handle created, so a peer's fresh
        // lock is not deleted except for a stall inside this compare→rm gap —
        // the same irreducible residue as the breaker's readback→rm gap.
        if (await ownsPath(handle, lockPath)) await rm(lockPath, { force: true }).catch(() => undefined)
        throw error
      }
    }
    if (!(await breakableLock(lockPath))) return undefined
    const breakerPath = `${lockPath}.breaker`
    const breakerToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const breaker = await open(breakerPath, "wx").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return undefined
      throw err
    })
    if (!breaker) {
      // A crashed breaker must not wedge breaking forever: clean a marker only
      // when its owner is gone, then retry. A marker whose pid is still alive
      // belongs to a suspended or slow breaker and is left alone — evicting it
      // would let a second breaker race the first one's pending rm.
      const marker = await stat(breakerPath).catch(() => undefined)
      if (marker && Date.now() - marker.mtimeMs > STALE_LOCK_MS) {
        const owner = await Bun.file(breakerPath).text().catch(() => undefined)
        // Evict only a marker whose owner was actually read and is gone: an
        // unreadable marker is a live breaker's whose read failed, and the
        // marker must still be the inode seen above before it is removed.
        const pid = owner === undefined ? undefined : Number(owner.split("-")[0])
        if (pid !== undefined && !pidAlive(pid)) {
          const atPath = await stat(breakerPath).catch(() => undefined)
          if (atPath && atPath.dev === marker.dev && atPath.ino === marker.ino) {
            await rm(breakerPath, { force: true }).catch(() => undefined)
            continue
          }
        }
      }
      return undefined
    }
    try {
      await breaker.writeFile(breakerToken)
    } catch {
      // The marker may be empty or partially written, so a peer can evict it.
      // Remove it only while it is still the inode this breaker created; a
      // successor's marker is never deleted, and the successor bails via its
      // own marker readback before touching the lock.
      if (await ownsPath(breaker, breakerPath)) await rm(breakerPath, { force: true }).catch(() => undefined)
      return undefined
    }
    await breaker.close().catch(() => {})
    try {
      // Only one breaker runs at a time, and the path stays occupied until the
      // rm below — so a lock that is still breakable here can only be the one
      // observed, never a fresh acquirer's.
      if (!(await breakableLock(lockPath))) continue
      // A peer may have evicted this breaker's marker while it looked stale;
      // only the marker's owner may break the lock, so bail when ours was
      // stolen. A stall inside this final readback→rm gap is irreducible
      // without a kernel lock.
      if ((await Bun.file(breakerPath).text().catch(() => undefined)) !== breakerToken) continue
      await rm(lockPath, { force: true })
    } finally {
      // The marker is removed only while this breaker still owns it: a breaker
      // suspended past the stale window must not delete a successor's marker.
      const marker = await Bun.file(breakerPath).text().catch(() => undefined)
      if (marker === breakerToken) await rm(breakerPath, { force: true }).catch(() => {})
    }
  }
  return undefined
}

// The inode this handle created still sits at target while dev+ino match, so
// the path is ours whatever a transient read error says. A peer that broke and
// recreated the file shows a different inode. Always closes the handle.
async function ownsPath(handle: FileHandle, target: string) {
  const mine = await handle.stat().catch(() => undefined)
  await handle.close().catch(() => undefined)
  const atPath = await stat(target).catch(() => undefined)
  return mine !== undefined && atPath !== undefined && mine.dev === atPath.dev && mine.ino === atPath.ino
}

// A lock is breakable only when it is older than the stale window AND its
// recorded pid is gone: a live holder is never evicted, no matter how long its
// git operation runs. Unparseable content after the stale window counts as
// dead — that is the empty lock a crashed writer can leave behind.
async function breakableLock(lockPath: string) {
  const info = await stat(lockPath).catch(() => undefined)
  if (!info || Date.now() - info.mtimeMs <= STALE_LOCK_MS) return false
  const token = await Bun.file(lockPath).text().catch(() => undefined)
  if (token === undefined) return false
  const pid = Number(token.split("-")[0])
  return !pidAlive(pid)
}

function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
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
