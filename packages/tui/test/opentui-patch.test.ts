import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

// `patches/@opentui%2Fcore@0.5.17.patch` carries two fork invariants that upstream does not ship:
// a 16 ms floor between frames (asserted behaviourally in render-floor.test.ts) and a shutdown
// guard that keeps a destroyed CodeRenderable from warning while a highlight promise settles.
// The guard was silently dropped once when the patch was re-derived for a new opentui version, so
// this reads the installed bundle and fails when the shipped artifact is missing either invariant.
const packageDirectory = dirname(fileURLToPath(import.meta.resolve("@opentui/core")))

async function chunks() {
  const files = await readdir(packageDirectory)
  const bodies = await Promise.all(
    files.filter((file) => file.startsWith("chunk-") && file.endsWith(".js")).map((file) => readFile(`${packageDirectory}/${file}`, "utf8")),
  )
  return bodies
}

test("the patched opentui bundle still guards the highlight warning against a destroyed renderable", async () => {
  const bodies = (await chunks()).filter((body) => body.includes("Code highlighting failed"))
  expect(bodies.length).toBeGreaterThan(0)
  for (const body of bodies) {
    const warning = body.indexOf("Code highlighting failed")
    // The guard has to be the statement the warning is reached through, not one that runs after it.
    expect(body.slice(warning - 200, warning)).toContain("isDestroyed")
  }
})

test("the patched opentui bundle still floors the frame delay at 16 ms", async () => {
  const bodies = await chunks()
  expect(bodies.some((body) => body.includes("Math.max(16, targetFrameTime"))).toBe(true)
  expect(bodies.every((body) => !body.includes("Math.max(1, targetFrameTime"))).toBe(true)
})
