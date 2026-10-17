# Provider model names are authoritative

**Decided 2026-10-17.** The picker and the system prompt must follow the display name the provider
publishes, without a source rebuild for every server-side release. DeepSeek upgraded `deepseek-flash`
to V4.1-Flash-1017 on 2026-10-17. `GET /models` reports the model's **display name** as
`DeepSeek-V4.1-Flash` (the build suffix `-1017` lives in the pricing page's MODEL VERSION field, not
in the API name), while the models.dev snapshot still said `DeepSeek V4.1 Flash` and the seat config
had a hardcoded `name` that pinned the old label.

## Decision

`ForkModelNamesPlugin` (`packages/core/src/plugin/fork/model-names.ts`) refreshes the DeepSeek model
display name from `GET https://api.deepseek.com/models`:

- at plugin activation, then every six hours and on `config.updated`, `provider.updated`,
  `credential.updated` and `credential.switched`; a pass with no usable provider retries after five
  seconds instead of waiting six hours;
- using the active `deepseek` integration's key credential;
- caching the last successful map in plugin storage so a cold boot shows the last known name before
  the first request;
- applying names through a model transform in the fork's `post` group, after the config provider
  transform, and reloading the model state so `model.updated` reaches the TUI and the per-request
  system prompt.

A model whose provider config sets an explicit `name` keeps that name: the config is an operator
override, not a stale snapshot. The live seat, the tracked root config and the bootstrap seed
removed their hardcoded `name` on the same day, so the DeepSeek row is remote-driven.

## Scope: DeepSeek only

This fork supports one vendor (ADR 0009). The plugin is deliberately narrower than the provider
list: it only refreshes the `deepseek` provider, and `baseURL` must be `https://api.deepseek.com`
with an empty or `/v1` path. A project config that re-points `baseURL` at another host therefore
cannot turn the refresh into a credential-exfiltration request; the pass is skipped. OAuth
connections are skipped before resolution so a token refresh cannot re-enter the plugin.

## Not a reversal of the catalog policy

ADR 0003/0009 keep `OPENCODE_DISABLE_MODELS_FETCH=1` and the DeepSeek-only models.dev snapshot. This
plugin does not fetch models.dev: it asks DeepSeek for the display name of the model DeepSeek serves.
No catalog row is added or enabled, and the request is skipped when the provider has no active key
credential.

## Consequences

- A server-side rename/upgrade appears after at most one refresh interval, with no rebuild; a restart
  after a successful refresh shows the cached name immediately. The API display name may omit the
  build suffix; showing `-1017` would require scraping the pricing page and is not done here.
- A failed refresh is fail-open: the cached name, then the catalog/config name, stays in place. The
  refresh logs only the provider id and HTTP status, never the request or credential.
- Remote names are trimmed, length-capped and restricted to letters, digits, spaces and a small
  punctuation set before they reach the picker or the system prompt; a name with control characters
  or newlines is rejected.
- `GET /models` also returns context window, output limit, modalities and effort levels. This ADR
  covers the display name only; syncing those fields would change model capability policy and needs
  its own decision.
