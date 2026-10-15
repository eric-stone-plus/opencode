export * as ModelsDev from "./models-dev.js"

import { ephemeral, inventory } from "./event.js"

const Refreshed = ephemeral({
  type: "models-dev.refreshed",
  schema: {},
})
export const Event = { Refreshed, Definitions: inventory(Refreshed) }

// This fork supports DeepSeek only (ADR 0009, which supersedes ADR 0006's set).
// Every other registry provider is dropped wherever the registry is loaded, cached
// or embedded. Transports stay: Anthropic Messages and OpenAI Chat are kept for
// config-declared providers, which are never registry-gated.
const SUPPORTED = /^deepseek(-|$)/
export function restrict<T>(registry: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(registry).filter(([providerID]) => SUPPORTED.test(providerID)))
}
