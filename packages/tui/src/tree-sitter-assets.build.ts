import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import parsers from "./parsers-config"
import type { TreeSitterAsset } from "./tree-sitter-assets"
import { errorMessage } from "./util/error"

/**
 * Build-time only: never imported by the TUI runtime. It pins, fetches, and verifies the parser
 * assets declared in parsers-config.ts, then writes the two generated source files the runtime and
 * the compiled binary consume. The build cache mirrors the runtime layout, so a cached file name is
 * exactly the name the runtime materializes.
 */

/** Immutable commit for every repository whose query URLs still point at a mutable branch. */
const pinnedRefs: Record<string, string> = {
  // Refresh with: git ls-remote https://github.com/<owner>/<repo>.git HEAD
  // nvim-treesitter's default branch uses the new runtime/queries layout; the legacy queries/ paths
  // that parsers-config.ts declares live on the master branch.
  "nvim-treesitter/nvim-treesitter": "cf12346a3414fa1b06af75c79faebe7f76df080a",
  "tree-sitter/tree-sitter-python": "26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64",
  "tree-sitter/tree-sitter-php": "58d5643086ae60e93a3746cca648363ee97c8761",
  "tree-sitter/tree-sitter-html": "73a3947324f6efddf9e17c0ea58d454843590cc0",
  "alex-pinkus/tree-sitter-swift": "9e3b87f66f1fd2f3b931376fd3723ab788e337c3",
}

/** The narrow slice of `fetch` the build needs, so callers can inject a stub. */
export type TreeSitterAssetFetcher = (url: string, init?: RequestInit) => Promise<Response>

export type TreeSitterAssetPlanItem = {
  readonly source: string
  readonly url: string
  readonly directory: "languages" | "queries"
  readonly stem: string
  readonly extension: ".wasm" | ".scm"
}

/** Where fetched bytes are cached between builds. Gitignored: the manifest, not the bytes, is committed. */
export function treeSitterAssetCacheDir() {
  return path.resolve(import.meta.dirname, "../../cli/.cache/tree-sitter")
}

export function treeSitterAssetCachePath(asset: Pick<TreeSitterAsset, "name">, dir = treeSitterAssetCacheDir()) {
  return path.join(dir, asset.name)
}

/** Rewrites a mutable branch ref to the pinned commit, normalizing github.com/raw URLs to raw.githubusercontent.com. */
export function pinTreeSitterAssetUrl(source: string) {
  const url = new URL(source)
  const segments = url.pathname.split("/").filter(Boolean)
  const rawHost = url.hostname === "raw.githubusercontent.com"
  const githubRaw = url.hostname === "github.com" && segments[2] === "raw"
  if (!rawHost && !githubRaw) return source
  const offset = githubRaw ? 3 : 2
  const owner = segments[0]
  const repo = segments[1]
  const refSegments = segments.slice(offset)
  const refOffset = refSegments[0] === "refs" && refSegments[1] === "heads" ? 2 : 0
  const ref = refSegments[refOffset]
  if (ref !== "master" && ref !== "main") return source
  const pinned = pinnedRefs[`${owner}/${repo}`]
  if (pinned === undefined) {
    throw new Error(`No pinned ref for ${owner}/${repo}; add one to pinnedRefs in tree-sitter-assets.build.ts`)
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${pinned}/${refSegments.slice(refOffset + 1).join("/")}`
}

/**
 * Every asset the opentui client forwards to its worker: the wasm module, the highlight queries,
 * and the injection queries. Query kinds the client drops (such as `locals`) are not bundled
 * because they can never be requested.
 */
export function treeSitterAssetPlan(): TreeSitterAssetPlanItem[] {
  const items: TreeSitterAssetPlanItem[] = []
  const seen = new Set<string>()
  const push = (
    source: string,
    directory: TreeSitterAssetPlanItem["directory"],
    stem: string,
    extension: TreeSitterAssetPlanItem["extension"],
  ) => {
    if (seen.has(source)) return
    seen.add(source)
    items.push({ source, url: pinTreeSitterAssetUrl(source), directory, stem, extension })
  }
  for (const parser of parsers.parsers) {
    push(parser.wasm, "languages", path.basename(new URL(parser.wasm).pathname, ".wasm"), ".wasm")
    const queries = [...parser.queries.highlights, ...(parser.queries.injections ?? [])]
    queries.forEach((source, index) => {
      push(source, "queries", `${parser.filetype}-${index}-${path.basename(new URL(source).pathname, ".scm")}`, ".scm")
    })
  }
  return items
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function assetName(item: TreeSitterAssetPlanItem, sha256: string) {
  return `${item.directory}/${item.stem}-${sha256.slice(0, 12)}${item.extension}`
}

function assertAssetBytes(item: TreeSitterAssetPlanItem, bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new Error(`Fetched ${item.url} is empty`)
  if (item.extension === ".wasm" && !(bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
    throw new Error(`Fetched ${item.url} is not a WebAssembly module`)
  }
  if (item.extension === ".scm") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`Fetched ${item.url} is not valid UTF-8`)
    }
  }
}

async function fetchTreeSitterAsset(item: TreeSitterAssetPlanItem, fetcher: TreeSitterAssetFetcher) {
  const response = await fetcher(item.url, { headers: { "user-agent": "opencode-tree-sitter-assets" } }).catch((error) => {
    throw new Error(`Failed to fetch ${item.url}: ${errorMessage(error)}`)
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${item.url}: ${response.status} ${response.statusText}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  assertAssetBytes(item, bytes)
  return bytes
}

function writeFileAtomically(file: string, bytes: Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

async function loadCommittedManifest(): Promise<readonly TreeSitterAsset[]> {
  try {
    const module = await import("./tree-sitter-assets.manifest.generated")
    return module.treeSitterAssetManifest
  } catch {
    return []
  }
}

function reusableBytes(previous: TreeSitterAsset | undefined, refresh: boolean) {
  if (refresh || previous === undefined) return undefined
  const cached = treeSitterAssetCachePath(previous)
  if (!existsSync(cached)) return undefined
  const bytes = readFileSync(cached)
  return digest(bytes) === previous.sha256 ? bytes : undefined
}

/**
 * Verifies the cached bytes for every manifest entry against the committed digest, re-fetching when
 * the cache is missing or tampered with. A digest mismatch that survives the re-fetch means the
 * pinned upstream changed: the build must fail rather than embed unexpected bytes.
 */
export async function verifyTreeSitterAssetCache(
  manifest: readonly TreeSitterAsset[],
  fetcher: TreeSitterAssetFetcher = fetch,
  dir = treeSitterAssetCacheDir(),
) {
  const plan = new Map(treeSitterAssetPlan().map((item) => [item.source, item]))
  for (const asset of manifest) {
    const item = plan.get(asset.source)
    if (item === undefined) {
      throw new Error(
        `Tree-sitter asset ${asset.source} is no longer declared in parsers-config.ts; run packages/cli/script/tree-sitter-assets.ts`,
      )
    }
    if (item.url !== asset.url) {
      throw new Error(
        `Tree-sitter asset ${asset.source} is pinned to ${item.url}, but the manifest records ${asset.url}; run packages/cli/script/tree-sitter-assets.ts`,
      )
    }
    const cached = treeSitterAssetCachePath(asset, dir)
    if (existsSync(cached) && digest(readFileSync(cached)) === asset.sha256) continue
    const bytes = await fetchTreeSitterAsset(item, fetcher)
    const sha256 = digest(bytes)
    if (sha256 !== asset.sha256) {
      throw new Error(
        `Tree-sitter asset ${asset.source} failed its sha256 check: the manifest expects ${asset.sha256}, upstream now serves ${sha256}. Verify the pinned ref and re-run packages/cli/script/tree-sitter-assets.ts`,
      )
    }
    writeFileAtomically(cached, bytes)
  }
}

export function verifyTreeSitterAssetPlan(manifest: readonly TreeSitterAsset[]) {
  const planned = treeSitterAssetPlan()
    .map((item) => item.source)
    .toSorted()
  const declared = manifest
    .map((asset) => asset.source)
    .toSorted()
  if (planned.join("\n") !== declared.join("\n")) {
    throw new Error("The tree-sitter asset manifest does not match parsers-config.ts; run packages/cli/script/tree-sitter-assets.ts")
  }
}

function writeIfChanged(file: string, content: string) {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return
  writeFileSync(file, content)
}

function generatedManifestSource(assets: readonly TreeSitterAsset[]) {
  const entries = assets.map((asset) =>
    [
      "  {",
      `    source: ${JSON.stringify(asset.source)},`,
      `    url: ${JSON.stringify(asset.url)},`,
      `    sha256: ${JSON.stringify(asset.sha256)},`,
      `    size: ${asset.size},`,
      `    name: ${JSON.stringify(asset.name)},`,
      "  },",
    ].join("\n"),
  )
  return [
    "// Generated by packages/cli/script/tree-sitter-assets.ts; do not edit by hand.",
    "// `source` is the URL parsers-config.ts declares, `url` is the immutable fetch location, and `name` is",
    "// the path materialized under the runtime asset directory, suffixed with the content digest prefix.",
    'import type { TreeSitterAsset } from "./tree-sitter-assets"',
    "",
    "export const treeSitterAssetManifest: readonly TreeSitterAsset[] = [",
    ...entries,
    "]",
    "",
  ].join("\n")
}

function generatedFilesSource(items: readonly { item: TreeSitterAssetPlanItem; asset: TreeSitterAsset }[]) {
  const imports = items.map(({ item, asset }, index) => {
    const specifier = path.relative(import.meta.dirname, treeSitterAssetCachePath(asset)).replaceAll("\\", "/")
    const identifier = `a${index.toString().padStart(3, "0")}`
    return `import ${identifier} from ${JSON.stringify(specifier)} with { type: "file" }`
  })
  const paths = items.map((_, index) => `  a${index.toString().padStart(3, "0")},`)
  return [
    '/// <reference path="./tree-sitter-asset-imports.d.ts" />',
    "// Generated by packages/cli/script/tree-sitter-assets.ts; do not edit by hand.",
    "// Bundled copies of treeSitterAssetManifest, in manifest order. The paths point at the gitignored",
    "// build cache; `bun build --compile` embeds the bytes into the executable.",
    ...imports,
    "",
    "export const treeSitterAssetBundledFiles: readonly string[] = [",
    ...paths,
    "]",
    "",
  ].join("\n")
}

/**
 * Fetches every planned asset that the committed manifest cannot vouch for and rewrites the
 * generated sources when they changed. A fetch whose digest differs from the committed manifest
 * fails the run unless `refresh` is set, so upstream drift is a deliberate act.
 */
export async function generateTreeSitterAssets(options: { refresh?: boolean; fetcher?: TreeSitterAssetFetcher } = {}) {
  const fetcher = options.fetcher ?? fetch
  const previousBySource = new Map((await loadCommittedManifest()).map((asset) => [asset.source, asset]))
  const generated: { item: TreeSitterAssetPlanItem; asset: TreeSitterAsset }[] = []
  let fetched = 0
  let reused = 0
  for (const item of treeSitterAssetPlan()) {
    const previous = previousBySource.get(item.source)
    const cached = reusableBytes(previous, options.refresh ?? false)
    const bytes = cached ?? (await fetchTreeSitterAsset(item, fetcher))
    const sha256 = digest(bytes)
    if (cached === undefined) {
      if (previous !== undefined && previous.sha256 !== sha256 && !options.refresh) {
        throw new Error(
          `Tree-sitter asset ${item.source} now hashes to ${sha256}, but the manifest records ${previous.sha256}. Re-run with --refresh to adopt the change`,
        )
      }
      writeFileAtomically(treeSitterAssetCachePath({ name: assetName(item, sha256) }), bytes)
      fetched += 1
    } else {
      reused += 1
    }
    generated.push({
      item,
      asset: { source: item.source, url: item.url, sha256, size: bytes.byteLength, name: assetName(item, sha256) },
    })
  }
  writeIfChanged(
    path.resolve(import.meta.dirname, "tree-sitter-assets.manifest.generated.ts"),
    generatedManifestSource(generated.map(({ asset }) => asset)),
  )
  writeIfChanged(
    path.resolve(import.meta.dirname, "tree-sitter-assets.files.generated.ts"),
    generatedFilesSource(generated),
  )
  return { assets: generated.length, fetched, reused }
}
