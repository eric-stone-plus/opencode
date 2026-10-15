# The operator's non-DeepSeek provider blocks and their credentials are removed

ADR 0009 kept two things outside its deletion policy: the operator's
`bailian-token-plan-personal` and `xiaomi-token-plan-cn` blocks in `opencode.jsonc`
(config-declared providers, ADR 0003) and their credentials on the seat. On
2026-10-15 the operator withdrew that carve-out — MiMo is deprecated, the source is
DeepSeek-only, and every model list must show DeepSeek alone. This ADR records the
finish: the config blocks, the credential entries and the reproduction bundle's seed
material are gone, not disabled.

Deleted:

- **Config**: both provider blocks in all three copies (`~/.config/opencode/opencode.jsonc`,
  repo-root `opencode.jsonc`, `bootstrap/config/opencode.jsonc`), so the provider
  catalog that the TUI integration dialog and the `ctrl+a` model picker resolve is
  DeepSeek alone. The header comment in each copy keeps the removal record.
- **Credentials**: the `xiaomi-token-plan-cn` entry in the V2 credential store and
  `auth.json` (purged with `opencode auth purge xiaomi-token-plan-cn --yes --history`,
  which also sweeps the value's copies), plus `~/.config/agent-secrets/mimo.env`. The
  `bailian-token-plan-personal` entry never existed on this seat: the qwen key was only
  ever a names-only template (`environment.d/95-qwen-provider.conf`), deleted too.
- **Reproduction bundle**: `bootstrap/config/auth.json.template` and `env.template`
  shrink to the DeepSeek entry, `bootstrap/config/environment.d/95-qwen-provider.conf`
  is deleted, and `verify.sh` requires the one provider. The wrapper's egress probe set
  already derives from the config (V3), so it follows automatically; its hardcoded
  fallback list is reduced to `api.deepseek.com`.
- **Docs**: `PERSONAL.md`'s bailian/xiaomi tuning notes and re-seed procedure are
  replaced by the DeepSeek-only state; `bootstrap/README.md` §1/§2/§3/§5/§6 follow.

Consequences:

- Restoring a track means pulling the vendor back from upstream (ADR 0009's route) and
  re-declaring the block; the fork keeps no copy.
- The NAMES-ONLY contract — a secret value is never vendored into the repository — is now
  mechanical: `script/check-names-only.ts` scans `bootstrap/config/**` with the repo's own
  secret patterns (`packages/http-recorder/src/redaction/secrets.ts`) plus a non-secret
  allowlist for seed values, and `.husky/pre-push` runs it, so a re-seeded template fails
  the push instead of shipping a key. The live purge reported "no copy of the removed
  values remains" because it sets `PRAGMA secure_delete` for the redaction and re-scans the
  database with its `-wal`/`-shm` sidecars afterwards (`packages/core/src/credential/purge.ts`).

Defects the removal exposed, fixed in the same window:

- `auth purge` built its candidate list from the integration catalog alone, so a vendor the
  catalog no longer lists could not be named at all — and `--all`, the one command that
  would have taken DeepSeek's key with it, was the only route left. The candidate list now
  completes itself from the credential store, lazily and only when a target matches nothing
  else (`packages/cli/src/commands/handlers/auth/purge.ts`).
- The TUI integration priority used `id in INTEGRATION_PRIORITY`, which walks the prototype
  chain: an integration whose id was `toString` sorted with a NaN key and rendered as
  "Popular". `integrationCategory` now uses `Object.hasOwn`
  (`packages/tui/src/component/dialog-integration.tsx`).
- `bootstrap/plugin/secret-path-guard.ts` denies `~/.config/environment.d` to the file
  tools: the deleted `95-qwen-provider.conf` shipped mode 0600 for a reason, and
  `motoko-keys.conf` holds live keys in the same directory.
- The provider-policy gate's `REMOVED_PATHS` now names the paths a *clean* merge would
  resurrect rather than the files that existed at deletion time: upstream landed
  `packages/ai/src/protocols/alibaba-responses.ts` after the sync, and a brand-new upstream
  file arrives without a delete/modify conflict for the sync's DU step to catch.

One stale copy needed a manual pass: `~/.local/share/opencode/backup-20261012/opencode-main.db`
still carried the credential row. It was redacted in place (row deleted, file VACUUMed) and
its manifest keeps the original size and hash under `redacted.original`. The purge does not
sweep backups by design, so this was a one-off edit of a snapshot, not a code path.

Not removed, deliberately:

- `packages/core/src/database/migration/20261007190000_azure_cli_external_credential.ts`:
  a one-time historical data rewrite for rows no configuration here can create, already
  applied, and covered by a fork-maintained test. It is not a reachable support surface, so
  deleting it would only churn the migration chain and the test file.
- `packages/ui/src/assets/icons/provider/*.svg` for removed vendors, and the `services/www`
  plus `cli` documentation pages that name them: the www deploy guard requires
  `github.repository == 'anomalyco/opencode'` (`.github/workflows/deploy-www.yml`), so this
  fork serves neither, and ADR 0006 keeps public-site content.
- `docs/OPERATIONS.md` §1 and the ADRs keep their historical vendor references: they are
  dated records of what was true then, not live surfaces.
