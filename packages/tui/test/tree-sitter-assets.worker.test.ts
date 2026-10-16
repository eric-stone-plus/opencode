import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { TreeSitterClient } from "@opentui/core"
import parsers from "../src/parsers-config"
import { offlineTreeSitterParsers } from "../src/tree-sitter-assets.runtime"
import { treeSitterAssetManifest } from "../src/tree-sitter-assets.manifest.generated"

// Drives the real opentui worker through the same path the session view uses. A URL source with an
// empty cache makes the worker log "Downloading from URL" (verified separately), so the absence of
// that log while highlights still resolve is direct evidence that the bundled bytes were used.
test("bundled parsers load from disk without any download", async () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "opencode-tree-sitter-worker-"))
  const assetDir = path.join(dataPath, "tree-sitter-assets")
  const client = new TreeSitterClient({ dataPath })
  const logs: string[] = []
  client.on("worker:log", (_type, message) => logs.push(message))
  try {
    const python = parsers.parsers.find((parser) => parser.filetype === "python")
    if (!python) throw new Error("parsers-config.ts declares no python parser")
    const [resolved] = offlineTreeSitterParsers([python], assetDir)
    if (!resolved) throw new Error("offlineTreeSitterParsers returned no parser")
    await client.initialize()
    client.addFiletypeParser(resolved)
    const result = await client.highlightOnce("def double(x):\n    return x * 2\n", "python")
    expect(result.error).toBeUndefined()
    expect(result.highlights?.length ?? 0).toBeGreaterThan(0)
    expect(logs.some((line) => line.includes("Downloading from URL"))).toBe(false)
    expect(logs.some((line) => line.includes("Loading from local path") && line.includes("tree-sitter-python"))).toBe(true)
    expect(logs.some((line) => line.includes("Loading from local path") && line.includes("python-0-highlights"))).toBe(true)
  } finally {
    await client.destroy()
    rmSync(dataPath, { recursive: true, force: true })
  }
})

test("materializes the full asset set with the sizes the manifest records", () => {
  const dataPath = mkdtempSync(path.join(tmpdir(), "opencode-tree-sitter-materialize-"))
  const assetDir = path.join(dataPath, "tree-sitter-assets")
  try {
    offlineTreeSitterParsers([], assetDir)
    for (const asset of treeSitterAssetManifest) {
      const file = path.join(assetDir, asset.name)
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).size).toBe(asset.size)
    }
  } finally {
    rmSync(dataPath, { recursive: true, force: true })
  }
})
