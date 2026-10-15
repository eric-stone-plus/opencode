// Cross-surface command contract (borrow item C6). One user-visible command surface is described in
// three places — the server's `Command.Info` schema, the TUI prompt (autocomplete and submit), and
// the mini catalog's projection — and nothing checked that they still agree. Two failures are silent
// today: the schema grows a field that every consumer ignores (the capability asymmetry the report
// named: the keymap has argument completion, server commands have none), and a schema rename leaves a
// consumer reading `undefined` until the generated client is regenerated.
//
// This gate is a test only: the fork does not restructure the three surfaces, it pins them.
//
// Usage: bun run check-command-surfaces

import path from "node:path"

// The schema field set is pinned, not derived, so growth is a decision rather than an accident. When
// this fails, check whether the new field should reach the prompt autocomplete, the prompt submit
// path, and the mini catalog before re-pinning.
export const SERVER_FIELDS = ["name", "description"] as const

// Every read of a server command payload the fork depends on, with the variable name each consumer
// uses. A pattern that no longer matches means the consumer was refactored and this pin is blind, so
// the gate fails on absence too.
export const COMMAND_READS = [
  {
    surface: "mini catalog",
    file: "packages/tui/src/mini/catalog.shared.ts",
    field: "name",
    pattern: /input\.name\b/,
  },
  {
    surface: "mini catalog",
    file: "packages/tui/src/mini/catalog.shared.ts",
    field: "description",
    pattern: /input\.description\b/,
  },
  {
    surface: "prompt autocomplete",
    file: "packages/tui/src/component/prompt/autocomplete.tsx",
    field: "name",
    pattern: /serverCommand\.name\b/,
  },
  {
    surface: "prompt autocomplete",
    file: "packages/tui/src/component/prompt/autocomplete.tsx",
    field: "description",
    pattern: /serverCommand\.description\b/,
  },
  {
    surface: "prompt submit",
    file: "packages/tui/src/component/prompt/index.tsx",
    field: "name",
    pattern: /command\.name === slashHead\.name/,
  },
] as const

export function commandFields(schema: { fields: Record<string, unknown> }): string[] {
  return Object.keys(schema.fields).sort()
}

export type CommandRead = { surface: string; file: string; field: string; pattern: RegExp }

export function missingReads(
  sources: Record<string, string>,
  reads: readonly CommandRead[] = COMMAND_READS,
): string[] {
  return reads
    .filter((read) => !read.pattern.test(sources[read.file] ?? ""))
    .map((read) => `${read.surface}: ${read.file} no longer reads ${read.field} (${read.pattern})`)
}

export function undeclaredReads(fields: readonly string[], reads: readonly CommandRead[] = COMMAND_READS): string[] {
  return reads
    .filter((read) => !fields.includes(read.field))
    .map((read) => `${read.surface}: reads ${read.field}, which the schema does not declare`)
}

if (import.meta.main) {
  const directory = path.resolve(import.meta.dirname, "..")
  const { Command } = await import("../packages/schema/src/command.ts")
  const fields = commandFields(Command.Info as unknown as { fields: Record<string, unknown> })

  const problems: string[] = []
  const expected = [...SERVER_FIELDS].sort()
  if (fields.join(",") !== expected.join(",")) {
    problems.push(`Command.Info declares [${fields.join(", ")}], pinned as [${expected.join(", ")}]`)
  }

  const sources: Record<string, string> = {}
  for (const file of new Set(COMMAND_READS.map((read) => read.file))) {
    sources[file] = await Bun.file(path.join(directory, file)).text()
  }
  problems.push(...missingReads(sources))
  problems.push(...undeclaredReads(fields))

  const surfaces = new Map<string, Set<string>>()
  for (const read of COMMAND_READS) {
    const seen = surfaces.get(read.surface) ?? new Set<string>()
    seen.add(read.field)
    surfaces.set(read.surface, seen)
  }
  console.log(`command surface: Command.Info = [${fields.join(", ")}]`)
  for (const [surface, seen] of surfaces) console.log(`  ${surface}: reads [${[...seen].sort().join(", ")}]`)

  if (problems.length > 0) {
    console.error("command surface contract failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log("command surfaces: ok")
}
