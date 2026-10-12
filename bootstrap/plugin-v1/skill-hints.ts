import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

// Deterministic skill hints for two situations pure description matching
// cannot see: (1) compaction just ran, which erases the salience of the plan
// files, and (2) PDFs sitting in the workspace the model never looked at.
// Auto-activation itself is description matching in the system prompt (there
// is no router in packages/opencode/src); this plugin only adds a one-line
// nudge, once per session per signal, as a synthetic text part. The part must
// carry a prt_ id and the user message's msg_ id: Session.updatePart encodes
// it against the PartID schema before the durable-event commit, and a UUID id
// kills the whole prompt as a server error.
//
// Deliberately NOT implemented: git-status non-empty -> code-review. A dirty
// tree is the ambient state of every development session, so that signal is
// constant noise; code-review's description already carries its triggers.
//
// Each signal fires at most once per session and the whole state map is
// capped, so this costs at most a couple of one-line parts per session and a
// bounded directory walk on the first user message. Every failure is
// swallowed: a hint is a nudge, never a gate. The compaction hook is
// experimental; if it disappears the hint simply never fires again.
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

// Mirrors packages/opencode/src/id/id.ts create("prt"): prt_ + a 26-char body
// of 6-byte big-endian (ms * 0x1000 + counter) hex plus 14 base62 chars.
// Deployed plugins load standalone and cannot import the app's Identifier.
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let idLastMs = 0
let idCounter = 0
function partID() {
  const now = Date.now()
  if (now !== idLastMs) {
    idLastMs = now
    idCounter = 0
  }
  idCounter++
  const value = BigInt(now) * BigInt(0x1000) + BigInt(idCounter)
  let body = ""
  for (let i = 0; i < 6; i++) {
    body += Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
      .toString(16)
      .padStart(2, "0")
  }
  const random = crypto.getRandomValues(new Uint8Array(14))
  for (let i = 0; i < 14; i++) body += ID_CHARS[random[i]! % 62]
  return "prt_" + body
}

// The message id lives on output.message; the hook input carries one only
// when the caller pinned it. A hint without a valid msg_ id would kill
// admission exactly like a UUID part id, so skip instead of pushing it.
function hintPart(sessionID: string, messageID: string | undefined, text: string) {
  if (!messageID?.startsWith("msg")) return
  return {
    id: partID(),
    sessionID,
    messageID,
    type: "text" as const,
    text,
    synthetic: true,
  }
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

export default (async (input: PluginInput) => {
  return {
    "experimental.session.compacting": async (hookInput) => {
      track(hookInput.sessionID).compacted = true
    },
    "chat.message": async (hookInput, output) => {
      const state = track(hookInput.sessionID)
      const messageID = output.message.id
      if (state.compacted) {
        const part = hintPart(hookInput.sessionID, messageID, HINT_COMPACTION)
        if (!part) return
        state.compacted = false
        output.parts.push(part)
        return
      }
      if (state.hintedPdf) return
      if (!(await hasPdf(input.directory).catch(() => false))) return
      const part = hintPart(hookInput.sessionID, messageID, HINT_PDF)
      if (!part) return
      state.hintedPdf = true
      output.parts.push(part)
    },
  }
}) satisfies Plugin
