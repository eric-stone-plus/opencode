import { readFileSync } from "node:fs"
import { treeSitterAssetManifest } from "./tree-sitter-assets.manifest.generated"
import { treeSitterAssetBundledFiles } from "./tree-sitter-assets.files.generated"

if (treeSitterAssetBundledFiles.length !== treeSitterAssetManifest.length) {
  throw new Error("Bundled tree-sitter assets are out of date; run packages/cli/script/tree-sitter-assets.ts")
}

/**
 * Reads one bundled asset. In a compiled executable the generated imports resolve to the bytes
 * embedded at build time; running from source they resolve to the gitignored build cache.
 */
export function loadTreeSitterAsset(name: string): Uint8Array {
  const index = treeSitterAssetManifest.findIndex((asset) => asset.name === name)
  const file = index === -1 ? undefined : treeSitterAssetBundledFiles[index]
  if (file === undefined) {
    throw new Error(`Tree-sitter asset ${name} is not bundled; run packages/cli/script/tree-sitter-assets.ts`)
  }
  return readFileSync(file)
}
