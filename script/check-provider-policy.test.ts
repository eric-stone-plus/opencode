import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { checkProviderPolicy } from "./check-provider-policy"

const validModelsDev = "for (const item of Object.values(ModelsDev.restrict(input))) {}\nconst fetch = options?.fetch ?? false\n"
const validDeclared = "providers.remove(providerID)\n"

async function tree(files: { modelsDev?: string; declared?: string }) {
  const root = await mkdtemp(path.join(tmpdir(), "provider-policy-"))
  const modelsDevPath = path.join(root, "packages/core/src/models-dev.ts")
  const declaredPath = path.join(root, "packages/core/src/plugin/fork/declared-providers.ts")
  await Bun.write(modelsDevPath, files.modelsDev ?? validModelsDev)
  await Bun.write(declaredPath, files.declared ?? validDeclared)
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("provider policy gate", () => {
  test("accepts the fork's policy shape", async () => {
    const fixture = await tree({})
    try {
      expect(await checkProviderPolicy(fixture.root)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags a models-dev module that stops funneling through the allowlist", async () => {
    const fixture = await tree({ modelsDev: "const fetch = options?.fetch ?? false\n" })
    try {
      const problems = await checkProviderPolicy(fixture.root)
      expect(problems.some((problem) => problem.includes("ModelsDev.restrict"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags an implicit-fetch default flip", async () => {
    const fixture = await tree({ modelsDev: "ModelsDev.restrict(input)\nconst fetch = options?.fetch ?? true\n" })
    try {
      const problems = await checkProviderPolicy(fixture.root)
      expect(problems.some((problem) => problem.includes("implicit fetch"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags a declared-providers plugin that starts adding providers", async () => {
    const fixture = await tree({ declared: "providers.add(providerID)\n" })
    try {
      const problems = await checkProviderPolicy(fixture.root)
      expect(problems.some((problem) => problem.includes("adds providers"))).toBe(true)
      expect(problems.some((problem) => problem.includes("no longer drops"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })
})
