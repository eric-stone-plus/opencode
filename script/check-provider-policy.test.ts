import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ModelsDev } from "../packages/schema/src/models-dev"
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

  // Anti-blindness: the gate's KEPT/DROPPED lists are checked against the same predicate, so a widened
  // predicate could satisfy both. This pins the predicate itself to the shipped single-vendor policy.
  test("pins the shipped allowlist to DeepSeek alone (ADR 0009)", () => {
    expect(Object.keys(ModelsDev.restrict({ deepseek: {}, "xiaomi-token-plan-cn": {}, alibaba: {}, "zai": {} }))).toEqual([
      "deepseek",
    ])
  })

  test("flags a removed vendor file that an upstream merge brought back", async () => {
    const fixture = await tree({})
    try {
      await Bun.write(path.join(fixture.root, "packages/ai/src/providers/alibaba.ts"), "export {}\n")
      const problems = await checkProviderPolicy(fixture.root)
      expect(problems.some((problem) => problem.includes("alibaba.ts exists again"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })
})
