import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import parsers from "../src/parsers-config"
import { materializeTreeSitterAssets, resolveTreeSitterParsers } from "../src/tree-sitter-assets"
import { treeSitterAssetCachePath, verifyTreeSitterAssetCache } from "../src/tree-sitter-assets.build"
import { treeSitterAssetManifest } from "../src/tree-sitter-assets.manifest.generated"

type QuerySources = Record<string, readonly string[] | undefined>

function querySources(queries: object): (readonly string[] | undefined)[] {
  return Object.values(queries as QuerySources)
}

// The opentui client forwards only the wasm module, highlight queries, and injection queries to its
// worker (see resolveFiletypeParser in @opentui/core); every other query kind is dead config.
function configAssetUrls() {
  const urls: string[] = []
  for (const parser of parsers.parsers) {
    urls.push(parser.wasm)
    urls.push(...parser.queries.highlights)
    urls.push(...(parser.queries.injections ?? []))
  }
  return urls
}

function manifestSize(name: string) {
  const asset = treeSitterAssetManifest.find((entry) => entry.name === name)
  if (!asset) throw new Error(`unknown asset ${name}`)
  return asset.size
}

async function withTempDir(run: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-tree-sitter-assets-"))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withThrowingFetch(run: () => void) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = Object.assign(
    () => {
      calls += 1
      throw new Error("network access attempted")
    },
    { preconnect: original.preconnect },
  )
  try {
    run()
  } finally {
    globalThis.fetch = original
  }
  return calls
}

describe("tree-sitter asset manifest", () => {
  test("covers every asset URL declared in parsers-config", () => {
    expect(treeSitterAssetManifest.map((asset) => asset.source).toSorted()).toEqual(configAssetUrls().toSorted())
  })

  test("declares unique names and well formed digests", () => {
    const names = treeSitterAssetManifest.map((asset) => asset.name)
    const digests = treeSitterAssetManifest.map((asset) => asset.sha256)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(digests).size).toBe(digests.length)
    for (const asset of treeSitterAssetManifest) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.size).toBeGreaterThan(0)
      expect(asset.name).toContain(asset.sha256.slice(0, 12))
    }
  })

  test("pins every fetch URL to an immutable ref", () => {
    for (const asset of treeSitterAssetManifest) {
      expect(asset.url).not.toContain("/refs/heads/")
      expect(asset.url).not.toMatch(/\/(master|main)\//)
      expect(asset.url).not.toContain("/latest/")
    }
  })
})

describe("materializeTreeSitterAssets", () => {
  test("writes every bundled asset under the target directory", async () => {
    await withTempDir((dir) => {
      const written = materializeTreeSitterAssets(dir, (name) => Buffer.from(`bytes:${name}`))
      expect(written).toBe(treeSitterAssetManifest.length)
      for (const asset of treeSitterAssetManifest) {
        expect(readFileSync(path.join(dir, asset.name), "utf8")).toBe(`bytes:${asset.name}`)
      }
    })
  })

  test("leaves already materialized assets untouched", async () => {
    await withTempDir((dir) => {
      materializeTreeSitterAssets(dir, (name) => Buffer.alloc(manifestSize(name)))
      const written = materializeTreeSitterAssets(dir, () => {
        throw new Error("materialized assets must not be loaded again")
      })
      expect(written).toBe(0)
    })
  })

  test("fails without fetching when an asset is missing from the bundle", async () => {
    await withTempDir((dir) => {
      const missing = treeSitterAssetManifest[0]?.name
      if (!missing) throw new Error("manifest is empty")
      const calls = withThrowingFetch(() => {
        expect(() =>
          materializeTreeSitterAssets(dir, (name) => {
            if (name === missing) throw new Error(`not bundled: ${name}`)
            return Buffer.from(`bytes:${name}`)
          }),
        ).toThrow(`not bundled: ${missing}`)
      })
      expect(calls).toBe(0)
      expect(existsSync(path.join(dir, missing))).toBe(false)
    })
  })

  test("replaces a partial write instead of trusting it", async () => {
    await withTempDir((dir) => {
      const asset = treeSitterAssetManifest[0]
      if (!asset) throw new Error("manifest is empty")
      mkdirSync(path.dirname(path.join(dir, asset.name)), { recursive: true })
      writeFileSync(path.join(dir, asset.name), "partial")
      materializeTreeSitterAssets(dir, (name) => Buffer.from(`bytes:${name}`))
      expect(readFileSync(path.join(dir, asset.name), "utf8")).toBe(`bytes:${asset.name}`)
    })
  })
})

describe("verifyTreeSitterAssetCache", () => {
  const queryAsset = treeSitterAssetManifest.find((asset) => asset.name.endsWith(".scm"))
  const bytes = Buffer.from("(identifier) @variable\n")
  const digest = createHash("sha256").update(bytes).digest("hex")

  test("accepts fetched bytes that match the manifest digest", async () => {
    if (!queryAsset) throw new Error("manifest has no query asset")
    await withTempDir(async (dir) => {
      const forged = { ...queryAsset, sha256: digest, size: bytes.byteLength }
      let calls = 0
      await verifyTreeSitterAssetCache([forged], async () => {
        calls += 1
        return new Response(bytes)
      }, dir)
      expect(calls).toBe(1)
      expect(readFileSync(treeSitterAssetCachePath(forged, dir))).toEqual(bytes)
    })
  })

  test("does not touch the network when the cache matches the manifest", async () => {
    if (!queryAsset) throw new Error("manifest has no query asset")
    await withTempDir(async (dir) => {
      const forged = { ...queryAsset, sha256: digest, size: bytes.byteLength }
      const cached = treeSitterAssetCachePath(forged, dir)
      mkdirSync(path.dirname(cached), { recursive: true })
      writeFileSync(cached, bytes)
      await verifyTreeSitterAssetCache([forged], () => {
        throw new Error("network access attempted")
      }, dir)
      expect(readFileSync(cached)).toEqual(bytes)
    })
  })

  test("fails loudly when the fetched bytes do not match the manifest digest", async () => {
    if (!queryAsset) throw new Error("manifest has no query asset")
    await withTempDir(async (dir) => {
      const forged = { ...queryAsset, sha256: "0".repeat(64) }
      await expect(verifyTreeSitterAssetCache([forged], async () => new Response(bytes), dir)).rejects.toThrow(
        "failed its sha256 check",
      )
      expect(existsSync(treeSitterAssetCachePath(forged, dir))).toBe(false)
    })
  })

  test("fails loudly when the pinned URL cannot be fetched", async () => {
    if (!queryAsset) throw new Error("manifest has no query asset")
    await withTempDir(async (dir) => {
      await expect(
        verifyTreeSitterAssetCache([queryAsset], async () => new Response("", { status: 503, statusText: "down" }), dir),
      ).rejects.toThrow("Failed to fetch")
    })
  })

  test("names the pinned URL when the fetch itself fails", async () => {
    if (!queryAsset) throw new Error("manifest has no query asset")
    await withTempDir(async (dir) => {
      await expect(
        verifyTreeSitterAssetCache([queryAsset], () => Promise.reject(new Error("boom")), dir),
      ).rejects.toThrow(`Failed to fetch ${queryAsset.url}: boom`)
    })
  })
})

describe("resolveTreeSitterParsers", () => {
  test("rewrites every source to a local path under the asset directory", () => {
    const dir = path.join(tmpdir(), "opencode-tree-sitter-resolve")
    const resolved = resolveTreeSitterParsers(parsers.parsers, dir)
    expect(resolved.length).toBe(parsers.parsers.length)
    for (const parser of resolved) {
      expect(path.isAbsolute(parser.wasm)).toBe(true)
      expect(parser.wasm.startsWith(dir + path.sep)).toBe(true)
      for (const sources of querySources(parser.queries)) {
        for (const source of sources ?? []) {
          expect(path.isAbsolute(source)).toBe(true)
          expect(source.startsWith(dir + path.sep)).toBe(true)
        }
      }
    }
  })

  test("preserves parser metadata", () => {
    const dir = path.join(tmpdir(), "opencode-tree-sitter-resolve")
    const resolved = resolveTreeSitterParsers(parsers.parsers, dir)
    const diff = resolved.find((parser) => parser.filetype === "diff")
    const html = resolved.find((parser) => parser.filetype === "html")
    const lua = resolved.find((parser) => parser.filetype === "lua")
    expect(diff?.aliases).toEqual(["udiff", "patch"])
    expect(html?.queries.injections?.length).toBe(1)
    expect(lua?.queries.highlights.length).toBe(1)
    // lua declares a `locals` query, which the client never forwards, so the resolver drops it.
    expect(Object.keys(lua?.queries ?? {}).toSorted()).toEqual(["highlights"])
  })

  test("rejects a parser whose asset is not bundled", () => {
    expect(() =>
      resolveTreeSitterParsers(
        [
          {
            filetype: "unbundled",
            wasm: "https://example.invalid/tree-sitter-unbundled.wasm",
            queries: { highlights: [] },
          },
        ],
        path.join(tmpdir(), "opencode-tree-sitter-resolve"),
      ),
    ).toThrow("tree-sitter-unbundled.wasm")
  })

  test("resolves without touching the network", () => {
    const calls = withThrowingFetch(() => {
      resolveTreeSitterParsers(parsers.parsers, path.join(tmpdir(), "opencode-tree-sitter-resolve"))
    })
    expect(calls).toBe(0)
  })
})
