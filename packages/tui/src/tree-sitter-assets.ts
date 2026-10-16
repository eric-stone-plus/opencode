import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { FiletypeParserOptions } from "@opentui/core"
import { treeSitterAssetManifest } from "./tree-sitter-assets.manifest.generated"

export { treeSitterAssetManifest }

/** One pinned parser asset: the config URL it replaces, the immutable fetch URL, its digest, and its materialized name. */
export type TreeSitterAsset = {
  readonly source: string
  readonly url: string
  readonly sha256: string
  readonly size: number
  readonly name: string
}

const assetNameBySource = new Map(treeSitterAssetManifest.map((asset) => [asset.source, asset.name]))

function localAssetPath(source: string, dir: string) {
  const name = assetNameBySource.get(source)
  if (name === undefined) {
    throw new Error(
      `No bundled tree-sitter asset for ${source}; add it to the manifest and run packages/cli/script/tree-sitter-assets.ts`,
    )
  }
  return path.join(dir, name)
}

/**
 * Writes every bundled asset under `dir` and returns how many files were written.
 * Existing files with the expected size are kept: names carry the content digest prefix, so an
 * existing file is already the right content. A missing bundled asset throws instead of falling
 * back to the network, which keeps the runtime fail-closed.
 */
export function materializeTreeSitterAssets(dir: string, load: (name: string) => Uint8Array) {
  let written = 0
  for (const asset of treeSitterAssetManifest) {
    const target = path.join(dir, asset.name)
    if (existsSync(target) && statSync(target).size === asset.size) continue
    mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, load(asset.name))
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    written += 1
  }
  return written
}

/**
 * Rewrites every parser source the opentui client forwards to its worker (the wasm module, the
 * highlight queries, and the injection queries) to a path under `dir`. Query kinds the client drops
 * before it reaches the worker (such as `locals`) are dropped here as well, so no upstream URL
 * survives into the shipped configuration.
 */
export function resolveTreeSitterParsers(
  parsers: readonly FiletypeParserOptions[],
  dir: string,
): FiletypeParserOptions[] {
  return parsers.map((parser) => ({
    ...parser,
    wasm: localAssetPath(parser.wasm, dir),
    queries: {
      highlights: parser.queries.highlights.map((source) => localAssetPath(source, dir)),
      ...(parser.queries.injections
        ? { injections: parser.queries.injections.map((source) => localAssetPath(source, dir)) }
        : {}),
    },
  }))
}
