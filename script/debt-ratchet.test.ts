import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BASELINE_PATH, checkDebtRatchet, countDebt, readBaseline, writeBaseline } from "./debt-ratchet"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-ratchet-test-"))
  directories.push(directory)
  return directory
}

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
}

const clean = { "ts-suppressions": 0, "any-usage": 0, "todo-markers": 0 }

describe("debt ratchet", () => {
  test("counts every metric by matches, not by lines", async () => {
    const directory = await temporary()
    await write(
      path.join(directory, "packages/core/src/a.ts"),
      "const first: any = 1\nconst second: any = 2 // TODO and FIXME\n// @ts-expect-error\n",
    )
    await write(path.join(directory, "packages/core/src/b.tsx"), "const value = body as any // XXX\n")
    expect(await countDebt(directory)).toEqual({ "ts-suppressions": 1, "any-usage": 3, "todo-markers": 3 })
  })

  test("generated code is out of scope", async () => {
    const directory = await temporary()
    await write(path.join(directory, "packages/core/src/database/schema.gen.ts"), "const value: any = 1 // TODO\n")
    await write(path.join(directory, "packages/client/src/promise/generated/types.ts"), "const value: any = 1 // TODO\n")
    await write(path.join(directory, "packages/core/node_modules/dep/index.ts"), "const value: any = 1 // TODO\n")
    expect(await countDebt(directory)).toEqual(clean)
  })

  test("a hand-written file cannot dodge the ratchet with a .gen.ts name", async () => {
    const directory = await temporary()
    await write(path.join(directory, "packages/core/src/escape.gen.ts"), "const value: any = 1 // TODO\n")
    expect(await countDebt(directory)).toEqual({ "ts-suppressions": 0, "any-usage": 1, "todo-markers": 1 })
  })

  test("generic and file-level any escapes count", async () => {
    const directory = await temporary()
    await write(
      path.join(directory, "packages/core/src/a.ts"),
      "const list: Array<any> = []\ntype Bag = Record<string, any>\n// @ts-nocheck\n",
    )
    expect(await countDebt(directory)).toEqual({ "ts-suppressions": 1, "any-usage": 2, "todo-markers": 0 })
  })

  test("growing a metric fails the gate and shrinking it passes", async () => {
    const directory = await temporary()
    await write(path.join(directory, "packages/core/src/a.ts"), "const value: any = 1\n")
    await writeBaseline(directory, clean)
    expect(await checkDebtRatchet(directory)).toEqual(["any-usage grew: 0 -> 1 (untyped values entering the type system)"])
    await writeBaseline(directory, { ...clean, "any-usage": 2 })
    expect(await checkDebtRatchet(directory)).toEqual([])
  })

  test("the baseline round-trips as a flat object", async () => {
    const directory = await temporary()
    await writeBaseline(directory, { ...clean, "any-usage": 2 })
    expect(await readBaseline(directory)).toEqual({ ...clean, "any-usage": 2 })
    expect(JSON.parse(await readFile(path.join(directory, BASELINE_PATH), "utf8"))).toEqual({ ...clean, "any-usage": 2 })
  })

  test("the guarded repository is at or below its baseline", async () => {
    expect(await checkDebtRatchet(path.resolve(import.meta.dirname, ".."))).toEqual([])
  })
})
