export * as ProjectTrust from "./project-trust.js"

import { realpathSync } from "fs"
import path from "path"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

/**
 * Declarative, stateless project trust.
 *
 * A directory is trusted only because the operator declared it: this module reads a declaration
 * (`Data`) and answers about a directory. It records nothing - no cache file, no database row, no
 * in-memory memo keyed by session or path - and it infers nothing: a line that is not an absolute
 * path is reported with a reason instead of being guessed at or expanded. The answer for a given
 * directory is a pure function of the declaration plus the filesystem's symlink reality, so it
 * cannot drift between sessions.
 *
 * Fail closed: absent data is `closed`, a path that cannot be resolved is never trusted, and an
 * absent service at a consumer means nothing is trusted (see `make`).
 */

/** A declaration: either everything is trusted, or an explicit list of roots. */
export type Data = { readonly all: boolean; readonly roots: ReadonlyArray<string> }

/** The empty declaration: nothing is trusted. */
export const closed: Data = { all: false, roots: [] }

/** One declaration line that was not admitted, and why. */
export type IgnoredLine = { readonly line: number; readonly reason: string }

const tildeReason = "tilde expansion is not supported"
const globReason = "glob patterns are not supported"
const relativeReason = "not an absolute path"
// A glob can never be an operator-declared root: matching a pattern would trust paths nobody named.
const glob = /[*?[\]{}]/

/**
 * Parses a declaration into roots. Pure: no filesystem access, no expansion, no guessing. One
 * absolute path per line; blank lines and `#` comments are skipped; anything relative, glob-shaped,
 * or `~`-prefixed is reported in `ignored` with its 1-based line number; duplicates are dropped
 * preserving first-occurrence order.
 */
export function parseRoots(text: string | undefined): { roots: string[]; ignored: IgnoredLine[] } {
  const roots: string[] = []
  const ignored: IgnoredLine[] = []
  if (text === undefined) return { roots, ignored }
  const seen = new Set<string>()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const record = (reason: string) => ignored.push({ line: index + 1, reason })
    if (line.startsWith("~")) {
      record(tildeReason)
      continue
    }
    if (glob.test(line)) {
      record(globReason)
      continue
    }
    if (!path.isAbsolute(line)) {
      record(relativeReason)
      continue
    }
    // Lexical cleanup only: normalize collapses `//`, `.` and trailing slashes without touching
    // symlinks. Symlink resolution belongs to the decision, where the filesystem is consulted.
    const normalized = stripTrailingSeparator(path.normalize(line))
    if (seen.has(normalized)) continue
    seen.add(normalized)
    roots.push(normalized)
  }
  return { roots, ignored }
}

/** `/a/b/` and `/a/b` are the same directory; keep a bare root (`/`, `C:\`) as the parser spelled it. */
function stripTrailingSeparator(value: string): string {
  if (value.length <= 1) return value
  const root = path.parse(value).root
  return value.length > root.length ? value.replace(/[/\\]+$/, "") : value
}

/**
 * Canonical form of a path for the trust decision: symlinks resolved and `..`/`.` collapsed.
 * A path that cannot be resolved is never trusted (fail closed): this returns `undefined` for any
 * failure other than nonexistence, and every predicate that sees `undefined` answers "no". A path
 * that does not exist has no symlinks to resolve, so it falls back to its lexical absolute form.
 */
function canonicalize(input: string): string | undefined {
  const resolved = path.resolve(input)
  try {
    return realpathSync.native(resolved)
  } catch (cause) {
    const code = errorCode(cause)
    if (code === "ENOENT" || code === "ENOTDIR") return resolved
    return undefined
  }
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
  return typeof cause.code === "string" ? cause.code : undefined
}

/** Containment at a path-component boundary: `/a/b` covers `/a/b/c` and itself, never `/a/bc`. */
function contains(root: string, directory: string): boolean {
  const relative = path.relative(root, directory)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
}

/**
 * Whether the declaration trusts `directory`. Both sides are canonicalized, so a symlink cannot
 * smuggle a path in or out of a root: the decision follows the real location.
 */
export function allows(data: Data, directory: string): boolean {
  if (data.all) return true
  const target = canonicalize(directory)
  if (target === undefined) return false
  return data.roots.some((root) => {
    const canonical = canonicalize(root)
    return canonical !== undefined && contains(canonical, target)
  })
}

/**
 * The longest matching root, so a nested declaration wins deterministically, or `undefined` when
 * the directory is not trusted (or the declaration is `all`, which names no root). Canonical form
 * is returned: callers can use it as a walk boundary.
 */
export function nearestRoot(data: Data, directory: string): string | undefined {
  if (data.all) return undefined
  const target = canonicalize(directory)
  if (target === undefined) return undefined
  let nearest: string | undefined
  for (const root of data.roots) {
    const canonical = canonicalize(root)
    if (canonical === undefined || !contains(canonical, target)) continue
    if (nearest === undefined || canonical.length > nearest.length) nearest = canonical
  }
  return nearest
}

/** The per-directory question consumers ask; a value, not a service, so it can be a fallback. */
export interface Interface {
  readonly data: Data
  readonly allows: (directory: string) => boolean
  readonly nearestRoot: (directory: string) => string | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectTrust") {}

/** The service value for a declaration; `make()` is closed, which is also the absent-service answer. */
export const make = (data: Data = closed): Interface => {
  // Frozen: a plugin or any other in-process consumer that reaches the service must not be able to
  // widen the declaration at run time. Trust is a startup fact (the host sets it), not mutable state.
  const declaration: Data = Object.freeze({ all: data.all, roots: Object.freeze([...data.roots]) })
  return {
    data: declaration,
    allows: (directory) => allows(declaration, directory),
    nearestRoot: (directory) => nearestRoot(declaration, directory),
  }
}

/** An absent declaration (or an absent `data` argument) provides the closed service. */
export const layer = (data?: Data) => Layer.succeed(Service, make(data))

export const node = makeGlobalNode({ service: Service, layer: layer(), deps: [] })
