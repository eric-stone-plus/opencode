export * as WorkingContext from "./working-context.js"

// The working-context policy ported from the V1 fork (packages/opencode's
// session/overflow.ts): a model's advertised context is an upper bound, not a
// working set. Claude/Codex-sized windows are the practical unit of work, so
// every model compacts around WORKING_CONTEXT_CAP unless its config names a
// larger cap — a 1M-token model that never compacts until ~900k pays latency
// and cost for a window its providers cannot answer reliably.
//
// The same policy lives in V2 at SessionCompaction's ceiling calculation
// (packages/core/src/session/compaction.ts) and is derived onto Resolved by
// the model resolver, so the due check and the compaction request aim at the
// same window.

/** A Claude/Codex-sized working window. Advertised 1M contexts still compact here. */
export const WORKING_CONTEXT_CAP = 256_000

/**
 * The per-model opt-out of the conservative default clamp, from
 * `model.options.workingContextCap` (merged from config model blocks; the
 * provider-request filter strips it so it never rides a model request body).
 * Only safe integers strictly above the V1 compaction reserve count: a cap at
 * or below the reserve would collapse the usable window to zero and compact on
 * every step, and booleans coerce via Number(). Anything else keeps the
 * default clamp. Never above the model's real input budget — the consumer
 * takes `Math.min` with the window.
 */
export function workingContextCap(settings: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const override = settings?.workingContextCap
  if (typeof override === "number" && Number.isSafeInteger(override) && override > 20_000) return override
  return undefined
}

/**
 * The window the ceiling calculation works from: the input limit when present
 * (`limit.input || limit.context`), clamped to the working-context cap. A cap
 * above the window is a no-op, so a pin can only ever raise the default clamp
 * up to the model's own budget, never past it.
 */
export function window(limit: { readonly context: number; readonly input?: number }, cap?: number): number {
  const real = limit.input || limit.context
  if (real <= 0) return real
  return Math.min(real, cap ?? WORKING_CONTEXT_CAP)
}
