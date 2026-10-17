# Provider model names are authoritative

**Decided 2026-10-17.** The picker and the system prompt must follow the model version the provider is
actually serving, without a source rebuild for every server-side release. DeepSeek upgraded
`deepseek-flash` from V4.1-Flash to V4.1-Flash-1017 on 2026-10-17 and published the new name in
`GET /models`; the models.dev snapshot still said V4.1-Flash, and the seat config had a hardcoded
`name` that pinned the old label.

## Decision

`ForkModelNamesPlugin` (`packages/core/src/plugin/fork/model-names.ts`) refreshes model display names
from each declared provider's own `GET <baseURL>/models` response:

- at plugin activation, then every six hours and on `config.updated`, `provider.updated` and
  `credential.updated`;
- using the provider's active integration credential and its configured `baseURL`;
- caching the last successful map in plugin storage so a cold boot shows the last known name before
  the first request;
- applying names through a model transform in the fork's `post` group, after the config provider
  transform, and reloading the model state so `model.updated` reaches the TUI and the per-request
  system prompt.

A model whose provider config sets an explicit `name` keeps that name: the config is an operator
override, not a stale snapshot. The seat removed its hardcoded `name` on the same day, so the
DeepSeek row is now remote-driven.

## Not a reversal of the catalog policy

ADR 0003/0009 keep `OPENCODE_DISABLE_MODELS_FETCH=1` and the DeepSeek-only models.dev snapshot. This
plugin does not fetch models.dev: it asks the provider the credential already belongs to, at the
base URL the operator declared, for the display name of the models that provider serves. No catalog
row is added or enabled, and the request is skipped when the provider has no active key credential.

## Consequences

- A server-side rename/upgrade appears after at most one refresh interval, with no rebuild; a restart
  after a successful refresh shows the cached name immediately.
- A failed refresh is fail-open: the cached name, then the catalog/config name, stays in place. The
  refresh logs only the provider id and HTTP status, never the request or credential.
- `GET /models` also returns context window, output limit, modalities and effort levels. This ADR
  covers the display name only; syncing those fields would change model capability policy and needs
  its own decision.
