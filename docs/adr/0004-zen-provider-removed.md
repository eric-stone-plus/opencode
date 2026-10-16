# The OpenCode Zen provider stays removed

Upstream routes requests through the OpenCode Zen gateway (per-provider `x-opencode-*` headers, `opencodeProjectID`) and ships Zen free models; this fork runs harness-only against personal providers. The Zen provider branch stays deleted — that deletion is what makes merges conflict in `session/llm/request.ts`; `session/message-v2.ts` conflicts come from the fork's media overlay, not from Zen. Resolve `request.ts` by keeping upstream's generic identity headers plus the fork's flat headers and dropping the Zen branch; `rerere` records the resolutions for the next merge.

**V2 (2026-10-12).** In the V2 tree the Zen plugin file (`packages/core/src/plugin/provider/opencode.ts`) is deleted along with its references; upstream touches provider plugins often, so resolve future merge conflicts by deleting the file again.

**Amendment (2026-10-16).** The fork's flat `x-opencode-*` headers are gone: outbound model requests now carry only upstream's `x-session-affinity` / `X-Session-Id` / `x-parent-session-id` and the `User-Agent`. They were upstream's own, added in `f46fa72a92` and `e9f8a210b9` for the vendor gateway, and they leaked session and project ids to whatever provider is configured; resolve future `request.ts` conflicts by dropping the flat set, not by restoring it.
