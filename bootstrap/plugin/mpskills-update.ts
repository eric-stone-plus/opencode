import path from "node:path"
import { homedir } from "node:os"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

// Refresh the mattpocock skills only when the skill tool is about to load one
// of them — never on a bare opencode launch, and never for skills this fork
// doesn't vendor (the user's own skills-extra, or the built-in
// customize-opencode). Throttled to once per day: calling a mattpocock skill
// repeatedly in one session should not re-hit the network every time.
//
// Blocking by design: the point is that the skill content the model reads in
// *this* call is current. Every external command runs under `timeout`, so a
// stalled network can only ever cost this one call a few seconds; any
// failure is swallowed and the stale on-disk copy is served instead of
// blocking the skill load.
const REPO = "/home/eric/Documents/Development/private/agent-design/projects/opencode"
const UPSTREAM_URL = "https://github.com/mattpocock/skills.git"
const THROTTLE_MS = 24 * 60 * 60 * 1000

export default (async (input: PluginInput) => {
  return {
    "tool.execute.before": async (hookInput, output) => {
      if (hookInput.tool !== "skill") return
      const name = String((output.args as { name?: unknown })?.name ?? "")
      if (!name) return
      if (!(await Bun.file(path.join(REPO, "skills", name, "SKILL.md")).exists())) return

      const home = process.env.HOME ?? homedir()
      if (await throttled(home)) return
      await touchThrottle(home)
      await refresh(input.$.nothrow(), home).catch((err) =>
        console.error(`mpskills-update: ${err instanceof Error ? err.message : String(err)}`),
      )
    },
  }
}) satisfies Plugin

function cacheDir(home: string) {
  return path.join(home, ".cache", "opencode")
}

async function throttled(home: string) {
  const marker = Bun.file(path.join(cacheDir(home), "mattpocock-upstream.last-check"))
  if (!(await marker.exists())) return false
  return Date.now() - marker.lastModified < THROTTLE_MS
}

function touchThrottle(home: string) {
  return Bun.write(path.join(cacheDir(home), "mattpocock-upstream.last-check"), new Date().toISOString())
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

async function syncCheckout(sh: PluginInput["$"], checkout: string) {
  if (await Bun.file(path.join(checkout, ".git", "HEAD")).exists()) {
    await run(sh`timeout 10 git -C ${checkout} fetch --quiet origin main --depth 1`, "fetch")
    await run(sh`timeout 5 git -C ${checkout} reset --quiet --hard origin/main`, "reset")
    return
  }
  await run(sh`rm -rf ${checkout}`, "clean stale checkout")
  await run(sh`mkdir -p ${path.dirname(checkout)}`, "create cache dir")
  await run(sh`timeout 15 git clone --quiet --depth 1 ${UPSTREAM_URL} ${checkout}`, "clone")
}

// Vendor + install + commit happen together: a revision bump with no change
// readers care about (e.g. a doc-only commit outside the vendored buckets)
// must not leave a stray commit, so the actual working-tree diff gates it.
async function refresh(sh: PluginInput["$"], home: string) {
  const checkout = path.join(cacheDir(home), "mattpocock-upstream")
  await syncCheckout(sh, checkout)

  const before = await currentRevision()
  const after = (await run(sh`timeout 5 git -C ${checkout} rev-parse HEAD`, "rev-parse")).text().trim()
  if (!after || after === before) return

  await run(sh`timeout 15 bun run vendor-skills --source ${checkout}`.cwd(REPO), "vendor-skills")

  const { installSkills } = (await import(path.join(REPO, "script", "sync-upstream.ts"))) as {
    installSkills: (source: string, destination: string) => Promise<number>
  }
  await installSkills(path.join(REPO, "skills"), path.join(home, ".config", "opencode", "skills"))

  const diff = (await run(sh`timeout 5 git -C ${REPO} status --porcelain -- skills`, "status")).text().trim()
  if (!diff) return

  await run(sh`timeout 5 git -C ${REPO} add skills`, "add")
  const message = `chore: vendor mattpocock skills refresh (${after.slice(0, 8)})\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
  await run(sh`timeout 5 git -C ${REPO} commit --quiet -m ${message}`, "commit")
}
