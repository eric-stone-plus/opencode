import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "../bootstrap/plugin/skill-hints"

// Standalone battery for the V2 skill-hints plugin (the port of the retired
// V1 bootstrap/plugin-v1/skill-hints.ts). The host is stood in for by a double
// that records the session hooks the plugin registers, so the plugin is driven
// through the real V2 shape — `ctx.session.hook("context" | "compaction", …)`
// with a mutable `event.system` — against real temp workspaces. No plugin logic
// is duplicated into the tests.
//
// The plugin's per-session state is module-global and possibly shared with other
// test files in the same process, so every case uses fresh crypto.randomUUID()
// session ids and temp directories of its own.

type SystemPart = { type: "text"; text: string }
type ContextEvent = { sessionID: string; system: SystemPart[] }
type CompactionEvent = { sessionID: string }
type ContextCallback = (event: ContextEvent) => Promise<void> | void
type CompactionCallback = (event: CompactionEvent) => Promise<void> | void
type HookCallback = ContextCallback & CompactionCallback

const contextCallbacks: ContextCallback[] = []
const compactionCallbacks: CompactionCallback[] = []

const context = {
  location: { directory: "", workspaceID: undefined, project: { id: "test", directory: "", canonical: "" } },
  session: {
    hook: async (name: string, callback: HookCallback) => {
      if (name === "context") contextCallbacks.push(callback)
      else if (name === "compaction") compactionCallbacks.push(callback)
      else throw new Error(`skill-hints registered an unexpected hook: ${name}`)
      return { dispose: async () => {} }
    },
  },
}

await (plugin.setup as (ctx: unknown) => Promise<void>)(context)

const directories: string[] = []

async function temporary() {
  // TMPDIR may point at a directory that does not exist yet (the verify command sets
  // TMPDIR=/dev/shm/tt/script); mkdtemp needs the parent, and creating it is a no-op otherwise.
  const base = tmpdir()
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(path.join(base, "skill-hints-"))
  directories.push(directory)
  return directory
}

async function point(directory: string) {
  context.location.directory = directory
}

afterEach(async () => {
  context.location.directory = ""
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function compact(sessionID: string) {
  for (const callback of compactionCallbacks) await callback({ sessionID })
}

async function parts(sessionID: string) {
  const event: ContextEvent = { sessionID, system: [] }
  for (const callback of contextCallbacks) await callback(event)
  return event.system
}

async function texts(sessionID: string) {
  return (await parts(sessionID)).map((part) => part.text)
}

describe("skill-hints", () => {
  test("registers one context hook and one compaction hook", () => {
    expect(contextCallbacks).toHaveLength(1)
    expect(compactionCallbacks).toHaveLength(1)
  })

  test("compaction hints a planning read once, then stays silent", async () => {
    await point(await temporary())
    const sessionID = crypto.randomUUID()
    expect(await texts(sessionID)).toEqual([])
    await compact(sessionID)
    const first = await texts(sessionID)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain("compaction just ran")
    expect(first[0]).toContain("skill-hint")
    expect(await texts(sessionID)).toEqual([])
  })

  test("a PDF in the workspace hints marker once per session", async () => {
    const directory = await temporary()
    await writeFile(path.join(directory, "paper.PDF"), "x")
    await point(directory)
    const sessionID = crypto.randomUUID()
    const first = await texts(sessionID)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain("marker")
    expect(first[0]).toContain("skill-hint")
    expect(await texts(sessionID)).toEqual([])
  })

  test("injects a plain text system part", async () => {
    const directory = await temporary()
    await writeFile(path.join(directory, "paper.pdf"), "x")
    await point(directory)
    expect(await parts(crypto.randomUUID())).toEqual([{ type: "text", text: expect.any(String) }])
  })

  test("a PDF three directories deep is inside the scan bound, four is not", async () => {
    const nested = await temporary()
    await mkdir(path.join(nested, "a", "b", "c"), { recursive: true })
    await writeFile(path.join(nested, "a", "b", "c", "deep.pdf"), "x")
    await point(nested)
    expect(await texts(crypto.randomUUID())).toHaveLength(1)

    const tooDeep = await temporary()
    await mkdir(path.join(tooDeep, "a", "b", "c", "d"), { recursive: true })
    await writeFile(path.join(tooDeep, "a", "b", "c", "d", "too-deep.pdf"), "x")
    await point(tooDeep)
    expect(await texts(crypto.randomUUID())).toEqual([])
  })

  test("a PDF under node_modules or a dot directory is skipped", async () => {
    const directory = await temporary()
    await mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true })
    await mkdir(path.join(directory, ".cache"), { recursive: true })
    await writeFile(path.join(directory, "node_modules", "pkg", "noise.pdf"), "x")
    await writeFile(path.join(directory, ".cache", "hidden.pdf"), "x")
    await point(directory)
    expect(await texts(crypto.randomUUID())).toEqual([])
  })

  test("a workspace without PDFs hints nothing", async () => {
    const directory = await temporary()
    await writeFile(path.join(directory, "readme.md"), "x")
    await point(directory)
    const sessionID = crypto.randomUUID()
    expect(await texts(sessionID)).toEqual([])
    expect(await texts(sessionID)).toEqual([])
  })

  test("a missing workspace directory does not throw", async () => {
    const directory = await temporary()
    await rm(directory, { recursive: true, force: true })
    await point(path.join(directory, "gone"))
    await expect(texts(crypto.randomUUID())).resolves.toEqual([])
  })

  test("hint state is tracked per session", async () => {
    const directory = await temporary()
    await writeFile(path.join(directory, "paper.pdf"), "x")
    await point(directory)
    const sessionA = crypto.randomUUID()
    const sessionB = crypto.randomUUID()
    expect(await texts(sessionA)).toHaveLength(1)
    expect(await texts(sessionB)).toHaveLength(1)
    expect(await texts(sessionA)).toEqual([])
    expect(await texts(sessionB)).toEqual([])
  })

  test("the compaction flag is per session", async () => {
    await point(await temporary())
    const compaction = crypto.randomUUID()
    const other = crypto.randomUUID()
    await compact(compaction)
    expect(await texts(other)).toEqual([])
    expect((await texts(compaction))[0]).toContain("compaction just ran")
  })

  test("compaction and PDF hints are independent for one session", async () => {
    const directory = await temporary()
    await writeFile(path.join(directory, "paper.pdf"), "x")
    await point(directory)
    const sessionID = crypto.randomUUID()
    await compact(sessionID)
    expect((await texts(sessionID))[0]).toContain("compaction just ran")
    expect((await texts(sessionID))[0]).toContain("marker")
    expect(await texts(sessionID)).toEqual([])
  })
})
