# bootstrap/ — opencode seat reproduction bundle

Versioned snapshot of everything needed to **precisely reproduce this opencode
seat** on another Linux machine ("machine B"). Cut from machine A on 2026-09-29.

Source of truth on machine A:

| Item | Path |
| --- | --- |
| fork repo (binary source) | `/home/eric/Documents/Development/private/agent-design/projects/opencode` (branch `main`) |
| live config | `~/.config/opencode/opencode.jsonc` |
| canonical DB | `~/.local/share/opencode/opencode-main.db` |

The binary is a fork build `0.0.0-main-<timestamp>` (verified live:
`0.0.0-main-202609280832`). The channel is derived from `git branch
--show-current` (`packages/script/src/index.ts:27`) and is compiled in at build
time (`OPENCODE_CHANNEL` define, `packages/opencode/script/build.ts:196-204`).

---

## 1. Machine-B runbook (ordered)

### Step 0 — deps

| Dep | Why | Version note |
| --- | --- | --- |
| `bun` | build + `run-cases.ts` battery | **1.3.14** — `packageManager: bun@1.3.14` is enforced `^1.3.14` (`packages/script/src/index.ts:6-19`) |
| `jq` | kill-guard script + `run-cases.sh` | any |
| `git` | clone + channel derivation at build | any |
| `python3` | sqlite integrity checks, JSON hook wiring, `_oc_tty_flush_input` | any |
| `curl` | egress probes in the bashrc wrapper | any |
| `sqlite3` | optional, only for `opencode db query` interactive shell | any |

### Step 1 — clone repos

```sh
# the fork (binary source) — clone onto machine B anywhere
git clone <this-repo> ~/work/agent-design/projects/opencode
cd ~/work/agent-design/projects/opencode
git checkout main                       # REQUIRED: see channel note below
```

**Channel discipline (do not skip).** The build bakes the channel in from the
branch name. A build from any channel outside `{latest,beta,prod}` makes the DB
filename `opencode-<channel>.db` (`packages/core/src/database/database.ts:43-54`)
— machine A already collected the scars (`opencode-local.db`, see §4). Build
from `main`, or set `OPENCODE_CHANNEL=main`.

### Step 2 — install + build the binary

```sh
cd ~/work/agent-design/projects/opencode
bun install --frozen-lockfile           # applies the 10 patchedDependencies
cd packages/opencode
bun run script/build.ts --single --skip-install
# ^ fetches https://models.dev/api.json at build time unless MODELS_DEV_API_JSON
#   is set in the environment. Smoke test runs `--version` only (build.ts:209-217).
```

Then install the binary where the shim expects it (`~/.opencode/bin/opencode`).
Either run the repo's own pipeline (`bun run sync-upstream --no-rebuild` is
*not* enough on a fresh clone — it also needs a clean tree; see the script
header for its fetch/merge semantics), or just copy the build output:

```sh
mkdir -p ~/.opencode/bin
cp packages/opencode/dist/<platform-arch>/bin/opencode ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
```

`script/sync-upstream.ts` additionally installs `~/.config/opencode/tui.json`
(`main()`), the vendored `skills/` (`installSkills`, rm+cp), and
`AGENTS.goal.md` + `autonomy.md` (`installGoalConfig`, rm+copyFile), and seeds
`agent/goal.md`. It does NOT touch `plugin/`, `opencode.jsonc`, `AGENTS.md`, or
any other `command/*.md` / `agent/*.md`. Run it if you want its pieces.

### Step 3 — this bundle's installer

```sh
cd ~/work/agent-design/projects/opencode   # wherever bootstrap/ lives
bash bootstrap/install.sh --dry-run        # read the plan first
bash bootstrap/install.sh                  # apply
# test home (every home-specific path is derived from --home):
bash bootstrap/install.sh --home /tmp/opencode/fakehome
```

Flags: `--dry-run`, `--home <path>`, `--user <name>` (legacy, banner only), `--link` (file-symlink
`opencode.jsonc` into the checkout instead of copying), `--no-bashrc`. Idempotent: a second run reports
`0 change(s)` and does nothing. Every overwritten file gets a timestamped
`*.bak.<YYYYmmddHHMMSS>` sibling (the newest 20 per target are kept, oldest
pruned by mtime; only that exact installer-made name is ever pruned, a
hand-made `.bashrc.bak.mine` is never touched); files that must never be
overwritten are listed in §5.

### Step 4 — secret entry (the only manual step)

Nothing in this bundle carries secret values. Fill `~/.local/share/opencode/auth.json`
(four provider keys) and the `environment.d` seed files per §3, then:

```sh
# install.sh created the skeleton if auth.json was absent:
ls -l ~/.local/share/opencode/auth.json   # mode 0600
# mode 0600 is converged on every run for auth.json, ~/.config/opencode/env
# and the secret-bearing environment.d drop-ins (content is never touched):
ls -l ~/.config/opencode/env ~/.config/environment.d/95-qwen-provider.conf
```

### Step 5 — re-login, then verify

**Re-login** (or restart the systemd user session) first so `environment.d` is
loaded — verify.sh FAILs while `OPENCODE_DB` is not yet in the live
environment — then:

```sh
bash bootstrap/verify.sh                  # or: --home /tmp/opencode/fakehome
```

PASS/WARN/FAIL per check; exit 1 on any FAIL (including a missing real binary
at `~/.opencode/bin/opencode`: the `~/.local/bin` pin shim does not count).
Start `opencode` and check the wrapper is live with `type opencode` (must show
a *function*).

---

## 2. What install.sh does (and refuses to do)

| Step | Target | Policy |
| --- | --- | --- |
| 1 | dirs under `~/.config/opencode`, `~/.config/environment.d`, `~/.config/agent-hooks`, `~/.local/bin` | create if missing |
| 2 | `~/.config/opencode/opencode.jsonc` | copy (+ plans-path sed derived from `--home`) or `--link` symlink; timestamp-backup on overwrite. A plain install over an earlier `--link` replaces the link itself (backed up as a link) — it never writes through a symlink into the checkout; the same holds for every managed file |
| 2 | `~/.local/share/opencode/auth.json` | **only if absent**, from template; mode converged 0600 (content never touched afterwards) |
| 2 | `~/.config/opencode/env` | **only if absent** (re-seed seed file; may hold live seeds); mode converged 0600 |
| 3 | `~/.local/bin/opencode` pin wrapper → `~/.opencode/bin/opencode` | kept when it already is the pin wrapper; any other shim/symlink there is moved aside to `opencode.pre-pin.<TS>` and replaced (sync-upstream never creates the shim) |
| 4 | `environment.d/10-opencode-db.conf` | managed (converges; backup on overwrite) |
| 4 | `environment.d/{90-fcitx5,95-qwen-provider}.conf` | **only if absent**; templates carry names only; `95-qwen-provider` gets mode 0600 |
| 5 | `~/.config/agent-hooks/*` (4 files) | copy with `sed s\|/home/eric\|$TARGET_HOME\|` |
| 5b | hook surfaces: `~/.claude/settings.json`, `~/.zcode/settings.json`, `~/.grok/hooks/block-unsafe-kill.json`, `~/.kimi-code/config.toml` | **only if the target file exists** (never created wholesale); rewrites the guard *path token* to the target home (wrapper command + args survive) / inserts the stanza unless a `PreToolUse` hook command already runs the guard (a bare mention such as a permissions entry does not count); edits are spliced into the original text, so JSONC comments and trailing commas survive, and a file needing no change is not rewritten (if a splice is impossible the re-serialization is announced with a WARN naming the backup); backup first; the destination keeps its own file mode (a 0600 settings.json is never downgraded) |
| 6 | `skills-extra/` → `~/.config/opencode/skills/` | collision-checked: identical = skip, differing = one timestamped backup + **left in place** (never rm/overwrite; merge by hand) |
| 7 | `plugin/{block-unsafe-kill.ts,mpskills-update.ts,secret-path-guard.ts,open-code-review.ts}` | copies, as-is |
| 8 | `agent/` goal file, `autonomy.md`, `AGENTS.goal.md` | only those shipped in the bundle; the two `instructions` files (`autonomy.md`, `AGENTS.goal.md`) converge on every run, `agent/goal.md` is a seed (installed only when absent). There is no `command/goal.md`: the `/goal` command was removed |
| 9 | `~/.bashrc` + `~/.config/opencode/shell/bashrc-opencode-block.sh` | the wrapper is copied to the seat config tree and sourced from that stable path (older `source`/`.` lines for it are rewritten in place, never duplicated; commented-out lines are left alone); marked, idempotent block inside an interactive guard; `--no-bashrc` skips |

Explicit non-goals (owned by `script/sync-upstream.ts` or by hand):
`tui.json`, the vendored `skills/` set, `AGENTS.md`, the real binary.
(`autonomy.md` and `AGENTS.goal.md` are installed by both:
same content, same replace-in-place policy.)

**SYMLINK RULE.** Individual *file* symlinks into a git checkout are safe and
better (live-edit). *Directory* symlinks for `skills/` and `command/` are
**forbidden** when the sync source is the same tree: `sync-upstream` does
`rm -rf` + `cp` into them and would delete the checkout's contents.

---

## 3. Secrets re-seed (values never vendored)

`~/.local/share/opencode/auth.json` — four entries, each `{ "type": "api",
"key": … }`:

| Provider id (auth.json / opencode.jsonc) | Endpoint | Where the key comes from |
| --- | --- | --- |
| `bailian-token-plan-personal` | `token-plan.cn-beijing.maas.aliyuncs.com` (Alibaba Cloud Model Studio) | `QIANWEN_TP_PERSONAL_KEY` — machine A's seed lives in `~/.config/opencode/env` (byte-identical to the auth.json entry; verified by comparison) and is mirrored in `environment.d/95-qwen-provider.conf` |
| `glm-coding-plan` | `open.bigmodel.cn/api/anthropic/v1` (GLM Coding Plan) | GLM/Zhipu coding-plan console — **not** present in any env seed on machine A (verified); console-sourced. Do not confuse with `GLM_API_KEY` below (different, separately rotated) |
| `zhipuai-coding-plan` | Zhipu open platform (coding plan) | Zhipu console (`open.bigmodel.cn` account) |
| `xiaomi-token-plan-cn` | `token-plan-cn.xiaomimimo.com` (Xiaomi MiMo token plan — current default model track) | Xiaomi token-plan console |

`~/.config/opencode/env` (seed file; NOT read by the binary, NOT sourced by the
shell wrapper — keep it purely as the auth.json re-seed seed):

| Var | Value on machine A | Secret? |
| --- | --- | --- |
| `QIANWEN_TP_PERSONAL_KEY` | see table above | yes |
| `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | `65536` | no (numeric cap; copy freely) |

`~/.config/environment.d/` templates (names-only in `bootstrap/config/`):

| File | Vars | Re-seed source |
| --- | --- | --- |
| `10-opencode-db.conf` | `OPENCODE_DB=opencode-main.db` | not secret — install.sh writes the real value |
| `90-fcitx5.conf` | `QT_IM_MODULE` `XMODIFIERS` `SDL_IM_MODULE` `GLFW_IM_MODULE` | not secret: `fcitx` / `@im=fcitx` / `fcitx` / `ibus` (and `GTK_IM_MODULE` must stay **unset** — 2026-09-24 dual-channel fix) |
| `95-qwen-provider.conf` | `QIANWEN_TP_PERSONAL_KEY` `QIANWEN_TP_PERSONAL_BASE_URL` | keys from the Alibaba token-plan console |

Claude Code plumbing (`~/.claude/settings.json` `env` block: `ANTHROPIC_BASE_URL`
=`https://apinebula.ai`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_*_MODEL`) is
seat-specific; template values only, re-seed from the same apinebula console.

---

## 4. Maintenance notes

### The `opencode db` control surface ("dbctl")

`packages/opencode/src/cli/cmd/db.ts`:

* `opencode db path` — prints the resolved DB path. **CAUTION: it initializes
  `Database.Service`, which CREATES and MIGRATES the database as a side effect.**
  Only run it when the DB already exists (verify.sh guards this).
* `opencode db [query]` — runs SQL, or spawns an interactive `sqlite3` shell on
  the resolved path. This is the routine maintenance/query tool.
* Read-only integrity checks without touching the binary: `python3` +
  `sqlite3.connect(f"file:{path}?mode=ro", uri=True)` + `PRAGMA integrity_check`
  (this is what verify.sh does).

### OPENCODE_DB pin rationale

`packages/core/src/database/database.ts:43-54` resolves the DB as:

1. `OPENCODE_DB` set → that name joined onto `Global.Path.data`
   (`~/.local/share/opencode`) when relative — **this wins**;
2. else channel ∈ `{latest,beta,prod}` or `OPENCODE_DISABLE_CHANNEL_DB=1` →
   `opencode.db` (note: NOT the canonical name — do not use this switch here);
3. else `opencode-<channel>.db`.

For a fork build from `main`, (3) already yields `opencode-main.db` — but any
binary built off another branch/checkout forks the name and silently strands
session history. `~/.config/environment.d/10-opencode-db.conf` pins
`OPENCODE_DB=opencode-main.db` so **every** binary lands on the canonical DB.
That pin is the single most load-bearing line in this bundle.

### Retired-DB story

Machine A's `~/.local/share/opencode/` carries the scars of channel forking
(kept as archives, not deleted):

| File | Size (cut date) | Era |
| --- | --- | --- |
| `opencode.db` | 9.7 MB (retired ~Sep 16) | pre-fork / stable-channel era |
| `opencode-local.db` | 258 KB (retired Sep 28) | one build landed with channel `local` → `opencode-local.db` forked |
| `opencode-main.db` | ~1.7 GB (live) | canonical seat DB since consolidation |

Machine B starts clean: one `opencode-main.db`, created on first launch. If a
fork DB ever appears on machine B, the pin was missing at process start —
re-login, do not migrate by hand unless you know which history you want.

### Kill-guard battery maintenance

`~/.config/agent-hooks/{block-unsafe-kill.sh,cases.json,run-cases.sh,run-cases.ts}`
are the shared PreToolUse guard + its regression battery. After editing the
guard:

```sh
bash ~/.config/agent-hooks/run-cases.sh                 # bash port (jq)
bun  ~/.config/agent-hooks/run-cases.ts                 # opencode plugin port
```

`run-cases.ts` resolves the plugin next to itself, trying the *installed*
layout (`../opencode/plugin/block-unsafe-kill.ts`) and the bundle layout
(`../plugin/block-unsafe-kill.ts`), so it runs unchanged from both:

```sh
bash bootstrap/agent-hooks/run-cases.sh
bun  bootstrap/agent-hooks/run-cases.ts
```

An explicit absolute path still works as the first argument (resolved as an
import specifier, so it must be absolute).

### Repo ↔ seat drift

From the fork checkout, `bun run check-drift` compares every file this repo
deploys (dotfiles managed files, `tui.json`, agent-hooks, plugins, the shell
block, the `environment.d` DB pin, the `install-local-tools` set, vendored
skills, skills-extra, and the `bootstrap/config/opencode.jsonc` snapshot)
against the live seat, checks the bundle↔dotfiles goal-file mirrors, and exits
1 on drift. `bootstrap/verify.sh` is the seat-side counterpart.

The config snapshot is what install.sh converges the live config **from**, so
refresh it whenever the live config changes — a stale snapshot would otherwise
overwrite the live file on the next install:

```sh
cp ~/.config/opencode/opencode.jsonc bootstrap/config/opencode.jsonc
```

Wired surfaces (all currently hardcode `/home/eric`; install.sh rewrites to the
target home): `~/.claude/settings.json:20`, `~/.zcode/settings.json:8`,
`~/.grok/hooks/block-unsafe-kill.json` (command field),
`~/.kimi-code/config.toml:69-73`, and the fifth surface is the opencode plugin
port itself `~/.config/opencode/plugin/block-unsafe-kill.ts`.

---

## 5. Precision boundary

**Reproduced exactly**

* Fork binary `0.0.0-main-<ts>` built from branch `main` with the 10
  patchedDependencies, `bun@^1.3.14`, `models.dev` snapshot pinned at build.
* DB consolidation: canonical `opencode-main.db` regardless of channel.
* `opencode.jsonc` semantics (provider/model tracks, plan-agent edit allowlist —
  its plans path is rewritten from `--home` on install).
* The kill-guard battery and its five wirings.
* Plugin set: `block-unsafe-kill.ts`, `mpskills-update.ts`, `secret-path-guard.ts`.
* Orphan skill `longrun-stability-audit`.
* Goal-mode files `agent/goal.md`, `autonomy.md`,
  `AGENTS.goal.md` (when shipped — see bundle layout). There is no `/goal`
  command: goal mode seeds and owns its goal file. Goal reminders and the
  footer segment are fork patches (`SessionReminders`), so a machine-B build
  must come from this repo.
* The `opencode()` wrapper *text* (mouse-garbage TTY fix + egress self-heal),
  machine-A `~/.bashrc` verbatim **except** the egress probe set: 2026-09-30
  it was extended to the default xiaomi provider endpoint
  (`token-plan-cn.xiaomimimo.com`, host from `opencode.jsonc` provider config)
  — the two-endpoint set predates the default-model switch and missed
  xiaomi-only outages.

**Not reproduced (by design or by nature)**

* **Secret values** — re-seed per §3.
* **Glyph rendering** — status glyphs are plain Unicode (`▣` U+25A3, `⎇` U+2387),
  not nerd-font codepoints. U+25A3 has broad coverage; **U+2387 coverage is
  thin** (Adwaita Mono / Noto Sans Symbols). Without pinned fonts the *text
  semantics* still reproduce; only rendering differs.
* **fcitx5 IME surface** — needs the pinned input-method env + desktop stack
  (§3); not required for the seat's text semantics.
* **`plugin/mpskills-update.ts`** — shipped as-is and self-contained: on the
  first `skill` call in a 24h window it fetches the vendored upstream checkout
  under `${HOME}/.cache/opencode/`, re-runs `vendor-skills`, reinstalls to
  `~/.config/opencode/skills`, and commits. It resolves the fork checkout from
  `OPENCODE_FORK_REPO` (default `${HOME}/Documents/Development/private/agent-design/projects/opencode`)
  and reuses that checkout's configured `http.proxy` for the fetch, so a
  censored network needs no extra setup beyond the proxy the fork already has.
* **`plugin/open-code-review.ts`** — shipped as-is from alibaba/open-code-review
  (single-file dual-form plugin; header carries the upstream SHA). Registers
  `ocr_review`/`ocr_health` tools + `/ocr-review`/`/ocr-health` commands and
  spawns `ocr` from PATH, so a target seat must provision the `ocr` CLI
  (`npm install -g @alibaba-group/open-code-review`, its `~/.opencodereview/`
  provider block, and the api_key_cmd credential helper) separately — the
  bundle deliberately ships no ocr config. Its `@opencode-ai/plugin` runtime
  import is converged by the fork's own config loader (background npm install
  into the config dir); upstream's README calls that dependency out explicitly.
* **Egress conditions** — the wrapper assumes mainland-CN reachability
  quirks + a local causeway proxy chain (18880 → 17878). On a box without
  causeway it degrades to direct exec (`command opencode`) after failed probes.

**First-launch silent failure to watch for**

Background `@opencode-ai/plugin` npm install failures are **logged only**. After
first launch check:

```sh
grep -E 'level=ERROR.*message="plugin config hook failed"|level=WARN.*message="background dependency install failed"' \
  ~/.local/share/opencode/log/opencode.log
```

verify.sh runs this sweep every time (WARN level).

---

## 6. Bundle layout

```
bootstrap/
├── README.md                     this file
├── install.sh                    idempotent installer (--dry-run/--home/--link/…)
├── verify.sh                     post-install audit (--home for testing)
├── config/
│   ├── opencode.jsonc            byte-copy of live ~/.config/opencode/opencode.jsonc
│   ├── auth.json.template        4-provider skeleton, placeholder values
│   ├── env.template              2 var NAMES, empty values
│   └── environment.d/
│       ├── 10-opencode-db.conf   the DB pin (real value)
│       ├── 90-fcitx5.conf        names only
│       └── 95-qwen-provider.conf  names only
├── shell/
│   └── bashrc-opencode-block.sh  byte-exact ~/.bashrc extraction + install notes
├── agent-hooks/                  full guard battery (4 files)
├── skills-extra/
│   └── longrun-stability-audit/  SKILL.md + references/
├── plugin/
│   ├── block-unsafe-kill.ts      plugin port of the guard
│   ├── mpskills-update.ts        as-is (self-contained; fetches + vendors on first skill call)
│   ├── secret-path-guard.ts      blocks file tools on credential paths (2026-10-06)
│   ├── open-code-review.ts       ocr tools (ocr_review/ocr_health) + /ocr-review,/ocr-health (2026-10-07)
├── command/                      (empty — the /goal command was removed)
├── agent/                        goal.md (goal agent definition)
├── autonomy.md                   autonomous-execution policy (instructions array)
└── AGENTS.goal.md                goal-mode swarm playbook (instructions array)
```

---

## 7. Provenance

* `config/opencode.jsonc` is a byte-copy of machine A's live
  `~/.config/opencode/opencode.jsonc` at cut time (refreshed 2026-10-08 to the
  deepseek default track). The repo-root `opencode.jsonc` is refreshed from the
  live file too — compare before trusting either:
  `diff ../../opencode.jsonc config/opencode.jsonc`. `bun run check-drift`
  flags the snapshot as drift when the live config moves past it.
* `shell/bashrc-opencode-block.sh` extraction was diff-verified byte-identical
  against `~/.bashrc` lines 111, 210-240, 252-290; the only later deviation is
  the 2026-09-30 probe-set extension (see the file's DEVIATION LOG).
* `agent-hooks/`, `plugin/{block-unsafe-kill.ts,mpskills-update.ts,secret-path-guard.ts,open-code-review.ts}` and
  `skills-extra/` are the portable source of truth: install.sh copies them
  bundle → `~/.config/agent-hooks/`, `~/.config/opencode/plugin/` and
  `~/.config/opencode/skills/`. Edits land in the bundle first and are
  redeployed to the seat copies, which must stay byte-identical afterwards
  (verify.sh WARNs when the installed copies drift from the bundle).
  `autonomy.md` and `AGENTS.goal.md` are byte-copies of
  `dotfiles/opencode/{autonomy.md,AGENTS.goal.md}`.
* No secret values were copied into this bundle (verified: auth.json carries
  placeholders; environment.d templates carry names only).
