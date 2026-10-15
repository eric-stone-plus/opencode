import { describe, expect, test } from "bun:test"
import path from "node:path"
import { COMMAND_READS, commandFields, missingReads, SERVER_FIELDS, undeclaredReads } from "./check-command-surfaces"

describe("command surfaces", () => {
  test("sorts the declared schema fields", () => {
    expect(commandFields({ fields: { name: {}, description: {} } })).toEqual(["description", "name"])
    expect(commandFields({ fields: {} })).toEqual([])
  })

  const reads = [
    { surface: "mini catalog", file: "a.ts", field: "name", pattern: /payload\.name\b/ },
    { surface: "mini catalog", file: "a.ts", field: "description", pattern: /payload\.description\b/ },
  ]

  test("reports a consumer whose read disappeared", () => {
    expect(missingReads({ "a.ts": "payload.title" }, reads)).toEqual([
      "mini catalog: a.ts no longer reads name (/payload\\.name\\b/)",
      "mini catalog: a.ts no longer reads description (/payload\\.description\\b/)",
    ])
    expect(missingReads({ "a.ts": "payload.name + payload.description" }, reads)).toEqual([])
  })

  test("reports a read the schema does not declare", () => {
    expect(undeclaredReads(["name"], reads)).toEqual(["mini catalog: reads description, which the schema does not declare"])
    expect(undeclaredReads(["name", "description"], reads)).toEqual([])
  })

  test("the live schema and consumers agree", async () => {
    const directory = path.resolve(import.meta.dirname, "..")
    const { Command } = await import("../packages/schema/src/command.ts")
    const fields = commandFields(Command.Info as unknown as { fields: Record<string, unknown> })
    expect(fields).toEqual([...SERVER_FIELDS].sort())

    const sources: Record<string, string> = {}
    for (const file of new Set(COMMAND_READS.map((read) => read.file))) {
      sources[file] = await Bun.file(path.join(directory, file)).text()
    }
    expect(missingReads(sources)).toEqual([])
    expect(undeclaredReads(fields)).toEqual([])
  })
})
