import { spawn } from "node:child_process"
import { mkdir, open, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"

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
// SKILL.md at execute time — after this `execute.before` hook — instead of
// serving the InstanceState snapshot taken at system-prompt build. The V2 host
// awaits a tool hook before it runs the tool (the promise adapter wraps this
// callback in one Effect.promise), so that cost really is paid inline.
//
// Ported from the V1 plugin (bootstrap/plugin-v1/mpskills-update.ts), which
// had BunShell (`input.$`) and a bare function export. The differences from
// V1 are these and nothing else: the hook now registers on
// `ctx.tool.hook("execute.before", …)`
// and reads the skill name from `event.input` (V1 read it from the hook's
// `output.args`), which in V2 is `{ id }` where V1 was `{ name }` — both are
// accepted below; every shell command became a node:child_process spawn
// (`input.$` does not exist in V2 — this file may not depend on Bun); and the
// REPO is resolved per call instead of at import. The bound V1 got from
// wrapping each command in coreutils `timeout N` now comes from spawn's
// `timeout` option, which SIGTERMs the child and fails the command the same
// way, so a stalled network still cannot hang the skill call. REPO is resolved
// per call so a seat can re-point OPENCODE_FORK_REPO (and the standalone
// battery can isolate a case) without reloading the plugin; the expression is
// V1's exactly. V1 left the local `git config --get http.proxy` read
// unbounded; it is bounded here like every other command, because one
// unbounded spawn is enough to hang a tool call. That bound needs more than
// spawn's own `timeout` option (see `run`): it signals the direct child only,
// and settling on `close` would then wait for stdio EOF that a surviving
// grandchild keeps open — the very hang the wrapper exists to prevent.
//
// Any failure is swallowed and the stale on-disk copy is served instead of
// blocking the skill load; only console.error reports it. A lockfile keeps two
// concurrent skill calls (this box runs more than one opencode server at a
// time) from racing the same checkout and REPO git state; the loser just skips
// and serves whatever is on disk.
//
// Runtime imports: node builtins + the type-only plugin import, so the file
// also loads standalone in script/mpskills-update.test.ts.

// The fork checkout this plugin vendors INTO. The environment override wins,
// then a HOME-relative default — never a hardcoded absolute home, so the same
// file works on any seat. Machine-specific paths (and the mainland-CN git
// proxy the fetch below needs) belong in that machine's environment, not in
// shipped code.
function repo() {
  return (
    process.env.OPENCODE_FORK_REPO ??
    path.join(homedir(), "Documents", "Development", "private", "agent-design", "projects", "opencode")
  )
}

// Testability seam: the standalone battery overrides this with a local path, so
// even a case that somehow reached the clone could not reach the real upstream
// (those cases have no network at all, and every `git` they spawn is a shim).
const UPSTREAM_URL = process.env.OPENCODE_MPSKILLS_UPSTREAM ?? "https://github.com/mattpocock/skills.git"
const THROTTLE_OK_MS = 24 * 60 * 60 * 1000
const THROTTLE_FAIL_MS = 10 * 60 * 1000
const STALE_LOCK_MS = 2 * 60 * 1000

export default {
  id: "mpskills-update",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      const home = process.env.HOME ?? homedir()
      try {
        if (event.tool !== "skill") return
        // V2 hands the tool arguments whole and untyped. V1's skill tool took
        // `{ name }`; the V2 one takes `{ id }` (packages/core/src/tool/plugin/
        // skill.ts), and that id IS the skill's directory name — exactly the key
        // the existence check below resolves — because skill-file.ts derives it
        // from path.basename(path.dirname(filepath)). Reading only V1's `name`
        // would make this hook a silent no-op on every V2 seat, so accept both,
        // preferring `name` when a future host supplies it.
        const input = event.input
        const fields = typeof input === "object" && input !== null ? (input as { name?: unknown; id?: unknown }) : {}
        const raw = fields.name ?? fields.id
        const name = raw === undefined || raw === null ? "" : String(raw)
        if (!name) return
        if (!(await exists(path.join(repo(), "skills", name, "SKILL.md")))) return

        if (await throttled(home)) return
        await withLock(home, () => refreshIfStillDue(home))
      } catch (err) {
        console.error(`mpskills-update: ${err instanceof Error ? err.message : String(err)}`)
        // Failures outside the refresh path (lock resolution, marker I/O) must
        // back off too, or a persistent one retries on every skill call.
        await markChecked(home, false).catch(() => {})
      }
    })
  },
} satisfies Plugin.Plugin

async function refreshIfStillDue(home: string) {
  // Re-check inside the lock: a concurrent call may have just finished.
  if (await throttled(home)) return
  const ok = await refresh(home).then(
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

function exists(target: string) {
  return stat(target).then(
    () => true,
    () => false,
  )
}

async function throttled(home: string) {
  const marker = markerPath(home)
  const info = await stat(marker).catch(() => undefined)
  if (!info) return false
  const window = (await readFile(marker, "utf8")) === "ok" ? THROTTLE_OK_MS : THROTTLE_FAIL_MS
  return Date.now() - info.mtimeMs < window
}

async function markChecked(home: string, ok: boolean) {
  const marker = markerPath(home)
  // V1's Bun.write created the parent directories; node's writeFile does not,
  // and the failure path can run before the cache dir exists at all.
  await mkdir(path.dirname(marker), { recursive: true })
  await writeFile(marker, ok ? "ok" : "fail")
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
async function withLock(home: string, fn: () => Promise<void>) {
  const repoLock = await lockPathFor(repo())
  if (!repoLock) {
    console.error("mpskills-update: cannot resolve REPO git dir; skipping refresh")
    await markChecked(home, false)
    return
  }
  const homeLock = path.join(cacheDir(home), "mpskills-update.lock")
  await mkdir(path.dirname(repoLock), { recursive: true })
  await mkdir(path.dirname(homeLock), { recursive: true })
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

async function lockPathFor(target: string) {
  const dir = await run("git", ["-C", target, "rev-parse", "--absolute-git-dir"], 3000, "git-dir")
    .then((result) => result.stdout.trim())
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
        const owner = await readFile(breakerPath, "utf8").catch(() => undefined)
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
      if ((await readFile(breakerPath, "utf8").catch(() => undefined)) !== breakerToken) continue
      await rm(lockPath, { force: true })
    } finally {
      // The marker is removed only while this breaker still owns it: a breaker
      // suspended past the stale window must not delete a successor's marker.
      const marker = await readFile(breakerPath, "utf8").catch(() => undefined)
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
  const token = await readFile(lockPath, "utf8").catch(() => undefined)
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
  const current = await readFile(lockPath, "utf8").catch(() => undefined)
  if (current !== token) return
  await rm(lockPath, { force: true })
}

// The throttle must track what REPO has *committed*, not the working tree:
// after a failed run that rewrote skills/ but failed to commit, the working
// tree already shows the new revision, and gating on it would turn every
// retry into a no-op until the next upstream release.
async function committedRevision(target: string) {
  const result = await run("git", ["-C", target, "show", "HEAD:skills/PROVENANCE.md"], 3000, "show").catch(
    () => undefined,
  )
  return result?.stdout.match(/^- Revision: `([0-9a-f]+)`/m)?.[1]
}

type RunResult = { readonly stdout: string; readonly stderr: string }

// V1 ran every command through BunShell and, where the command could touch the
// network, through coreutils `timeout N …`: the wrapper killed the command and
// the nonzero exit became a thrown error. V2 has no shell, so the bound is
// rebuilt here. Two details make it the same bound rather than a weaker one.
// First, the child leads its own process group (`detached`, as
// packages/plugin's local-tools does) and the timeout SIGKILLs the GROUP:
// `git fetch`/`clone` run `git-remote-https` as a grandchild that inherits
// these pipes, and killing the direct child alone leaves it running. Second,
// the timeout settles the promise by itself instead of waiting for `close`,
// which only arrives once every holder of those pipes is gone — so a survivor
// cannot defer the rejection past the bound it already blew. The git command
// lines themselves are unchanged, argument for argument.
function run(command: string, args: readonly string[], timeout: number, label: string, cwd?: string) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let expired = false
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    // Only for a group this spawn created (see `detached` above); ESRCH means
    // it is already gone, which is the desired end state either way.
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(value)
        else process.kill(-child.pid, value)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    const timer = setTimeout(() => {
      expired = true
      signal("SIGKILL")
      settle(() => reject(new Error(`${label} failed: timed out after ${timeout}ms`)))
    }, timeout)
    const settle = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done()
    }
    child.once("error", (error) => settle(() => reject(error)))
    child.once("close", (code) => {
      if (expired) return
      settle(() => (code !== 0 ? reject(new Error(`${label} failed: ${stderr.trim() || `exit ${code}`}`)) : resolve({ stdout, stderr })))
    })
  })
}

// The cache checkout is a fresh clone with no git config of its own, so the
// fetch/clone below inherit no proxy — on a censored network that silently
// fails and the stale copy is served forever. Reuse the fork checkout's
// configured proxy (or an explicit MPSKILLS_GIT_PROXY override) so the refresh
// travels the same route the user already configured for GitHub.
async function gitProxy(target: string) {
  if (process.env.MPSKILLS_GIT_PROXY) return process.env.MPSKILLS_GIT_PROXY
  const configured = await run("git", ["-C", target, "config", "--get", "http.proxy"], 3000, "proxy").catch(
    () => undefined,
  )
  return configured?.stdout.trim() || undefined
}

async function syncCheckout(target: string, checkout: string) {
  const proxy = await gitProxy(target)
  const via = proxy ? ["-c", `http.proxy=${proxy}`, "-c", `https.proxy=${proxy}`] : []
  if (await exists(path.join(checkout, ".git", "HEAD"))) {
    await run("git", [...via, "-C", checkout, "fetch", "--quiet", "origin", "main", "--depth", "1"], 8000, "fetch")
    await run("git", ["-C", checkout, "reset", "--quiet", "--hard", "origin/main"], 3000, "reset")
    return
  }
  await rm(checkout, { recursive: true, force: true })
  await mkdir(path.dirname(checkout), { recursive: true })
  await run("git", [...via, "clone", "--quiet", "--depth", "1", UPSTREAM_URL, checkout], 15000, "clone")
}

// Vendor + install + commit happen together: a revision bump with no change
// readers care about (e.g. a doc-only commit outside the vendored buckets)
// must not leave a stray commit, so the actual working-tree diff gates it.
async function refresh(home: string) {
  const target = repo()
  const checkout = path.join(cacheDir(home), "mattpocock-upstream")
  await syncCheckout(target, checkout)

  const before = await committedRevision(target)
  const after = (await run("git", ["-C", checkout, "rev-parse", "HEAD"], 3000, "rev-parse")).stdout.trim()
  if (!after || after === before) return

  await run("bun", ["run", "vendor-skills", "--source", checkout], 15000, "vendor-skills", target)

  const { installSkills } = (await import(path.join(target, "script", "sync-upstream.ts"))) as {
    installSkills: (source: string, destination: string) => Promise<number>
  }
  await installSkills(path.join(target, "skills"), path.join(home, ".config", "opencode", "skills"))

  const diff = (await run("git", ["-C", target, "status", "--porcelain", "--", "skills"], 3000, "status")).stdout.trim()
  if (!diff) return

  // --only: commit exactly the skills/ changes, ignoring whatever else might
  // be staged in REPO at the moment this fires (REPO is the user's live
  // checkout, not a scratch clone). No `git add` first — `--only` stages the
  // named paths itself.
  const message = `chore: vendor mattpocock skills refresh (${after.slice(0, 8)})\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
  await run("git", ["-C", target, "commit", "--quiet", "--only", "-m", message, "--", "skills"], 3000, "commit")
}
