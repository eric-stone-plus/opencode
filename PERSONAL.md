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

All commands run from the repo root — wherever it is checked out on that machine.

Catch up to official (fetch `upstream/dev`, rebase personal commits, push `origin/main`, rebuild binary):

```bash
bun run sync-upstream
```

- Dirty tree → commit or stash first; the script refuses to run dirty.
- Rebase conflict → fix files, then:

```bash
git add -A && git rebase --continue
bun run sync-upstream --continue
```

- Git only, skip compile: `bun run sync-upstream --no-rebuild`
- Machine can't reach GitHub directly? Set the proxy repo-locally (lives in `.git/config`, per machine, not in this doc): `git config http.proxy http://127.0.0.1:PORT && git config https.proxy http://127.0.0.1:PORT`

After any source change that should hit the TUI, rebuild if you skipped it:

```bash
cd packages/opencode
bun run script/build.ts --single --skip-install
cp dist/opencode-*/bin/opencode ~/.opencode/bin/opencode
chmod +x ~/.opencode/bin/opencode
~/.opencode/bin/opencode --version
```

`--single` builds only the current platform, so exactly one `opencode-<platform>-<arch>` dir exists (`darwin-arm64`, `darwin-x64`, `linux-x64`, …) and the glob picks it up.

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
cp tui.json ~/.config/opencode/tui.json   # from the repo root
```

## Idle CPU spin / frozen TUI (open)

Symptom: TUI stops answering and the process burns 100%+ CPU with no session in
flight. 2026-09-10 instance (macOS): last log line 10:54:32, restarted 12:40:42 — 106
minutes of total silence, no crash report in `~/Library/Logs/DiagnosticReports`,
memory 84% free.

The `eric: fix idle CPU spin` overlay **is** in the running binary. Binary mtime
is `Sep 4 15:08`, the commit is `15:10:35`; the tell is that the
`@opencode-ai/plugin@0.0.0-main-…` install WARN stops appearing from the first
launch after that rebuild. So 2026-09-10 is a recurrence *after* the fix.

Ruled out:

- **File watcher.** `OPENCODE_EXPERIMENTAL_FILEWATCHER` defaults to `false`,
  `$HOME` is not a git repo so the `.git` subscription never arms, and the
  `isBroadRoot` overlay skips `/` and `$HOME` anyway. The log contains zero
  `skipping file watcher` and zero `failed to subscribe` lines — no subscription
  ever happened. `watcher.ignore` in config is therefore a **no-op** in this
  setup. Do not chase idle CPU through watcher ignores, and do not "fix" it by
  requiring a `cd` into a project.
- **Memory / OOM.** Free at the time, no crash report.

Signal worth chasing: `sample(1)` keeps showing a thread parked in opentui's
stdout path — `renderer-output.StdoutOutput.write` → `fs.File.Writer.drain` →
`writev`/`pwrite` against `/dev/ttysNNN`, nested two levels deep, plus a large
`syscall_thread_switch` count in the top-of-stack histogram. The Sep 4 patch
only floored the rerender *scheduler* (`Math.max(1 → 16)` in `@opentui/core`);
nothing touches the drain path. A terminal tab that stops draining its pty
would make that loop retry forever.

Not yet evidence: a capture taken while the instance was genuinely idle. The
2026-09-10 capture was taken against a live streaming session, so its CPU is
partly legitimate render load.

### Instrumentation

```bash
bun run cpu-probe                       # sampler, auto-captures on idle spin
bun run cpu-probe -- --exclude <pid>    # measure a pid but never sample it
bun run cpu-probe -- --no-capture      # TSV only
bun run freeze-capture                  # one-shot snapshot of a frozen TUI
bun run freeze-capture -- --pid <n> --seconds 10
```

Output goes to `logs/` (gitignored): `logs/cpu-probe/probe-YYYYMMDD.tsv`,
`logs/cpu-probe/spin-*.txt`, `logs/freeze/<stamp>/SUMMARY.txt`.

Platform note: measurement (`ps`, TSV) is cross-platform. Stack capture uses
`sample(1)` on macOS and `eu-stack -p` (elfutils) on Linux, with fallbacks to
`gdb -batch -ex 'thread apply all bt'` and finally to the bare ps/wchan thread
table (states still classified, no frames). Linux attach needs ptrace access:
fine when `kernel.yama.ptrace_scope=0`; with scope=1 only the process parent
may attach. The Linux thread table also names Bun's threads (HeapHelper,
JITWorker, Bun Pool N), which sample(1) does not.

Rules when using them:

- Every opencode instance on the box shares one
  `~/.local/share/opencode/log/opencode.log`, so cpu-probe's idle gate is
  **global**, not per pid. Run it when only the suspect instance is up, or pass
  `--exclude` for the busy one.
- Stack capture **suspends the target's threads** (sample(1) on macOS,
  eu-stack/gdb attach on Linux). Never aim it at a session doing real work
  without asking the owner first. `ps` and `lsof` are read-only and always safe.
- `pgrep(1)` returns nothing under some sandboxed shells; both scripts discover
  pids through `ps -axo pid=,comm=` instead.

## Agent rules for this fork

- Default branch for diffs and PRs against **this** repo is `main`, not `dev`.
- Do not open PRs to `anomalyco/opencode` unless the owner explicitly asks.
- Do not add a second long-lived branch “to keep things clean”.
- After overlay code changes, either run `bun run sync-upstream --continue` (if a rebase just finished) or rebuild the binary so `~/.opencode/bin/opencode` matches HEAD.
