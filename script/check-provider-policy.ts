// Provider-policy guard (ADR 0003 / ADR 0006). The seat runs harness-only against Alibaba, DeepSeek and
// the one Xiaomi token plan in use: the models.dev registry is cut to those vendors wherever it is
// loaded, config declarations are exhaustive, and only the transports the endpoints need survive in the
// native mapping. Upstream touches provider code constantly, so this gate refuses a merge that silently
// widens the set - the policy is cheap to assert and expensive to notice by reading diffs.
//
// Usage:
//   bun run check-provider-policy
//
// Exit 1 when the vendor allowlist, the implicit-fetch default, the declared-only transform, or the
// transport mapping stops matching the policy.

import path from "node:path"
import { AISDKNative } from "../packages/core/src/aisdk-native"
import { ModelsDev } from "../packages/schema/src/models-dev"

// Vendors the fork keeps (ADR 0006 supersedes ADR 0005: Zhipu is gone, Xiaomi is cut to the token plan).
const KEPT = ["alibaba", "alibaba-coding-plan", "alibaba-coding-plan-cn", "alibaba-token-plan", "alibaba-token-plan-cn", "deepseek", "xiaomi-token-plan-cn"]
const DROPPED = ["openai", "anthropic", "google", "google-vertex", "openrouter", "zhipu", "zai", "xiaomi", "mimo", "qwen", "mistral", "xai", "groq", "cohere"]

// npm transports the three endpoints need (ADR 0005): the Alibaba/DeepSeek protocols plus Anthropic
// messages for the Bailian coding-plan endpoints.
const REQUIRED_TRANSPORTS: Array<[npm: string, providerID: string, expected: string]> = [
  ["@ai-sdk/alibaba", "alibaba", "@opencode/ai/providers/alibaba/chat"],
  ["@ai-sdk/openai-compatible", "alibaba", "@opencode/ai/providers/alibaba/chat"],
  ["@ai-sdk/anthropic", "alibaba", "@opencode/ai/providers/alibaba/messages"],
  ["@ai-sdk/openai-compatible", "deepseek", "@opencode/ai/providers/deepseek"],
]

// Transports that must stay unmapped: any of these resolving to a protocol would mean a removed vendor
// came back through the native mapping.
const BANNED_TRANSPORTS = [
  "@ai-sdk/openai",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/mistral",
  "@ai-sdk/xai",
  "@ai-sdk/groq",
  "@ai-sdk/cohere",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/azure",
  "@ai-sdk/cerebras",
  "@ai-sdk/deepseek",
  "@ai-sdk/fireworks",
  "@ai-sdk/togetherai",
  "@ai-sdk/perplexity",
  "@openrouter/ai-sdk-provider",
]

export async function checkProviderPolicy(root: string): Promise<string[]> {
  const problems: string[] = []

  const candidates = Object.fromEntries([...KEPT, ...DROPPED].map((id) => [id, {}]))
  const admitted = new Set(Object.keys(ModelsDev.restrict(candidates)))
  for (const id of KEPT) if (!admitted.has(id)) problems.push(`vendor allowlist drops supported provider ${id}`)
  for (const id of DROPPED) if (admitted.has(id)) problems.push(`vendor allowlist admits unsupported provider ${id}`)

  const modelsDev = await Bun.file(path.join(root, "packages/core/src/models-dev.ts")).text()
  if (!modelsDev.includes("ModelsDev.restrict("))
    problems.push("packages/core/src/models-dev.ts no longer funnels every source through ModelsDev.restrict")
  if (!modelsDev.includes("options?.fetch ?? false"))
    problems.push("packages/core/src/models-dev.ts no longer defaults implicit fetch to off")

  const declared = await Bun.file(path.join(root, "packages/core/src/plugin/fork/declared-providers.ts")).text()
  if (!declared.includes("providers.remove("))
    problems.push("declared-providers plugin no longer drops undeclared providers")
  if (declared.includes("providers.add("))
    problems.push("declared-providers plugin adds providers; ADR 0003 makes config declarations exhaustive")

  for (const [npm, providerID, expected] of REQUIRED_TRANSPORTS) {
    const mapped = AISDKNative.native(npm, { providerID })
    if (mapped !== expected)
      problems.push(`transport ${npm} + ${providerID} maps to ${mapped ?? "undefined"}, expected ${expected}`)
  }
  for (const npm of BANNED_TRANSPORTS)
    for (const providerID of ["openai", "anthropic", "alibaba", "deepseek", "xiaomi-token-plan-cn"]) {
      const mapped = AISDKNative.native(npm, { providerID })
      if (mapped !== undefined) problems.push(`transport ${npm} is mapped for ${providerID} -> ${mapped}`)
    }

  return problems
}

if (import.meta.main) {
  const problems = await checkProviderPolicy(path.resolve(import.meta.dirname, ".."))
  if (problems.length > 0) {
    console.error("provider policy failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      "\nThe vendor set is Alibaba, DeepSeek and xiaomi-token-plan-cn (ADR 0003 / ADR 0006)." +
        "\nWidening it is a deliberate decision: edit SUPPORTED in packages/schema/src/models-dev.ts," +
        "\nrestore the vendor code from history, and update this gate in the same commit.",
    )
    process.exit(1)
  }
  console.log(`provider policy: ok (${KEPT.length} allowed vendors; ${REQUIRED_TRANSPORTS.length} required transports)`)
}
