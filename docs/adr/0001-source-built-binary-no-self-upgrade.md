# The fork binary is source-built and never self-upgrades

Every `Installation.upgrade` method (curl script, npm, brew, …) would replace the source-built `~/.opencode/bin/opencode` with an upstream release, so `opencode upgrade` / `opencode web` stay unregistered, the upgrade command files stay deleted, and V1's `POST /global/upgrade` answered 403 (the route no longer exists in the V2 tree). `sync-upstream` refuses to build or push when a merge reintroduces any of those paths, and the only supported update path is `bun run sync-upstream`.

**V2 (2026-10-12).** The V2 tree keeps the same posture: the V1 `upgrade`/`uninstall` command files are deleted, `services/updater.ts` is a network- and filesystem-free stub (`Updater.layer` stays because the Runtime typings require it), the home banner and `/update` are gone, and `assertForkInvariants` in `script/sync-upstream.ts` stops the flow if a merge brings any of it back.
