import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"

// Skill hints (2026-10-06, ported to OpenCode V2 2026-10-12): deterministic hints for two
// situations pure description matching cannot see: (1) compaction just ran, which erases the
// salience of the plan files, and (2) PDFs sitting in the workspace the model never looked at.
// Auto-activation itself is description matching in the system prompt (there is no router in
// packages/opencode/src); this plugin only adds a one-line nudge, once per session per signal.
//
// V1 -> V2 mapping. V1 pushed synthetic text parts into the outgoing chat message; V2 has no
// synthetic parts, so the same texts ride on the request's mutable `system` array
// (`ctx.session.hook("context", event => event.system.push({ type: "text", text }))`), the pattern
// packages/core/src/plugin/fork/cards.ts uses on the effect API. A request's system parts are
// rebuilt on every call, so there is no part id and no msg_ id to encode, and the V1
// id-generation/admission-guard machinery (the prt_ id factory and the message-id check) is gone
// with it. V1's `experimental.session.compacting` event becomes the `compaction` session hook,
// which fires when a compaction request is prepared; it sets the flag for event.sessionID and the
// next `context` call for that session spends it. The PDF scan is plugin-level: it walks
// ctx.location.directory the first time a session reaches `context`, caches the answer per
// session, and injects at most once.
//
// Deliberately NOT implemented: git-status non-empty -> code-review. A dirty tree is the ambient
// state of every development session, so that signal is constant noise; code-review's description
// already carries its triggers.
//
// Each signal fires at most once per session and the whole state map is capped, so this costs at
// most a couple of one-line parts per session and a bounded directory walk on the first context
// call. Every failure is swallowed: a hint is a nudge, never a gate, and a hook that threw would
// break the request it rides on. The compaction hook is experimental; if it disappears the hint
// simply never fires again.
//
// Runtime imports: node builtins only (node:path, node:fs/promises). The file also loads
// standalone in script/skill-hints.test.ts.
const HINT_COMPACTION =
  '[skill-hint] compaction just ran: call planning(action: "read") to restore the plan/findings/progress files before continuing (skill planning-with-files holds the recovery discipline).'
const HINT_PDF =
  "[skill-hint] *.pdf files exist in this workspace: the marker skill converts PDFs to Markdown/JSON/HTML — prefer it over ad-hoc pdftotext."
const MAX_TRACKED_SESSIONS = 256
const MAX_SCANNED_DIRS = 200
const SCAN_SKIPS = new Set(["node_modules", ".git", ".cache", ".venv", "__pycache__", "dist", "build", "out"])

type SessionState = { compacted: boolean; hintedPdf: boolean }
const sessions = new Map<string, SessionState>()

function track(sessionID: string) {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  if (sessions.size >= MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest !== undefined) sessions.delete(oldest)
  }
  const fresh: SessionState = { compacted: false, hintedPdf: false }
  sessions.set(sessionID, fresh)
  return fresh
}

async function hasPdf(root: string) {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let scanned = 0
  while (queue.length > 0 && scanned < MAX_SCANNED_DIRS) {
    const item = queue.shift()
    if (!item) return false
    scanned++
    const entries = await readdir(item.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) return true
      if (entry.isDirectory() && item.depth < 3 && !SCAN_SKIPS.has(entry.name)) {
        queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 })
      }
    }
  }
  return false
}

export default {
  id: "skill-hints",
  async setup(ctx) {
    await ctx.session.hook("compaction", (event) => {
      track(event.sessionID).compacted = true
    })
    await ctx.session.hook("context", async (event) => {
      try {
        const state = track(event.sessionID)
        if (state.compacted) {
          state.compacted = false
          event.system.push({ type: "text", text: HINT_COMPACTION })
          return
        }
        if (state.hintedPdf) return
        if (!(await hasPdf(ctx.location.directory).catch(() => false))) return
        state.hintedPdf = true
        event.system.push({ type: "text", text: HINT_PDF })
      } catch {
        // Swallowed on purpose: a hint is a nudge, never a gate, and a hook that threw would break
        // the request it rides on. Nothing is lost beyond this one attempt: a later context call
        // re-reads the per-session state.
      }
    })
  },
} satisfies Plugin.Plugin
