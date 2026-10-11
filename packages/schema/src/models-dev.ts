export * as ModelsDev from "./models-dev"

import { define, inventory } from "./event"

const Refreshed = define({
  type: "models-dev.refreshed",
  schema: {},
})
export const Event = { Refreshed, Definitions: inventory(Refreshed) }

// This fork supports four vendors only (Alibaba, DeepSeek, Zhipu incl. Z.ai, Xiaomi MiMo; ADR 0005).
// Every other registry provider is dropped wherever the registry is loaded, written or embedded.
export function restrict<T>(registry: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(registry).filter(([providerID]) => /^(alibaba|deepseek|zhipuai|zai|xiaomi)(-|$)/.test(providerID)),
  )
}
