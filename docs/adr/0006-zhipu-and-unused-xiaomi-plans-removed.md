# Zhipu/Z.AI and the unused Xiaomi plans are removed

ADR 0005's third vendor, Zhipu (incl. Z.ai), is deleted from source, and the Xiaomi family is cut to the one token plan that has a configured key (`xiaomi-token-plan-cn`). The supported registry set is now Alibaba, DeepSeek and that one plan; `ModelsDev.restrict` is `^(alibaba|deepseek)(-|$)|^xiaomi-token-plan-cn$`.

Deleted, not disabled — the same policy as ADR 0005, and the same consequence (every `sync-upstream` conflicts on the deleted files; resolve with `git rm`):

- **Registry**: the embedded snapshot drops `zai`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan`, `xiaomi`, `xiaomi-token-plan-ams` and `xiaomi-token-plan-sgp` (15 → 6 alibaba rows + deepseek + `xiaomi-token-plan-cn`). Refresh with `bun run packages/core/script/update-models-snapshot.ts`.
- **`packages/ai`**: the `zai`/`zai-coding-plan` provider facades and their `chat`/`messages` entrypoints, the `zai-chat`/`zai-messages` protocols, the `zaiToolStream` compatibility option and the `tool_stream` body field it gated, the Z.ai branches of `detectMaxTokensField`/`detectSupportsStore`, and the fork-added `zhipuOverflowCode` (numeric 1261). Provider tests (`zai.test.ts`, both recorded suites), the `zai-chat`/`zai-images` recordings and the `zai-coding-messages` cache-policy entry went with them.
- **`packages/core`**: `zaiChat`/`zaiMessages` variants and their protocol entries, the `aisdk-native` host rows, the provider loader entries, and the `glm` id check in the Alibaba effort sets (Alibaba's hosted-model vocabulary keeps `deepseek`).
- **`packages/cli`**: the build-time snapshot marker moves from `"zhipuai"` to `"xiaomi-token-plan-cn"`, and the auth-purge fixtures use kept providers.
- **Docs/tests**: the Z.AI section in `packages/ai/README.md`, the AGENTS.md examples, and the TUI /usage display fixtures.

Kept deliberately: the shared error-classifier vocabulary in `packages/ai/src/provider-error.ts` (generic text patterns such as `prompt too long`, the plan/quota phrases, the `permission_denied` code). It classifies incoming failures for any provider and ADR 0005's sweep kept the same vocabulary for every other removed vendor (Azure, OpenRouter, Cohere, …); removing it would be transport churn, not vendor removal. The stats and console apps keep their public-site vendor lists for the same reason: they were never part of the support surface. The provider-icon registry (`packages/ui/src/components/provider-icons/types.ts`) keeps its rows for the removed vendors too: it is an asset lookup keyed by whatever a stored session or snapshot names, so pruning it belongs to a later asset sweep, not to this removal.

Consequences:

- The Xiaomi token plan's rows declare zero cost and resolve their price through `canonical_model_id: xiaomi/…`; with `xiaomi` gone the fork pricing cascade has no priced row to vote on, so plan models read `$0`/unpriced. That is the plan's own declared data — restore pricing by re-adding a priced anchor row, not by re-adding the provider.
- Widening the set later means editing the regex and restoring code from history (`git log --diff-filter=D -- packages/ai/src/providers/zai.ts`).
