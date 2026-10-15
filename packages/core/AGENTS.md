# Core Package Guide

## Fork scope

Core is where this fork's own code lives. Fork-owned modules sit in dedicated directories so upstream files stay close to pristine: `src/plugin/fork/` (fork plugins, registered in `src/plugin/fork/index.ts`) and `src/session/fork/` (session-side overlays). Prefer a new fork file plus a single wiring edit over editing an upstream file — every upstream line this fork touches is a line the next sync may conflict on. When a merge conflicts on a deleted provider or desktop file, resolve it with `git rm` (ADR 0002, ADR 0005, ADR 0007).

## Tests

- Run `bun run test` from this package, never a bare `bun test`: the canonical runner (`script/test.ts`) sets the isolated `HOME` and XDG roots the suite depends on, and a direct run turns `preload.test.ts`'s isolation assertions into artifacts.
- Fork-only suites live beside their subjects (`test/plugin/fork/`, `test/fork/`), and `packages/core/test/plugin/supervisor.test.ts` pins the plugin-reload semantics the fork relies on.

## Known limitations

- **Project-local plugins execute without a prompt.** Opening a repository imports `.opencode/plugin/` and any `plugins` entry in its config (`src/config/plugin/source.ts:127-147` → `src/plugin/module.ts:120-124`), and MCP `command` servers from project config spawn asynchronously when a Location starts. The managed policy layer is the only veto and defaults to allow when nothing is configured (`src/plugin/module.ts:52-59`, `src/managed-policy.ts:69-77`). Use `OPENCODE_CONFIG_PROJECT_DISABLE=1` before opening an untrusted tree; it also disables this repo's own project config.
- **A project document can re-allow what a global document denied.** Permission rules scan last-match-wins and config documents load lowest-precedence first, so only a managed settings document (loaded last) outranks a project file; a configured deny still short-circuits saved approvals. Order and consequences: ADR 0008 and the trust-gate section of `PERSONAL.md`.
- **Goal state is per-session and not copied on fork.** The goal file lives at `~/.local/share/opencode/goals/<sessionID>.md` (`src/plugin/fork/files.ts`); forking a session or switching worktrees means setting the goal again.
