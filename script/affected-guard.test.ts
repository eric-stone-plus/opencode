import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { testBearingChanged } from "./affected-guard"

async function tree(manifests: Record<string, Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), "affected-guard-"))
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }))
  for (const [directory, scripts] of Object.entries(manifests)) {
    await Bun.write(path.join(root, directory, "package.json"), JSON.stringify({ scripts }))
  }
  return root
}

async function run(root: string, changed: readonly string[]) {
  return testBearingChanged(
    root,
    changed,
    async (file) => Bun.file(file).exists(),
    async (manifest) => {
      const parsed = (await Bun.file(manifest).json()) as { scripts?: Record<string, string> }
      return parsed.scripts
    },
  )
}

describe("affected guard", () => {
  test("flags a changed file inside a test-bearing workspace", async () => {
    const root = await tree({ "packages/core": { test: "bun run test" }, "services/www": { build: "vite build" } })
    try {
      expect(await run(root, ["packages/core/src/session.ts"])).toEqual(["packages/core"])
      expect(await run(root, ["services/www/app/page.tsx"])).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("walks nested workspaces to the nearest manifest", async () => {
    const root = await tree({ "packages/console/app": { test: "bun run test" } })
    try {
      expect(await run(root, ["packages/console/app/src/route.tsx"])).toEqual(["packages/console/app"])
      expect(await run(root, ["packages/console/app/README.md"])).toEqual(["packages/console/app"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("accepts docs-only and root-level changes", async () => {
    const root = await tree({ "packages/core": { test: "bun run test" } })
    try {
      expect(await run(root, ["docs/OPERATIONS.md", "README.md", "script/check-drift.ts"])).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("deduplicates workspaces and sorts the result", async () => {
    const root = await tree({ "packages/core": { test: "bun run test" }, "packages/ai": { test: "bun test" } })
    try {
      expect(await run(root, ["packages/core/a.ts", "packages/ai/b.ts", "packages/core/c.ts"])).toEqual([
        "packages/ai",
        "packages/core",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
