import path from "node:path"
import { getDataPaths, type FiletypeParserOptions } from "@opentui/core"
import { loadTreeSitterAsset } from "#tree-sitter-assets-embed"
import { materializeTreeSitterAssets, resolveTreeSitterParsers } from "./tree-sitter-assets"

/**
 * Materializes the build-time bundled parser assets and points every parser source at them, so the
 * tree-sitter worker reads local files instead of fetching the upstream URLs. The bytes ship inside
 * the executable: there is no network fallback here, and a missing asset fails loudly.
 */
export function offlineTreeSitterParsers(
  parsers: readonly FiletypeParserOptions[],
  dir = treeSitterAssetDir(),
): FiletypeParserOptions[] {
  materializeTreeSitterAssets(dir, loadTreeSitterAsset)
  return resolveTreeSitterParsers(parsers, dir)
}

function treeSitterAssetDir() {
  return path.join(getDataPaths().globalDataPath, "tree-sitter-assets")
}
