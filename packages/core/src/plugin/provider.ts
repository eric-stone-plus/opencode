import { AlibabaPlugin } from "./provider/alibaba"
import { AnthropicPlugin } from "./provider/anthropic"
import { DynamicProviderPlugin } from "./provider/dynamic"
import { OpenAICompatiblePlugin } from "./provider/openai-compatible"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  AlibabaPlugin,
  AnthropicPlugin,
  OpenAICompatiblePlugin,
  DynamicProviderPlugin,
]
