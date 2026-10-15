# DeepSeek is the only supported vendor

The operator's model track moved to DeepSeek-V4.1-Flash on 2026-10-07, and neither Alibaba nor the Xiaomi MiMo token plan has been used since. This ADR finishes the convergence ADR 0005 and ADR 0006 started: the supported registry set is DeepSeek alone, and every Alibaba/Xiaomi code path is deleted rather than disabled. `ModelsDev.restrict` is `^deepseek(-|$)`.

Deleted, not disabled — the same policy, and the same consequence, as ADR 0005/0006 (every `sync-upstream` conflicts on the deleted files; resolve with `git rm`, which the sync's DU step now does automatically — ADR 0002):

- **Registry**: `packages/core/src/models-dev/snapshot.txt` is filtered to the four `deepseek` rows (140 KB → 3.2 KB) and the build-time marker in `packages/cli/script/build-node.ts` is `"deepseek":{"id":"deepseek"`. Refresh with `bun run packages/core/script/update-models-snapshot.ts`.
- **`packages/ai`**: the `Alibaba` facade and its `chat`/`messages` entrypoints, the `alibaba-chat`/`alibaba-messages` protocols, the `@ai-sdk/alibaba` package row and host mapping, the Alibaba cache-policy route branch with its two inline-hint entries, and the Xiaomi/MiMo `requireThinkingSignature` shim in `anthropic-messages.ts`. Their tests, the `alibaba-chat`/`alibaba-messages` recordings and the four orphaned gateway cassettes went with them.
- **`packages/core`**: the `alibabaChat`/`alibabaMessages` variants and their `ROUTES` entries (with `ALIBABA_THINKING_BUDGET_MAX`), the provider loader's two `@opencode/ai/providers/alibaba/*` builtins, and the `aisdk-native` host rows.
- **Docs/tests**: the Alibaba section of `packages/ai/README.md`, the fork-scope line in `packages/ai/AGENTS.md`, and every fixture that named a removed vendor (`models-dev` fixtures, `declared-providers`, `credential-purge`, the pricing suites, the TUI usage/rate fixtures, the CLI auth-purge stub).

Kept deliberately:

- **The operator's config blocks.** `bailian-token-plan-personal` and `xiaomi-token-plan-cn` in `opencode.jsonc` declare their own `npm`, `baseURL`, models and options, so they keep working as config-declared providers (ADR 0003) — a registry row was never what made them executable. What they lose is registry-derived data: env-var discovery, `reasoning_options`-derived variant ladders, and the `canonical_model_id` pricing cascade (ADR 0006 already recorded that last consequence for the Xiaomi plan). Restore pricing by declaring `cost` on the model block or re-adding a priced anchor row; do not re-add the provider.
- **The dialect vocabulary.** `LanguageModelCacheFormatCompatibility` keeps the literal `"alibaba"`, and `cache-policy.ts` keeps its Qwen-family branch, exactly as `sanitizer: "gemini" | "moonshot"` and the provider-icon rows stay: these name a wire dialect, not a supported vendor, and a config-declared provider can still select them. The generated `ModelCacheFormat` union (`packages/client/src/promise/generated/types.ts`) follows the schema, so removing the literal would be transport churn plus a `check:generated` round-trip.
- **The shared error-classifier vocabulary** in `provider-error.ts`, and the stats/console public-site vendor lists, for the reasons ADR 0006 gives.

Consequences:

- `packages/core/test/models.test.ts` keeps its generic AI-SDK-package fallback coverage through a synthetic `deepseek-labs` registry row (it matches the allowlist predicate but has no host mapping), so the fallback path stays tested without a second vendor.
- `packages/core/test/fork/pricing.test.ts` pins the shipped catalog as DeepSeek-only. The zero-priced-subscription-row path it used to exercise through `alibaba-coding-plan` has no subject left in the shipped catalog and now lives in the synthetic `ForkPricing.match` suite, which covers the canonical chain directly.
- `packages/ai/test/cache-policy.test.ts` covers the Alibaba placement rules through the dialect knob (`cacheFormat: "alibaba"` on an OpenAI-compatible route) instead of through the deleted facade, so the Qwen breakpoint rules stay pinned without a vendor.
- Restoring a vendor means pulling it back from upstream (`git show upstream/dev:packages/ai/src/providers/alibaba.ts`), which is the route the operator named — not replaying this fork's history.
