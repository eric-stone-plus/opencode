// Model-variant persistence shared by the TUI composer and `opencode run`.
//
// Variants are provider-specific reasoning effort levels stored per scope and
// per `provider/model`. The scope key is a session id, or DRAFT_SCOPE for a
// composer that has not created a session yet. The on-disk store predates
// session scoping: a flat `provider/model -> variant` map migrates into the
// draft bucket, which is the composer it came from. Bucket contents merge so
// the result does not depend on JSON key order (a file can contain both shapes
// after a mixed-version run); non-string leaves are dropped so a malformed
// entry cannot survive a rewrite; keys that could reach Object.prototype are
// ignored.

export const DRAFT_SCOPE = ""

export type VariantStore = Record<string, Record<string, string | undefined>>

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

export function normalizeVariantStore(value: unknown): VariantStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: VariantStore = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue
    if (typeof entry === "string") {
      result[DRAFT_SCOPE] = { ...(result[DRAFT_SCOPE] ?? {}), [key]: entry }
      continue
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const variants = Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).filter(([, item]) => typeof item === "string"),
    ) as Record<string, string>
    if (Object.keys(variants).length > 0) result[key] = { ...(result[key] ?? {}), ...variants }
  }
  return result
}

// Semantic effort ranking for known ladder names. Variant maps are built in
// ascending tier order by the provider ladders (transform.ts), but
// config-declared maps and persisted lists may come in any order — rank by
// name first. "default" is groq's upper tier ("none" | "default"); "thinking"
// is minimax-m3's enabled tier ("none" = disabled, "thinking" = adaptive).
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  default: 1,
  minimal: 1,
  low: 2,
  medium: 3,
  mid: 3,
  high: 4,
  thinking: 4.5,
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
export function topVariant(variants: readonly string[]): string | undefined {
  if (variants.length === 0) return undefined
  if (variants.some((name) => EFFORT_RANK[name] === undefined)) return variants[variants.length - 1]
  let best = variants[0]
  for (const name of variants.slice(1)) {
    if (EFFORT_RANK[name]! > EFFORT_RANK[best]!) best = name
  }
  return best
}

/**
 * Cycle to the next variant, wrapping to the first step. There is no
 * "default" stop: an unset variant resolves to the ladder top (topVariant),
 * and a stale current restarts at the first step.
 */
export function cycleVariant(current: string | undefined, variants: string[]): string | undefined {
  if (variants.length === 0) return undefined
  if (!current) return variants[0]
  const idx = variants.indexOf(current)
  if (idx === -1 || idx === variants.length - 1) return variants[0]
  return variants[idx + 1]
}
