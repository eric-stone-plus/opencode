import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ALLOWED_LLM_STREAM_SITES, checkSingleTurnLoop } from "./check-single-loop"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-loop-test-"))
  directories.push(directory)
  return directory
}

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
}

const stream = "const providerStream = llm.stream(input.request, input.options)\n"

describe("checkSingleTurnLoop", () => {
  test("passes when only the whitelisted files stream the model", async () => {
    const directory = await temporary()
    for (const entry of ALLOWED_LLM_STREAM_SITES) await write(path.join(directory, entry.file), stream)
    await write(path.join(directory, "packages/core/src/session/runner/llm.ts"), "runStep(input)\n")
    expect(await checkSingleTurnLoop(directory)).toEqual([])
  })

  test("flags a new call site with its line", async () => {
    const directory = await temporary()
    for (const entry of ALLOWED_LLM_STREAM_SITES) await write(path.join(directory, entry.file), stream)
    await write(path.join(directory, "packages/core/src/session/runner/llm.ts"), `runStep(input)\n${stream}`)
    expect(await checkSingleTurnLoop(directory)).toEqual([
      "packages/core/src/session/runner/llm.ts:2 calls .stream(...) outside ALLOWED_LLM_STREAM_SITES",
    ])
  })

  test("flags a whitelisted file that no longer streams", async () => {
    const directory = await temporary()
    await write(path.join(directory, ALLOWED_LLM_STREAM_SITES[0].file), stream)
    expect(await checkSingleTurnLoop(directory)).toEqual([
      "packages/core/src/session/compaction.ts no longer calls .stream(...) - update ALLOWED_LLM_STREAM_SITES",
      "packages/core/src/session/title.ts no longer calls .stream(...) - update ALLOWED_LLM_STREAM_SITES",
      "packages/core/src/filesystem.ts no longer calls .stream(...) - update ALLOWED_LLM_STREAM_SITES",
    ])
  })

  test("flags aliased and computed stream calls", async () => {
    const directory = await temporary()
    for (const entry of ALLOWED_LLM_STREAM_SITES) await write(path.join(directory, entry.file), stream)
    await write(
      path.join(directory, "packages/core/src/session/runner/loop.ts"),
      'const one = client["stream"](request, options)\nconst two = client .stream(request, options)\n',
    )
    expect(await checkSingleTurnLoop(directory)).toEqual([
      "packages/core/src/session/runner/loop.ts:1 calls .stream(...) outside ALLOWED_LLM_STREAM_SITES",
      "packages/core/src/session/runner/loop.ts:2 calls .stream(...) outside ALLOWED_LLM_STREAM_SITES",
    ])
  })

  test("the guarded repository satisfies the invariant", async () => {
    expect(await checkSingleTurnLoop(path.resolve(import.meta.dirname, ".."))).toEqual([])
  })
})
