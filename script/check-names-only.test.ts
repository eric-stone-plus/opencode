import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { checkNamesOnly } from "./check-names-only"

// Shaped like a credential, obviously not one: the gate reads patterns, not entropy.
const fakeKey = "sk-FAKEFAKEFAKE1234567890FAKE"

const valid = {
  "auth.json.template": `{\n  "deepseek": {\n    "type": "api",\n    "key": "REPLACE_ME_SEE_README_RESEED_TABLE"\n  }\n}\n`,
  "env.template": "# seed only\nexport OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=\n",
  "opencode.jsonc": `{\n  "provider": {\n    "deepseek": { "npm": "@ai-sdk/openai-compatible" }\n  }\n}\n`,
  "environment.d/10-opencode-db.conf": "OPENCODE_DB=opencode-main.db\n",
  "environment.d/90-fcitx5.conf": "QT_IM_MODULE=fcitx\nXMODIFIERS=@im=fcitx\n",
}

async function tree(files: Record<string, string> = valid) {
  const root = await mkdtemp(path.join(tmpdir(), "names-only-"))
  for (const [file, text] of Object.entries(files)) await Bun.write(path.join(root, "bootstrap/config", file), text)
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe("NAMES-ONLY gate", () => {
  test("accepts the bundle's current shape", async () => {
    const fixture = await tree()
    try {
      expect(await checkNamesOnly(fixture.root)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags a re-seeded auth.json template", async () => {
    const fixture = await tree({
      ...valid,
      "auth.json.template": `{\n  "deepseek": {\n    "type": "api",\n    "key": "${fakeKey}"\n  }\n}\n`,
    })
    try {
      const problems = await checkNamesOnly(fixture.root)
      expect(problems.some((problem) => problem.includes("REPLACE_ME"))).toBe(true)
      expect(problems.some((problem) => problem.includes("API key"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags a value in a seed file", async () => {
    const fixture = await tree({ ...valid, "env.template": "export DEEPSEEK_API_KEY=some-live-value\n" })
    try {
      const problems = await checkNamesOnly(fixture.root)
      expect(problems.some((problem) => problem.includes("carry names only"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags an environment.d drop-in that ships a value", async () => {
    const fixture = await tree({ ...valid, "environment.d/95-provider.conf": "SOME_KEY=a-value-that-is-not-a-name\n" })
    try {
      const problems = await checkNamesOnly(fixture.root)
      expect(problems.some((problem) => problem.includes("95-provider.conf"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags a credential-shaped string anywhere under bootstrap/config", async () => {
    const fixture = await tree({ ...valid, "notes.md": `token: Bearer ${"a".repeat(24)}\n` })
    try {
      const problems = await checkNamesOnly(fixture.root)
      expect(problems.some((problem) => problem.includes("bearer token"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("flags an apiKey line in the config mirror", async () => {
    const fixture = await tree({
      ...valid,
      "opencode.jsonc": `{\n  "provider": {\n    "deepseek": { "options": { "apiKey": "${fakeKey}" } }\n  }\n}\n`,
    })
    try {
      const problems = await checkNamesOnly(fixture.root)
      expect(problems.some((problem) => problem.includes("apiKey"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })
})
