import { homedir } from "node:os"

// Refresh the mattpocock skills once per opencode config load. The script is
// self-throttled (one pull per 7 days, 60s cap) and exits silently when fresh
// or unreachable, so a missing binary is a clean skip and only a nonzero exit
// is worth a line on stderr.
//
// Fire-and-forget on purpose: plugin config hooks are awaited one after
// another during startup (packages/opencode/src/plugin/index.ts), so awaiting
// the child here would stall every launch for as long as a hung
// `timeout 60 git pull` runs. The exit is observed in the background instead.
export default async () => ({
  config: async () => {
    const home = process.env.HOME ?? homedir()
    try {
      const proc = Bun.spawn([`${home}/.local/bin/mpskills-update`], {
        stdout: "ignore",
        stderr: "pipe",
      })
      proc.unref()
      void proc.exited
        .then(async (code) => {
          if (code === 0) return
          const err = (await new Response(proc.stderr).text()).trim()
          console.error(`mpskills-update: exit ${code}${err ? `: ${err}` : ""}`)
        })
        .catch(() => {})
    } catch {
      // Bun.spawn throws ENOENT synchronously when the script is not
      // installed on this machine: skip cleanly.
    }
  },
})
