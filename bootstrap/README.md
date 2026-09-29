# bootstrap/ — opencode seat reproduction bundle

Versioned snapshot of everything needed to **precisely reproduce this opencode
seat** on another Linux machine ("machine B"). Cut from machine A on 2026-09-29.

Source of truth on machine A:

| Item | Path |
| --- | --- |
| fork repo (binary source) | `/home/eric/Documents/Development/private/agent-design/projects/opencode` (branch `main`) |
| motoko checkout (optional plugin) | `/home/eric/Documents/Development/private/agent-design/projects/motoko` |
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

# optional: only if you want the motoko plugin / motoko-seat-ops skills
git clone <motoko-repo> ~/work/agent-design/projects/motoko
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
header for its fetch/rebase semantics), or just copy the build output:

```sh
mkdir -p ~/.opencode/bin
cp packages/opencode/dist/<platform-arch>/bin/opencode ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
```

`script/sync-upstream.ts` additionally installs `~/.config/opencode/tui.json`
(:162-168), the vendored `skills/` (:197-214, rm+cp), `command/goal.md` +
`AGENTS.goal.md` (:218-248, rm+copyFile) and seeds `agent/goal.md`. It does NOT
touch `plugin/`, `opencode.jsonc`, `AGENTS.md`, `autonomy.md`, or any other
`command/*.md` / `agent/*.md`. Run it if you want its pieces; this bundle does
not duplicate them.

### Step 3 — this bundle's installer

```sh
cd ~/work/agent-design/projects/opencode   # wherever bootstrap/ lives
bash bootstrap/install.sh --dry-run        # read the plan first
bash bootstrap/install.sh                  # apply
# non-default username / test home:
bash bootstrap/install.sh --user bob --home /tmp/opencode/fakehome
```

Flags: `--dry-run`, `--home <path>`, `--user <name>`, `--link` (file-symlink
`opencode.jsonc` into the checkout instead of copying), `--motoko-plugin <path>`
(motoko symlink target), `--no-bashrc`. Idempotent: a second run reports
`0 change(s)` and does nothing. Every overwritten file gets a timestamped
`*.bak.<YYYYmmddHHMMSS>` sibling; files that must never be overwritten are
listed in §5.

### Step 4 — secret entry (the only manual step)

Nothing in this bundle carries secret values. Fill `~/.local/share/opencode/auth.json`
(four provider keys) and the `environment.d` seed files per §3, then:

```sh
# install.sh created the skeleton if auth.json was absent:
ls -l ~/.local/share/opencode/auth.json   # mode 0600
```

### Step 5 — verify

```sh
bash bootstrap/verify.sh                  # or: --home /tmp/opencode/fakehome
```

PASS/WARN/FAIL per check; exit 1 on any FAIL. Then **re-login** (or restart the
systemd user session) so `environment.d` is loaded, and start `opencode`.
Verify the wrapper is live with `type opencode` (must show a *function*).

---

## 2. What install.sh does (and refuses to do)

| Step | Target | Policy |
| --- | --- | --- |
| 1 | dirs under `~/.config/opencode`, `~/.config/environment.d`, `~/.config/agent-hooks`, `~/.local/bin` | create if missing |
| 2 | `~/.config/opencode/opencode.jsonc` | copy (+ username sed) or `--link` symlink; timestamp-backup on overwrite |
| 2 | `~/.local/share/opencode/auth.json` | **only if absent**, from template; chmod 600; never touched afterwards |
| 2 | `~/.config/opencode/env` | **only if absent** (re-seed seed file; may hold live seeds) |
| 3 | `~/.local/bin/opencode` shim → `~/.opencode/bin/opencode` | only if absent (sync-upstream never creates the shim) |
| 4 | `environment.d/10-opencode-db.conf` | managed (converges; backup on overwrite) |
| 4 | `environment.d/{90-fcitx5,95-quinte-provider,motoko-home,motoko-keys}.conf` | **only if absent**; templates carry names only |
| 5 | `~/.config/agent-hooks/*` (4 files) | copy with `sed s\|/home/eric\|$TARGET_HOME\|` |
| 5b | hook surfaces: `~/.claude/settings.json`, `~/.zcode/settings.json`, `~/.grok/hooks/block-unsafe-kill.json`, `~/.kimi-code/config.toml` | **only if the target file exists** (never created wholesale); rewrites the guard path to the target home / inserts the stanza when absent; backup first |
| 6 | `skills-extra/` → `~/.config/opencode/skills/` | collision-checked: identical = skip, differing = one timestamped backup + **left in place** (never rm/overwrite; merge by hand) |
| 7 | `plugin/{block-unsafe-kill.ts,mpskills-update.ts}` | copies, as-is (see §5) |
| 7 | `plugin/motoko.ts` | **file-symlink** to the motoko checkout (dangling = non-fatal, warned) |
| 8 | `command/`, `agent/` goal files | only those shipped in the bundle |
| 9 | `~/.bashrc` | marked, idempotent `source` line for `shell/bashrc-opencode-block.sh` inside an interactive guard; `--no-bashrc` skips |

Explicit non-goals (owned by `script/sync-upstream.ts` or by hand):
`tui.json`, the vendored `skills/` set, `command/goal.md`, `AGENTS.goal.md`,
`AGENTS.md`, `autonomy.md`, the real binary.

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
| `bailian-token-plan-personal` | `token-plan.cn-beijing.maas.aliyuncs.com` (Alibaba Cloud Model Studio) | `QIANWEN_TP_PERSONAL_KEY` — machine A's seed lives in `~/.config/opencode/env` (byte-identical to the auth.json entry; verified by comparison) and is mirrored in `environment.d/95-quinte-provider.conf` |
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
| `95-quinte-provider.conf` | `QIANWEN_TP_PERSONAL_KEY` `QIANWEN_TP_PERSONAL_BASE_URL` `QUINTE_PROVIDER_KEY_ENV` `QUINTE_PROVIDER_BASE_URL_ENV` | keys from the Alibaba token-plan console; `_ENV` vars carry env-var *names* |
| `motoko-home.conf` | `MOTOKO_HOME` | motoko checkout root (non-secret path) |
| `motoko-keys.conf` | `MOTOKO_REFLECTOR_*` `MOTOKO_LLM_*` `GLM_API_KEY` | GLM/Zhipu console + motoko setup; all literals (`environment.d` performs no command substitution); `GLM_API_KEY` rotated 2026-09-27 |

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

`run-cases.ts` resolves the plugin at `../opencode/plugin/block-unsafe-kill.ts`
relative to itself (correct in the *installed* layout). From this bundle copy
pass the path explicitly:
`bun bootstrap/agent-hooks/run-cases.ts bootstrap/plugin/block-unsafe-kill.ts`.

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
  username-sed on install).
* The kill-guard battery and its five wirings.
* Plugin set: `block-unsafe-kill.ts`, `mpskills-update.ts`, `motoko.ts` symlink.
* Orphan skills `longrun-stability-audit`, `motoko-seat-ops`.
* Goal-mode files `command/goal.md`, `agent/goal.md` (when shipped —
  see bundle layout). `/goal edit <text>` support is a fork-binary patch
  (`SessionPrompt.command`), so a machine-B build must come from this repo.
* The `opencode()` wrapper *text* (mouse-garbage TTY fix + egress self-heal),
  byte-exact from machine A's `~/.bashrc`.

**Not reproduced (by design or by nature)**

* **Secret values** — re-seed per §3.
* **Glyph rendering** — status glyphs are plain Unicode (`▣` U+25A3, `⎇` U+2387),
  not nerd-font codepoints. U+25A3 has broad coverage; **U+2387 coverage is
  thin** (Adwaita Mono / Noto Sans Symbols). Without pinned fonts the *text
  semantics* still reproduce; only rendering differs.
* **fcitx5 IME surface** — needs the pinned input-method env + desktop stack
  (§3); not required for the seat's text semantics.
* **`plugin/motoko.ts` content** — a live symlink into the motoko checkout;
  clone motoko and pass `--motoko-plugin`, or accept the dangling symlink
  (non-fatal: startup continues with a logged plugin error).
* **`plugin/mpskills-update.ts` target** — shipped as-is and *hardcodes*
  `/home/eric/.local/bin/mpskills-update`. On machine B its config hook errors
  are swallowed (`plugin config hook failed` in the log) unless you create that
  path or edit the plugin. Known hazard, kept verbatim on purpose.
* **Egress conditions** — the wrapper assumes mainland-CN reachability
  quirks + a local causeway proxy chain (18880 → 17878). On a box without
  causeway it degrades to direct exec (`command opencode`) after failed probes.

**First-launch silent failure to watch for**

Background `@opencode-ai/plugin` npm install failures are **logged only**. After
first launch check:

```sh
grep -E 'plugin config hook failed|background dependency install failed' \
  ~/.local/share/opencode/log/opencode.log
```

verify.sh runs this sweep every time (WARN level).

---

## 6. Bundle layout

```
bootstrap/
├── README.md                     this file
├── install.sh                    idempotent installer (--dry-run/--home/--user/…)
├── verify.sh                     post-install audit (--home for testing)
├── config/
│   ├── opencode.jsonc            byte-copy of live ~/.config/opencode/opencode.jsonc
│   ├── auth.json.template        4-provider skeleton, placeholder values
│   ├── env.template              2 var NAMES, empty values
│   └── environment.d/
│       ├── 10-opencode-db.conf   the DB pin (real value)
│       ├── 90-fcitx5.conf        names only
│       ├── 95-quinte-provider.conf  names only
│       ├── motoko-home.conf      names only
│       └── motoko-keys.conf      names only
├── shell/
│   └── bashrc-opencode-block.sh  byte-exact ~/.bashrc extraction + install notes
├── agent-hooks/                  full guard battery (4 files)
├── skills-extra/
│   ├── longrun-stability-audit/  SKILL.md + references/
│   └── motoko-seat-ops/          SKILL.md
├── plugin/
│   ├── block-unsafe-kill.ts      plugin port of the guard
│   ├── mpskills-update.ts        as-is (hardcodes /home/eric)
│   └── MOTOKO_SYMLINK.txt        symlink target record (TARGET: line)
├── command/                      goal.md (template with /goal edit rules)
└── agent/                        goal.md (goal agent definition)
```

---

## 7. Provenance

* `config/opencode.jsonc` is a byte-copy of machine A's live
  `~/.config/opencode/opencode.jsonc` at cut time (291 lines). The repo-root
  `opencode.jsonc` was being refreshed in parallel to match it — compare before
  trusting either: `diff ../../opencode.jsonc config/opencode.jsonc`.
* `shell/bashrc-opencode-block.sh` extraction was diff-verified byte-identical
  against `~/.bashrc` lines 111, 210-240, 252-290.
* `agent-hooks/`, `plugin/{block-unsafe-kill.ts,mpskills-update.ts}` and
  `skills-extra/` are byte-copies of the machine-A files named above.
* No secret values were copied into this bundle (verified: auth.json carries
  placeholders; environment.d templates carry names only).
