import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { SessionV1 } from "../packages/core/src/v1/session"

// Regression battery for bootstrap/plugin/skill-hints.ts. Runs the real
// plugin factory against real temp workspaces (no logic duplicated into the
// tests) and drives the two hooks the plugin exposes.

const factory = (await import(path.join(import.meta.dir, "..", "bootstrap", "plugin", "skill-hints.ts"))).default as Plugin

type Hooks = Awaited<ReturnType<Plugin>>
type ChatHook = NonNullable<Hooks["chat.message"]>
type ChatOutput = Parameters<ChatHook>[1]

const created: string[] = []
async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), "skill-hints-"))
  created.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function hooksFor(directory: string) {
  return factory({ directory } as Parameters<Plugin>[0])
}

async function message(hooks: Hooks, sessionID: string) {
  const parts = await messageParts(hooks, sessionID)
  return parts.map((part) => ("text" in part ? part.text : ""))
}

async function messageParts(hooks: Hooks, sessionID: string, messageID = "msg_test") {
  const output = { message: { id: messageID }, parts: [] } as unknown as ChatOutput
  const chat = hooks["chat.message"] as ChatHook
  await chat({ sessionID, messageID }, output)
  return output.parts
}

async function compact(hooks: Hooks, sessionID: string) {
  await (hooks["experimental.session.compacting"] as NonNullable<Hooks["experimental.session.compacting"]>)({ sessionID }, { context: [] })
}

describe("skill-hints", () => {
  test("pdf at workspace root hints marker, only once per session", async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, "paper.PDF"), "x")
    const hooks = await hooksFor(dir)
    const sessionID = crypto.randomUUID()
    const first = await message(hooks, sessionID)
    expect(first.some((text) => text.includes("marker") && text.includes("skill-hint"))).toBe(true)
    expect(await message(hooks, sessionID)).toEqual([])
  })

  test("pdf nested three directories deep is found", async () => {
    const dir = await workspace()
    await mkdir(path.join(dir, "a", "b", "c"), { recursive: true })
    await writeFile(path.join(dir, "a", "b", "c", "deep.pdf"), "x")
    const hooks = await hooksFor(dir)
    const texts = await message(hooks, crypto.randomUUID())
    expect(texts.some((text) => text.includes("marker"))).toBe(true)
  })

  test("pdf four directories deep is out of the scan bound", async () => {
    const dir = await workspace()
    await mkdir(path.join(dir, "a", "b", "c", "d"), { recursive: true })
    await writeFile(path.join(dir, "a", "b", "c", "d", "too-deep.pdf"), "x")
    const hooks = await hooksFor(dir)
    expect(await message(hooks, crypto.randomUUID())).toEqual([])
  })

  test("pdf inside node_modules or a hidden directory is ignored", async () => {
    const dir = await workspace()
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true })
    await mkdir(path.join(dir, ".cache"), { recursive: true })
    await writeFile(path.join(dir, "node_modules", "pkg", "noise.pdf"), "x")
    await writeFile(path.join(dir, ".cache", "hidden.pdf"), "x")
    const hooks = await hooksFor(dir)
    expect(await message(hooks, crypto.randomUUID())).toEqual([])
  })

  test("no pdf means no hint", async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, "readme.md"), "x")
    const hooks = await hooksFor(dir)
    const sessionID = crypto.randomUUID()
    expect(await message(hooks, sessionID)).toEqual([])
    expect(await message(hooks, sessionID)).toEqual([])
  })

  test("compaction hints a planning read, only once per session", async () => {
    const dir = await workspace()
    const hooks = await hooksFor(dir)
    const sessionID = crypto.randomUUID()
    await compact(hooks, sessionID)
    const first = await message(hooks, sessionID)
    expect(first.some((text) => text.includes("planning") && text.includes("skill-hint"))).toBe(true)
    expect(await message(hooks, sessionID)).toEqual([])
  })

  test("compaction and pdf hints are independent", async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, "paper.pdf"), "x")
    const hooks = await hooksFor(dir)
    const sessionID = crypto.randomUUID()
    await compact(hooks, sessionID)
    expect((await message(hooks, sessionID)).some((text) => text.includes("planning"))).toBe(true)
    expect((await message(hooks, sessionID)).some((text) => text.includes("marker"))).toBe(true)
    expect(await message(hooks, sessionID)).toEqual([])
  })

  test("hint state is tracked per session", async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, "paper.pdf"), "x")
    const hooks = await hooksFor(dir)
    const sessionA = crypto.randomUUID()
    const sessionB = crypto.randomUUID()
    expect((await message(hooks, sessionA)).length).toBe(1)
    expect((await message(hooks, sessionB)).length).toBe(1)
    expect(await message(hooks, sessionA)).toEqual([])
    expect(await message(hooks, sessionB)).toEqual([])
  })

  // Plugin-pushed parts reach the durable-event encoder
  // (packages/core/src/event.ts commitDurableEvent -> Schema.encodeUnknownSync
  // of SessionV1.Event.PartUpdated.data) via Session.updatePart
  // (packages/opencode/src/session/session.ts). An id that is not a PartID
  // throws SchemaError "Expected a string starting with "prt" ... at
  // [\"part\"][\"id\"]" and kills prompt admission, so the hint parts must
  // pass the same checks the publish path runs.
  function expectPartAdmissible(sessionID: string, part: unknown) {
    expect(() =>
      (SessionV1.Event.PartUpdated.data as { make: (input: unknown) => unknown }).make({
        sessionID,
        part,
        time: Date.now(),
      }),
    ).not.toThrow()
    expect((part as { id: string }).id.startsWith("prt")).toBe(true)
  }

  test("pdf hint part carries a valid PartID and survives event validation", async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, "paper.pdf"), "x")
    const hooks = await hooksFor(dir)
    const sessionID = "ses_" + "a".repeat(22)
    const parts = await messageParts(hooks, sessionID, "msg_" + "b".repeat(22))
    expect(parts).toHaveLength(1)
    for (const part of parts) expectPartAdmissible(sessionID, part)
  })

  test("compaction hint part carries a valid PartID and survives event validation", async () => {
    const dir = await workspace()
    const hooks = await hooksFor(dir)
    const sessionID = "ses_" + "a".repeat(22)
    await compact(hooks, sessionID)
    const parts = await messageParts(hooks, sessionID, "msg_" + "b".repeat(22))
    expect(parts).toHaveLength(1)
    for (const part of parts) expectPartAdmissible(sessionID, part)
  })
})
