import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The Node build stages the same files under its asset root (`tree-sitter/<name>`); running from
// source falls back to the gitignored build cache, which mirrors the runtime layout.
const fallbackRoot = fileURLToPath(new URL("../../cli/.cache/tree-sitter", import.meta.url))

export function loadTreeSitterAsset(name: string): Uint8Array {
  const root = process.env.OPENCODE_NODE_ASSETS_DIR
  return readFileSync(root ? path.join(root, "tree-sitter", name) : path.join(fallbackRoot, name))
}
