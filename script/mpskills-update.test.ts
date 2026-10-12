import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { registerPlugin } from "../bootstrap/agent-hooks/run-cases"

// mpskills-update against the V2 hook shape, on the host-double pattern of
// script/secret-path-guard.test.ts: registerPlugin stands in for the host,
// captures the `execute.before` callback and hands it the event object the
// runtime would (`tool` + `input`), so no network, no server and no skill
// directory are needed to exercise the throttle.
//
// The refresh path CLONES UPSTREAM, so it must never run here. Five walls keep
// it out: OPENCODE_FORK_REPO points at a throwaway checkout that only has the
// skill under test, HOME at a throwaway cache, PATH at a `git` shim that
// records every invocation (its absence is the proof that no git ran), and the
// upstream seam at a path that is not a network URL, so even a bug that
// reached the clone would not reach github. The last one is a path shim rather
// than a wall: cases (d), (e) and (f) drive the refresh far enough to spawn
// git, so the gate they check is the shim's canary plus the failure marker.
process.env.OPENCODE_MPSKILLS_UPSTREAM = path.join(tmpdir(), "mpskills-update.test-never-cloned")

const hooks = await registerPlugin(path.join(import.meta.dir, "..", "bootstrap", "plugin", "mpskills-update.ts"))
const before = hooks.get("execute.before")
if (!before) throw new Error("mpskills-update registered no execute.before hook")

// The marker path the plugin reads, from its own source: $HOME/.cache/opencode/mattpocock-upstream.last-check.
const MARKER = [".cache", "opencode", "mattpocock-upstream.last-check"]
const SKILL = "proto-demo"
const THROTTLE_FAIL_MS = 10 * 60 * 1000

const saved = { HOME: process.env.HOME, PATH: process.env.PATH, OPENCODE_FORK_REPO: process.env.OPENCODE_FORK_REPO }
const roots: string[] = []

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type Seat = { repo: string; home: string; bin: string; canary: string; marker: string }

// One isolated seat per case: a fake REPO holding `skill` (when given), a fake
// HOME, and a `git` shim dropping a canary line per invocation. No case ever
// sees a real checkout.
async function seat(options: { skill?: string; marker?: string; gitExit?: number; gitSleep?: number } = {}): Promise<Seat> {
  const base = path.join(tmpdir(), "mpskills-update")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(path.join(base, "case-"))
  roots.push(root)
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const canary = path.join(root, "git-invoked")
  await mkdir(path.join(repo, "skills"), { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  if (options.skill !== undefined) {
    const skill = path.join(repo, "skills", options.skill)
    await mkdir(skill, { recursive: true })
    await writeFile(path.join(skill, "SKILL.md"), `---\nname: ${options.skill}\n---\n# demo\n`)
  }
  // The shim records every invocation, then either fails (the plugin's
  // swallowed-error paths) or stalls past any plausible hook bound.
  const body = options.gitSleep === undefined ? `exit ${options.gitExit ?? 1}` : `sleep ${options.gitSleep}`
  await writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(canary)}\n${body}\n`,
    { mode: 0o755 },
  )
  process.env.HOME = home
  process.env.OPENCODE_FORK_REPO = repo
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`
  const marker = path.join(home, ...MARKER)
  if (options.marker !== undefined) {
    await mkdir(path.dirname(marker), { recursive: true })
    await writeFile(marker, options.marker)
  }
  return { repo, home, bin, canary, marker }
}

const call = (event: unknown) => before?.(event)
const toolCall = (tool: string, input: unknown) =>
  call({ tool, sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test", input })
const skillCall = (name: unknown) => toolCall("skill", { name })

async function read(target: string) {
  return readFile(target, "utf8").catch(() => undefined)
}

async function gitInvocations(canary: string) {
  const log = await read(canary)
  return log === undefined ? [] : log.split("\n").filter((line) => line.length > 0)
}

describe("mpskills-update", () => {
  test("(a) a non-skill tool call is ignored and touches no file", async () => {
    const place = await seat({ skill: SKILL, gitExit: 0 })
    await toolCall("bash", { command: "ls" })
    await toolCall("read", { path: "SKILL.md" })
    expect(await gitInvocations(place.canary)).toEqual([])
    expect(await read(place.marker)).toBeUndefined()
  })

  test("(a) a skill call without a usable name is ignored", async () => {
    const place = await seat({ skill: SKILL, gitExit: 0 })
    for (const input of [undefined, null, {}, { name: "" }, { name: null }, { name: 7 }, "SKILL.md"]) {
      await call({ tool: "skill", sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test", input })
    }
    expect(await gitInvocations(place.canary)).toEqual([])
    expect(await read(place.marker)).toBeUndefined()
  })

  test("(b) a skill this fork does not vendor is ignored before any git call", async () => {
    // The REPO has a skills tree, but not the skill being called — exactly the
    // user's own skills-extra or the built-in customize-opencode.
    const place = await seat({ skill: "someone-elses-skill", gitExit: 0 })
    await skillCall(SKILL)
    await skillCall("skills-extra/whatever")
    await skillCall("../../etc/passwd")
    expect(await gitInvocations(place.canary)).toEqual([])
    expect(await read(place.marker)).toBeUndefined()
  })

  test("(c) a fresh success marker throttles the refresh without running git", async () => {
    const place = await seat({ skill: SKILL, marker: "ok", gitExit: 0 })
    await skillCall(SKILL)
    expect(await gitInvocations(place.canary)).toEqual([])
    expect(await read(place.marker)).toBe("ok")
  })

  test("(d) a failed refresh is swallowed and backs off for ten minutes", async () => {
    const place = await seat({ skill: SKILL, gitExit: 1 })
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "))
    }
    try {
      // Must resolve, never reject: a failed refresh serves the stale copy.
      await skillCall(SKILL)
      const first = await gitInvocations(place.canary)
      expect(first.length).toBeGreaterThan(0)
      expect(first.some((line) => line.includes("rev-parse --absolute-git-dir"))).toBe(true)
      expect(await read(place.marker)).toBe("fail")
      const info = await stat(place.marker)
      expect(Date.now() - info.mtimeMs).toBeLessThan(THROTTLE_FAIL_MS)

      // The second call inside the failure window must not even reach git.
      await skillCall(SKILL)
      expect(await gitInvocations(place.canary)).toEqual(first)
    } finally {
      console.error = original
    }
    expect(errors.some((line) => line.includes("cannot resolve REPO git dir"))).toBe(true)
  })

  test("(f) the V2 skill tool's input shape (`{ id }`) is recognized, not just V1's `{ name }`", async () => {
    // The V2 skill tool declares `{ id }` (packages/core/src/tool/plugin/
    // skill.ts), where the id is the skill's directory name. A hook that read
    // only V1's `name` would return before the checks below and leave no marker;
    // the failing git shim makes this case observable either way.
    const place = await seat({ skill: SKILL, gitExit: 1 })
    const original = console.error
    console.error = () => {}
    try {
      await call({
        tool: "skill",
        sessionID: "ses_test",
        agent: "build",
        messageID: "msg_test",
        id: "call_test",
        input: { id: SKILL },
      })
    } finally {
      console.error = original
    }
    expect((await gitInvocations(place.canary)).length).toBeGreaterThan(0)
    expect(await read(place.marker)).toBe("fail")
  })

  test("(g) a stalled git cannot hang the skill call", async () => {
    // The bound under test is the point of the port. `git fetch` runs
    // git-remote-https as a grandchild that inherits these pipes, so a wrapper
    // that killed only the direct child, or that settled on stdio EOF, would
    // still be inside the shim's 30s sleep here. The plugin's own 3s bound on
    // the git-dir probe must reject first and the hook must resolve.
    const place = await seat({ skill: SKILL, gitSleep: 30 })
    const original = console.error
    console.error = () => {}
    const started = Date.now()
    try {
      await skillCall(SKILL)
    } finally {
      console.error = original
    }
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThan(1000)
    expect(elapsed).toBeLessThan(20000)
    expect(await read(place.marker)).toBe("fail")
  }, 20000)

  test("(e) a refresh failure past the lock path still backs off and leaves no lock behind", async () => {
    // Here the shim answers the git-dir probe, so the plugin takes both locks
    // and gets all the way into the refresh — which then fails at the proxy
    // read (and would fail at the clone, never attempted).
    const place = await seat({ skill: SKILL })
    const gitDir = path.join(place.repo, "fake-git-dir")
    await writeFile(
      path.join(place.bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(place.canary)}\ncase "$*" in\n  *rev-parse --absolute-git-dir*) printf '%s\\n' ${JSON.stringify(gitDir)}; exit 0 ;;\nesac\nexit 1\n`,
      { mode: 0o755 },
    )
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "))
    }
    try {
      await skillCall(SKILL)
    } finally {
      console.error = original
    }
    expect(await read(place.marker)).toBe("fail")
    // Released: neither the REPO lock nor the per-HOME lock outlives the call.
    expect(await read(path.join(gitDir, "mpskills-update.lock"))).toBeUndefined()
    expect(await read(path.join(place.home, ".cache", "opencode", "mpskills-update.lock"))).toBeUndefined()
    expect(errors.some((line) => line.includes("mpskills-update:"))).toBe(true)
  })
})
