import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
/** Claude/Codex-sized working window. 1M advertised contexts still compact here. */
export const WORKING_CONTEXT_CAP = 256_000

function workingWindow(model: Provider.Model) {
  const context = model.limit.context
  if (context === 0) return 0
  const input = model.limit.input
  const window = input && input > 0 ? Math.min(context, input) : context
  // Per-model opt-out of the conservative default clamp via
  // `model.options.workingContextCap` (merged from config model blocks;
  // stripped again in ProviderTransform.providerOptions so it never rides
  // the request body). Never above the model's real input budget: Math.min
  // with `window` keeps a typo-sized cap honest. Only safe integers strictly
  // above the compaction reserve count — booleans coerce via Number(), and a
  // cap at/below the reserve collapses usable() to 0, which would compact on
  // every step. Anything else keeps the default clamp. Note the reserve can
  // be raised above COMPACTION_BUFFER via `compaction.reserved`; a cap below
  // that configured reserve is still a config error.
  const override = model.options?.workingContextCap
  if (typeof override === "number" && Number.isSafeInteger(override) && override > COMPACTION_BUFFER) {
    return Math.min(window, override)
  }
  return Math.min(window, WORKING_CONTEXT_CAP)
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = workingWindow(input.model)
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, context - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total ||
    input.tokens.input +
      input.tokens.output +
      input.tokens.reasoning +
      input.tokens.cache.read +
      input.tokens.cache.write
  return count >= usable(input)
}
