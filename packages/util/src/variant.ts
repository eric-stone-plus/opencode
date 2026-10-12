export * as VariantRank from "./variant.js"

// Reasoning-effort ladder ranking, shared by the server's variant resolution
// (packages/core/src/variant.ts) and the TUI's model picker
// (packages/tui/src/context/local.tsx), so the effort a request runs with and
// the effort the footer shows can never disagree.
//
// Ported from the V1 fork (packages/opencode's core/variant.ts, 2026-10-10):
// with nothing explicitly selected, the default is the ladder's top rung —
// effort must never fall to the provider's "default" by omission.

const EFFORT_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  mid: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/**
 * The highest reasoning-effort entry of a variant ladder — the default when
 * nothing is explicitly selected, so effort never falls to the provider's
 * "default" by omission. Every name known → highest rank wins (first wins
 * ties). Any unknown name → the name carries no semantics we trust, so take
 * the ladder's own order (last entry). Empty ladder → undefined.
 */
export function topVariant<T extends string>(variants: readonly T[]): T | undefined {
  if (variants.length === 0) return undefined
  if (variants.some((name) => EFFORT_RANK[name] === undefined)) return variants[variants.length - 1]
  let best = variants[0]
  for (const name of variants.slice(1)) {
    if (EFFORT_RANK[name]! > EFFORT_RANK[best]!) best = name
  }
  return best
}
