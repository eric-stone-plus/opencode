# Personal fork notes (read this first)

This tree is **eric-stone-plus/opencode**, a personal overlay on official OpenCode.
Do not treat it as a clean `anomalyco/opencode` clone.

Owner always delegates git/build/sync to an agent. Follow this file.

## Layout

| What | Where |
|------|--------|
| Fork (only branch) | `origin` → `https://github.com/eric-stone-plus/opencode.git` **`main`** |
| Official upstream | `upstream` → `https://github.com/anomalyco/opencode.git` **`dev`** |
| Runtime binary | `~/.opencode/bin/opencode` |
| User config (not in this repo) | `~/.config/opencode/opencode.jsonc` |
| TUI keybinds (repo + runtime) | repo `tui.json` → **must** be `~/.config/opencode/tui.json` |

There is no `dev` on the fork. Do not create extra branches unless asked.

## Everyday commands

Catch up to official (fetch `upstream/dev`, rebase personal commits, push `origin/main`, rebuild binary):

```bash
cd ~/Private/opencode-repo
bun run sync-upstream
```

- Dirty tree → commit or stash first; the script refuses to run dirty.
- Rebase conflict → fix files, then:

```bash
git add -A && git rebase --continue
bun run sync-upstream --continue
```

- Git only, skip compile: `bun run sync-upstream --no-rebuild`

After any source change that should hit the TUI, rebuild if you skipped it:

```bash
cd ~/Private/opencode-repo/packages/opencode
bun run script/build.ts --single --skip-install
cp dist/opencode-darwin-x64/bin/opencode ~/.opencode/bin/opencode
chmod +x ~/.opencode/bin/opencode
~/.opencode/bin/opencode --version
```

(This machine is darwin/x64. On arm64 the dist dir is `opencode-darwin-arm64`.)

## How to keep personal patches

1. All custom work lands as commits on **`main`**, stacked on top of `upstream/dev`.
2. Commit prefix for overlay work: `eric: …` (matches existing history).
3. Do **not** edit files only on a side branch and forget to rebase.
4. `~/.config/opencode/opencode.jsonc` (provider/model) is local-only. `tui.json` is in the repo; `sync-upstream` copies it to `~/.config/opencode/tui.json`. Launching from `$HOME` does **not** read the repo-root file.

If a rebase conflict hits a file you patched, keep the personal behavior unless the owner says otherwise.

## Overlay already on `main` (do not drop)

- Long-session TUI: idle **8fps**, busy 30fps (`packages/tui`).
- Compaction: prune old tool output **on by default**; advertised 1M contexts compact around a **256k** working set (`overflow.ts` / `compaction.ts`).
- PDF Read: extract text (`pdftotext` / python); **never** inline `data:application/pdf;base64,…`.
- File watcher: skip `/` and `$HOME`. Launching OpenCode from the home directory is intentional (NAS paths live outside cwd). Do not “fix” that by requiring `cd` into a project.
- Keybinds: Ctrl+C / Ctrl+D do not exit; `app_exit` none. Exit with `/exit` or `/quit`. Mouse stays on (default). Session paging must work without PgUp/PgDn: `ctrl+up`/`ctrl+down` and `alt+up`/`alt+down` (Mac Option+arrows). Line scroll: `ctrl+shift+up`/`ctrl+shift+down`. Do not bind bare arrows — those stay prompt cursor/history. Runtime copy: `~/.config/opencode/tui.json` (installed by sync).
- `bun run sync-upstream` itself (`script/sync-upstream.ts`).

## Config outside git

`~/.config/opencode/opencode.jsonc` must match repo-root `opencode.jsonc` (provider `bailian-token-plan-personal` / model `qwen3.8-max`). The full-power tuning in it is intentional:

- `limit`: context 983616 / input 852544 / output 131072 (`input` keeps the 256k working window intact when the output cap grows)
- model `options`: `"effort": "max"` — travels as `output_config.effort`; bailian supports low/medium/high/xhigh/max. Do not downgrade unless asked.
- `"compaction": { "auto": true, "prune": true }` — do not revert prune unless asked.
- `"permission": "allow"` — full auto-approve, intentional. Do not revert.

If the runtime file drifts, restore it: `cp opencode.jsonc ~/.config/opencode/opencode.jsonc` from the repo root.

`~/.config/opencode/env` (600, outside git) needs, besides `QIANWEN_TP_PERSONAL_KEY`:

- `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536` — raises the max_tokens cap from the 32k default; bailian accepts up to 131072.

`~/.config/opencode/tui.json` must match repo `tui.json` (`app_exit: none`). If Ctrl+C quits the TUI, the runtime file is missing — copy it:

```bash
cp ~/Private/opencode-repo/tui.json ~/.config/opencode/tui.json
```

## Agent rules for this fork

- Default branch for diffs and PRs against **this** repo is `main`, not `dev`.
- Do not open PRs to `anomalyco/opencode` unless the owner explicitly asks.
- Do not add a second long-lived branch “to keep things clean”.
- After overlay code changes, either run `bun run sync-upstream --continue` (if a rebase just finished) or rebuild the binary so `~/.opencode/bin/opencode` matches HEAD.
