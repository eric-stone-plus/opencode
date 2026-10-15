// Single-turn-loop guard. AGENTS.md ("Architecture > How Sessions Work") pins one `llm.stream(...)`
// call per Physical Attempt, with the runner orchestrating turns through `runStep`: no in-memory tool
// loop may stream the model itself. A name-based scan cannot prove the shape, but it can refuse new
// call sites outright, and that is where the invariant breaks: every extra streaming site is a second
// turn loop waiting to grow.
//
// Usage:
//   bun run check-single-loop
//
// Exit 1 when a file outside ALLOWED_LLM_STREAM_SITES calls `llm.stream(`, or when a whitelisted file
// no longer does (the whitelist must stay honest). New call sites need review: deliberate one-shot
// calls (compaction, title) join the whitelist with a reason; anything that would orchestrate a turn
// belongs in packages/core/src/session/runner/step.ts.

import { Glob } from "bun"
import { readFile } from "node:fs/promises"
import path from "node:path"

// The only files that may call `.stream(`. `why` states the intent so review has something to argue with.
export const ALLOWED_LLM_STREAM_SITES = [
  {
    file: "packages/core/src/session/runner/step.ts",
    why: "the single per-step stream: the runner orchestrates turns through runStep, each attempt streams exactly once",
  },
  {
    file: "packages/core/src/session/compaction.ts",
    why: "one-shot transcript summarization; no turn loop and no tool orchestration",
  },
  {
    file: "packages/core/src/session/title.ts",
    why: "one-shot title generation; no turn loop and no tool orchestration",
  },
  {
    file: "packages/core/src/filesystem.ts",
    why: "fs.stream(...) opens a filesystem byte stream, not a model call - listed because the scan is name-based and cannot tell receivers apart",
  },
]

// Any receiver and the computed form: `client.stream(`, `llm .stream(` and `llm["stream"](` used to
// pass the old `llm.stream(` literal silently. A rename or a destructured `stream` can still hide a
// call, so the reviewer's eye stays the second gate - the scan only widens what it refuses.
const STREAM_CALL = /\b[A-Za-z_$][\w$]*\s*\.\s*stream\s*\(|\b[A-Za-z_$][\w$]*\s*\[\s*["']stream["']\s*\]\s*\(/

export async function checkSingleTurnLoop(directory: string): Promise<string[]> {
  const problems: string[] = []
  const seen = new Set<string>()
  const glob = new Glob("packages/core/src/**/*.ts")
  for await (const relative of glob.scan({ cwd: directory })) {
    const source = await readFile(path.join(directory, relative), "utf8")
    const lines = source.split("\n")
    for (const [index, line] of lines.entries()) {
      if (!STREAM_CALL.test(line)) continue
      seen.add(relative)
      const allowed = ALLOWED_LLM_STREAM_SITES.some((entry) => entry.file === relative)
      if (!allowed) problems.push(`${relative}:${index + 1} calls .stream(...) outside ALLOWED_LLM_STREAM_SITES`)
    }
  }
  for (const entry of ALLOWED_LLM_STREAM_SITES) {
    if (!seen.has(entry.file)) problems.push(`${entry.file} no longer calls .stream(...) - update ALLOWED_LLM_STREAM_SITES`)
  }
  return problems
}

if (import.meta.main) {
  const problems = await checkSingleTurnLoop(process.cwd())
  if (problems.length > 0) {
    console.error("single-turn-loop invariant failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      "\nNew llm.stream(...) call sites need review (AGENTS.md, 'Architecture > How Sessions Work')." +
        "\nDeliberate one-shot calls join ALLOWED_LLM_STREAM_SITES in script/check-single-loop.ts with a reason;" +
        "\nturn orchestration belongs in packages/core/src/session/runner/step.ts.",
    )
    process.exit(1)
  }
  console.log(
    `single-turn-loop: ok (${ALLOWED_LLM_STREAM_SITES.length} allowed call sites; name-bound scan - aliases and destructured stream() need the reviewer's eye)`,
  )
}
