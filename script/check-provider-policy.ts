// Provider-policy guard (ADR 0003 / ADR 0009). The seat runs harness-only against DeepSeek: the
// models.dev registry is cut to that vendor wherever it is loaded, config declarations are exhaustive,
// and only the transports the endpoints need survive in the native mapping. Upstream touches provider
// code constantly, so this gate refuses a merge that silently widens the set - the policy is cheap to
// assert and expensive to notice by reading diffs.
//
// Usage:
//   bun run check-provider-policy
//
// Exit 1 when the vendor allowlist, the implicit-fetch default, the declared-only transform, the
// transport mapping, or the removal itself stops matching the policy.

import { existsSync } from "node:fs"
import path from "node:path"
import { AISDKNative } from "../packages/core/src/aisdk-native"
import { ModelsDev } from "../packages/schema/src/models-dev"

// The vendor the fork keeps (ADR 0009 supersedes ADR 0005/0006: Alibaba, Zhipu and the Xiaomi plans are gone).
const KEPT = ["deepseek"]
// Every vendor this fork removed, plus the ids an upstream merge tends to bring back.
const DROPPED = [
  "alibaba",
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "alibaba-token-plan",
  "alibaba-token-plan-cn",
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "openrouter",
  "zhipu",
  "zai",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "mimo",
  "qwen",
  "mistral",
  "xai",
  "groq",
  "cohere",
]

// npm transports the seat needs (ADR 0005): the DeepSeek protocol bound to its registry row, plus the
// Anthropic Messages transport, which must stay resolvable for any config-declared provider. The probe
// id on the second row is a provider ADR 0010 removed on purpose: the mapping must not depend on which
// provider asks for the transport, and a removed id is the strongest probe for that.
const REQUIRED_TRANSPORTS: Array<[npm: string, providerID: string, expected: string]> = [
  ["@ai-sdk/openai-compatible", "deepseek", "@opencode/ai/providers/deepseek"],
  ["@ai-sdk/anthropic", "bailian-token-plan-personal", "@opencode/ai/providers/anthropic"],
]

// Transports that must stay unmapped: any of these resolving to a protocol would mean a removed vendor
// came back through the native mapping.
const BANNED_TRANSPORTS = [
  "@ai-sdk/alibaba",
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

// Provider ids the banned-transport loop probes with. Kept ids are deliberately absent: a removed
// transport may never resolve for a removed vendor, and the kept vendor is covered above.
const BANNED_PROVIDER_IDS = ["openai", "anthropic", "alibaba", "alibaba-coding-plan", "xiaomi-token-plan-cn", "mimo", "zai"]

// Files ADR 0009 deleted. A clean upstream merge brings them back one by one, and re-added vendor code
// is a wider support surface than a re-added registry row - the allowlist alone cannot see it. The
// list names the paths a merge would resurrect, not only the files that happened to exist at deletion
// time: upstream keeps growing this set (alibaba-responses landed after the 2026-10-15 sync, and a
// brand-new upstream file is added cleanly rather than raised as a delete/modify conflict).
const REMOVED_PATHS = [
  "packages/ai/src/providers/alibaba.ts",
  "packages/ai/src/providers/alibaba",
  "packages/ai/src/protocols/alibaba-chat.ts",
  "packages/ai/src/protocols/alibaba-messages.ts",
  "packages/ai/src/protocols/alibaba-responses.ts",
  "packages/ai/src/providers/zai.ts",
  "packages/ai/src/providers/zai",
  "packages/ai/src/providers/zai-coding-plan.ts",
  "packages/ai/src/providers/zai-coding-plan",
  "packages/ai/src/protocols/zai-chat.ts",
  "packages/ai/src/protocols/zai-messages.ts",
  // Cassettes are inert data: a merge restores a directory of them without breaking a build or a
  // test, so nothing else notices. They are listed for the same reason the source files are.
  "packages/ai/test/fixtures/recordings/alibaba-chat",
  "packages/ai/test/fixtures/recordings/alibaba-messages",
  "packages/ai/test/fixtures/recordings/alibaba-responses",
  "packages/ai/test/fixtures/recordings/zai-chat",
  "packages/ai/test/fixtures/recordings/zai-images",
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

  for (const removed of REMOVED_PATHS) {
    if (existsSync(path.join(root, removed))) problems.push(`${removed} exists again (ADR 0009 removed it)`)
  }

  for (const [npm, providerID, expected] of REQUIRED_TRANSPORTS) {
    const mapped = AISDKNative.native(npm, { providerID })
    if (mapped !== expected)
      problems.push(`transport ${npm} + ${providerID} maps to ${mapped ?? "undefined"}, expected ${expected}`)
  }
  for (const npm of BANNED_TRANSPORTS)
    for (const providerID of BANNED_PROVIDER_IDS) {
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
      "\nThe vendor set is DeepSeek alone (ADR 0003 / ADR 0009)." +
        "\nWidening it is a deliberate decision: edit SUPPORTED in packages/schema/src/models-dev.ts," +
        "\npull the vendor code back from upstream, and update this gate in the same commit.",
    )
    process.exit(1)
  }
  console.log(`provider policy: ok (${KEPT.length} allowed vendor; ${REQUIRED_TRANSPORTS.length} required transports)`)
}
