import { DynamicProviderPlugin } from "./provider/dynamic.js"
import type { PluginInternal } from "./internal.js"

export const ProviderPlugins: PluginInternal.InternalPlugin[] = [DynamicProviderPlugin]
