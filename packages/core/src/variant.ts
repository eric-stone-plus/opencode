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
