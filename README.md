<p align="center">
  <a href="https://github.com/eric-stone-plus/opencode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>

<p align="center">A personal, TUI-only fork of the open source AI coding agent.</p>

<p align="center">
  <a href="https://github.com/eric-stone-plus/opencode/actions/workflows/check.yml"><img alt="check" src="https://img.shields.io/github/actions/workflow/status/eric-stone-plus/opencode/check.yml?style=flat-square&label=check" /></a>
  <a href="https://github.com/eric-stone-plus/opencode/actions/workflows/test.yml"><img alt="test" src="https://img.shields.io/github/actions/workflow/status/eric-stone-plus/opencode/test.yml?style=flat-square&label=test" /></a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](packages/web/src/assets/lander/screenshot.png)

---

### What this fork is

A TUI-first working tree: the terminal UI is the supported surface.

- The desktop app is deleted, not disabled — `docs/adr/0007-desktop-app-removed-tui-only.md`.
- The binary is built from this source tree and never self-upgrades: `opencode upgrade` and `opencode web` stay unregistered, and no package-manager install path is supported — `docs/adr/0001-source-built-binary-no-self-upgrade.md`.
- Catch up with upstream through `bun run sync-upstream`, which is merge-only — `docs/adr/0002-merge-based-upstream-sync.md`.

`packages/app` (the CLI's web UI) stays as a build dependency: the CLI build and CI exercise the embedding path, but the fork's own builds pass `--skip-web-ui`, which embeds an empty archive, so the installed binary serves no web shell.

### Build from source

Requires [Bun](https://bun.sh) — the tree pins `bun@1.4.2`.

```bash
git clone https://github.com/eric-stone-plus/opencode
cd opencode
bun install --frozen-lockfile
```

Then build and install the binary where your shell's `opencode` shim points — `~/.opencode/bin/opencode` on this machine:

```bash
cd packages/cli
bun run script/build.ts --single --skip-install
mkdir -p ~/.opencode/bin
cp dist/cli-<platform>-<arch>/bin/opencode ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
```

The build bakes the channel in from the checked-out branch (`OPENCODE_CHANNEL` wins; `OPENCODE_BUMP`/`OPENCODE_VERSION` force `latest`): build from `main`, or set `OPENCODE_CHANNEL=main`. Any channel outside `latest`/`dev`/`beta`/`next`/`prod` names the database `opencode-<channel>.db`; `OPENCODE_DB` overrides the filename.

### Modes

Two primary profiles ship in the binary itself (`packages/core/src/plugin/fork/profiles.ts`), so a fresh clone starts in **auto** before any seat config exists: the global config is absent on a new machine and project config is closed by the trust gate, which previously left upstream's Build/Plan as the only primaries. `opencode.jsonc` (or the installed global config) layers the full seat definitions on top. Cycle with the agent-cycle key (`Tab` in this fork's `cli.json`):

- **auto** (blue) — the default. Never asks: adopts the recommended option and runs to completion. Its standing card carries the swarm mandate too (`packages/core/src/plugin/fork/mode/auto.txt`), so a new task is worked by parallel subagents — Round-1 axes, then Round-2 attackers — instead of single-threaded.
- **goal** (red) — every message steers one session goal; runs the adversarial subagent swarm playbook in `bootstrap/agent/goal.md`.

The built-in profiles carry the managed card bodies as their system prompt, so a config-less clone gets the same contract as the seat. Upstream's `build` and `plan` primaries are removed by the same plugin (the seat config spells the removal as `"disable": true`); a config that explicitly declares one restores it, so the default cycle is exactly auto <-> goal.

Subagents keep their own rules: `@general` for multi-step tasks, `explore` for read-only codebase searches. Fan-out is not capped — one server ran 3000 concurrent sessions with zero errors at a ~4.9 GB peak (2026-10-15) — and `@general` may spawn its own subagents (`experimental.subagent_depth: 100`, no practical cap), while `explore` stays read-only and cannot.

### Documentation

- `PERSONAL.md` — the fork manual: what is patched, why, and how to keep it that way.
- `docs/adr/` — durable decisions: source-built binary, merge-only sync, provider policy, desktop removal.
- `bootstrap/README.md` — machine setup, channels, and the seat-wiring inventory.
- `docs/OPERATIONS.md` and `docs/LOCAL_TOOLS.md` — host operations and local tooling.
- `AGENTS.md` and `CONTRIBUTING.md` — the engineering rules for this tree.

### Credits

Upstream OpenCode is `anomalyco/opencode` — <https://opencode.ai>, docs at <https://opencode.ai/docs>. This fork keeps upstream's history and license: MIT, see `LICENSE`.
