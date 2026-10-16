#!/usr/bin/env bun

import path from "node:path"
import {
  generateTreeSitterAssets,
  verifyTreeSitterAssetCache,
  verifyTreeSitterAssetPlan,
} from "../../tui/src/tree-sitter-assets.build"

/**
 * Build entry point: proves the committed manifest still matches parsers-config.ts, that every
 * cached asset matches its recorded digest, and that the generated bundle lists every asset.
 * Missing or tampered cache entries are re-fetched from the pinned URLs; a digest mismatch that
 * survives the re-fetch fails the build.
 */
export async function ensureTreeSitterAssetsForBuild() {
  const [{ treeSitterAssetManifest }, { treeSitterAssetBundledFiles }] = await Promise.all([
    import("../../tui/src/tree-sitter-assets.manifest.generated"),
    import("../../tui/src/tree-sitter-assets.files.generated"),
  ])
  verifyTreeSitterAssetPlan(treeSitterAssetManifest)
  await verifyTreeSitterAssetCache(treeSitterAssetManifest)
  if (treeSitterAssetBundledFiles.length !== treeSitterAssetManifest.length) {
    throw new Error("The bundled tree-sitter asset list is out of date; run packages/cli/script/tree-sitter-assets.ts")
  }
  for (const [index, asset] of treeSitterAssetManifest.entries()) {
    const bundled = treeSitterAssetBundledFiles[index]
    if (bundled === undefined || path.basename(bundled) !== path.basename(asset.name)) {
      throw new Error(`The bundled tree-sitter asset for ${asset.source} is out of date; run packages/cli/script/tree-sitter-assets.ts`)
    }
  }
}

if (import.meta.main) {
  const summary = await generateTreeSitterAssets({ refresh: process.argv.includes("--refresh") })
  await ensureTreeSitterAssetsForBuild()
  console.log(`tree-sitter assets: ${summary.assets} assets (${summary.fetched} fetched, ${summary.reused} reused)`)
}
