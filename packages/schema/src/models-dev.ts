export * as ModelsDev from "./models-dev.js"

import { ephemeral, inventory } from "./event.js"

const Refreshed = ephemeral({
  type: "models-dev.refreshed",
  schema: {},
})
export const Event = { Refreshed, Definitions: inventory(Refreshed) }

// This fork supports Alibaba and DeepSeek plus the one Xiaomi token plan in use
// (ADR 0006; the vendor list supersedes ADR 0005). Every other registry provider is
// dropped wherever the registry is loaded, cached or embedded.
const SUPPORTED = /^(alibaba|deepseek)(-|$)|^xiaomi-token-plan-cn$/
export function restrict<T>(registry: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(registry).filter(([providerID]) => SUPPORTED.test(providerID)))
}
