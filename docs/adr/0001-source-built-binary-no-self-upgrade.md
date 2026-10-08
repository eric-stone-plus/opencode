# The fork binary is source-built and never self-upgrades

Every `Installation.upgrade` method (curl script, npm, brew, …) would replace the source-built `~/.opencode/bin/opencode` with an upstream release, so `opencode upgrade` / `opencode web` stay unregistered, the upgrade command files stay deleted, and `POST /global/upgrade` answers 403. `sync-upstream` refuses to build or push when a merge reintroduces any of those paths, and the only supported update path is `bun run sync-upstream`.
