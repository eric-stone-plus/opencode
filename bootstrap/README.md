# bootstrap/ — opencode seat reproduction bundle

Versioned snapshot of everything needed to **precisely reproduce this opencode
seat** on another Linux machine ("machine B"). Cut from machine A on 2026-09-29.

Source of truth on machine A:

| Item | Path |
| --- | --- |
| fork repo (binary source) | `/home/eric/Documents/Development/private/agent-design/projects/opencode` (branch `main`) |
| live config | `~/.config/opencode/opencode.jsonc` |
| canonical DB | `~/.local/share/opencode/opencode-main.db` |

The binary is a fork build `0.0.0-main-<timestamp>`, where the timestamp is the
build time — read it back with `opencode --version` rather than trusting a value
written down here (it changes on every `bun run sync-upstream`). The channel is
derived from `git branch --show-current` (`packages/script/src/index.ts:30`) and
is compiled in at build time (`OPENCODE_CHANNEL` define,
`packages/cli/script/build.ts:188-193`).

---

## 1. Machine-B runbook (ordered)

### Step 0 — deps

| Dep | Why | Version note |
| --- | --- | --- |
| `bun` | build + `run-cases.ts` battery | **1.4.2** — `packageManager: bun@1.4.2` is enforced `^1.4.2` (`packages/script/src/index.ts:6-18`) |
| `jq` | kill-guard script + `run-cases.sh` | any |
| `git` | clone + channel derivation at build | any |
| `python3` | sqlite integrity checks, JSON hook wiring, `_oc_tty_flush_input` | any |
| `curl` | egress probes in the bashrc wrapper | any |
| `sqlite3` | optional, direct DB inspection (`opencode debug paths db` prints the path) | any |

### Step 1 — clone repos

```sh
# the fork (binary source) — clone onto machine B anywhere
git clone <this-repo> ~/work/agent-design/projects/opencode
cd ~/work/agent-design/projects/opencode
git checkout main                       # REQUIRED: see channel note below
```

**Channel discipline (do not skip).** The build bakes the channel in from the
branch name. A build from any channel outside `{latest,dev,beta,next,prod}` makes
the DB filename `opencode-<channel>.db` (`packages/cli/src/database-path.ts:6-11`)
— machine A already collected the scars (`opencode-local.db`, see §4). Build
from `main`, or set `OPENCODE_CHANNEL=main`.

### Step 2 — install + build the binary

```sh
cd ~/work/agent-design/projects/opencode
bun install --frozen-lockfile           # applies the 14 patchedDependencies
cd packages/cli
bun run script/build.ts --single --skip-install
# ^ embeds the committed model catalog (packages/core/src/models-dev/snapshot.txt);
#   no registry fetch at build. Refresh it with
#   `bun run packages/core/script/update-models-snapshot.ts` (https://models.opencode.ai).
```

Then install the binary where the shim expects it (`~/.opencode/bin/opencode`).
Either run the repo's own pipeline (`bun run sync-upstream --no-rebuild` is
*not* enough on a fresh clone — it also needs a clean tree; see the script
header for its fetch/merge semantics), or just copy the build output:

```sh
mkdir -p ~/.opencode/bin
(cd packages/cli && bun run script/build.ts --single --skip-install --skip-web-ui)
cp packages/cli/dist/cli-<platform>-<arch>/bin/opencode ~/.opencode/bin/opencode
chmod 755 ~/.opencode/bin/opencode
```

`script/sync-upstream.ts` additionally installs `~/.config/opencode/cli.json`
(`installTuiConfig`: V2 migrates `tui.json` once and ignores later edits, so it
reads the repo-root `cli.json` and seeds the seat copy only when that file is
absent — the seat keeps its own tuning and `check-drift` reports it as a seed,
not drift), the vendored `skills/` (`installSkills`, rm+cp), and
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
(one provider key: `deepseek`) and the `environment.d` seed files per §3, then:

```sh
# install.sh created the skeleton if auth.json was absent:
ls -l ~/.local/share/opencode/auth.json   # mode 0600
# mode 0600 is converged on every run for auth.json, ~/.config/opencode/env
# and the secret-bearing environment.d drop-ins (content is never touched):
ls -l ~/.config/opencode/env
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
| 2 | `~/.config/opencode/opencode.jsonc` | copy (verbatim) or `--link` symlink; timestamp-backup on overwrite. A plain install over an earlier `--link` replaces the link itself (backed up as a link) — it never writes through a symlink into the checkout; the same holds for every managed file |
| 2 | `~/.local/share/opencode/auth.json` | **only if absent**, from template; mode converged 0600 (content never touched afterwards) |
| 2 | `~/.config/opencode/env` | **only if absent** (re-seed seed file; may hold live seeds); mode converged 0600 |
| 3 | `~/.local/bin/opencode` pin wrapper → `~/.opencode/bin/opencode` | kept when it already is the pin wrapper; any other shim/symlink there is moved aside to `opencode.pre-pin.<TS>` and replaced (sync-upstream never creates the shim) |
| 4 | `environment.d/10-opencode-db.conf` | managed (converges; backup on overwrite) |
| 4 | `environment.d/20-opencode-http.conf` | managed (converges; backup on overwrite) — Bun fetch fan-out for the swarm default |
| 4 | `environment.d/90-fcitx5.conf` | **only if absent**; template carries names only |
| 4 | service config pins (`OPENCODE_DB`, `OPENCODE_DISABLE_MODELS_FETCH`, `BUN_CONFIG_MAX_HTTP_REQUESTS`) | `opencode service set env` for each, then one `service restart`: the service keeps the env of whichever client spawned it, so the pins are persisted in its own config and read at every spawn (writes service config only; never opens the DB) |
| 5 | `~/.config/agent-hooks/*` (4 files) | copy with `sed s\|/home/eric\|$TARGET_HOME\|` |
| 5b | hook surfaces: `~/.claude/settings.json`, `~/.zcode/settings.json`, `~/.grok/hooks/block-unsafe-kill.json`, `~/.kimi-code/config.toml` | **only if the target file exists** (never created wholesale); rewrites the guard *path token* to the target home (wrapper command + args survive) / inserts the stanza unless a `PreToolUse` hook command already runs the guard (a bare mention such as a permissions entry does not count); edits are spliced into the original text, so JSONC comments and trailing commas survive, and a file needing no change is not rewritten (if a splice is impossible the re-serialization is announced with a WARN naming the backup); backup first; the destination keeps its own file mode (a 0600 settings.json is never downgraded) |
| 6 | `skills-extra/` → `~/.config/opencode/skills/` | collision-checked: identical = skip, differing = one timestamped backup + **left in place** (never rm/overwrite; merge by hand) |
| 7 | `plugin/{block-unsafe-kill.ts,secret-path-guard.ts,local-tools.ts,skill-hints.ts,mpskills-update.ts,open-code-review.ts}` | copies, as-is |
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

`~/.local/share/opencode/auth.json` — one entry (V2 imports it once into the
`credential` table of an existing DB; a fresh DB needs `opencode auth import`), each
`{ "type": "api", "key": … }`:

| Provider id (auth.json / opencode.jsonc) | Endpoint | Where the key comes from |
| --- | --- | --- |
| `deepseek` | `api.deepseek.com` (DeepSeek, the only supported vendor) | DeepSeek platform console |

The `bailian-token-plan-personal` and `xiaomi-token-plan-cn` entries were removed
on 2026-10-15 with those vendors (ADR 0010). A removed vendor's key is purged from
the seat with `opencode auth purge <id> --yes --history` (sweeps the credential
store, `auth.json`, env files, `environment.d`, `service*.json`, the systemd user
environment, DB history and tool-output/log copies).

`~/.config/opencode/env` is a seed file only (NOT read by the binary, NOT sourced by
the shell wrapper): keep the provider key there for the auth.json re-seed.
`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` and the other V1 flags have no effect on V2.

`~/.config/environment.d/` templates (names-only in `bootstrap/config/`):

| File | Vars | Re-seed source |
| --- | --- | --- |
| `10-opencode-db.conf` | `OPENCODE_DB=opencode-main.db` | not secret — install.sh writes the real value |
| `20-opencode-http.conf` | `BUN_CONFIG_MAX_HTTP_REQUESTS=4096` | not secret — install.sh writes it; Bun caps in-flight `fetch` at 256 per process by default, and the swarm default fans out past that (DeepSeek allows 2500 concurrent `deepseek-flash` requests per account). The service also pins it (`opencode service set env`), which is what a running service actually inherits |
| `90-fcitx5.conf` | `QT_IM_MODULE` `XMODIFIERS` `SDL_IM_MODULE` `GLFW_IM_MODULE` | not secret: `fcitx` / `@im=fcitx` / `fcitx` / `ibus` (and `GTK_IM_MODULE` must stay **unset** — 2026-09-24 dual-channel fix) |

Claude Code plumbing (`~/.claude/settings.json` `env` block: `ANTHROPIC_BASE_URL`
=`https://apinebula.ai`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_*_MODEL`) is
seat-specific; template values only, re-seed from the same apinebula console.

---

## 4. Maintenance notes

### DB maintenance surface

V2 has no top-level `db` command; `opencode debug paths [name]` prints the
resolved paths, and `db` is one of its literals:

* `opencode debug paths db` — prints the resolved DB path without opening the
  database (the handler reads only the global paths, so it cannot create or
  migrate anything).
* Plain `sqlite3 <path>` is the routine maintenance/query tool now; the
  binary's interactive shell left with the V1 CLI.
* Read-only integrity checks without touching the binary: `python3` +
  `sqlite3.connect(f"file:{path}?mode=ro", uri=True)` + `PRAGMA integrity_check`
  (this is what verify.sh does).

### OPENCODE_DB pin rationale

`packages/cli/src/database-path.ts:6-11` resolves the DB as:

1. `OPENCODE_DB` set → that name joined onto `Global.Path.data`
   (`~/.local/share/opencode`) when relative — **this wins**;
2. else channel ∈ `{latest,dev,beta,next,prod}` or
   `OPENCODE_DISABLE_CHANNEL_DB` set to `1` or `true` →
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

Both retired files live under `~/.local/share/opencode/retired-20260929/`, not in
the data directory root.
| `opencode-main.db` | ~3.5 GB (2026-10-14; ~1.7 GB at cut) | canonical seat DB since consolidation |

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
deploys (dotfiles managed files, `cli.json`, agent-hooks, plugins, the shell
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

* Fork binary `0.0.0-main-<ts>` built from branch `main` with the 14
  patchedDependencies, `bun@^1.4.2`, the committed `models.dev` snapshot.
* DB consolidation: canonical `opencode-main.db` regardless of channel.
* `opencode.jsonc` semantics (provider/model tracks, the two-profile agent block
  with the auto/goal colors).
* The kill-guard battery and its five wirings.
* Plugin set: `block-unsafe-kill.ts`, `secret-path-guard.ts`, `local-tools.ts`
  (drawio/marker/planning tools), `skill-hints.ts`, `mpskills-update.ts`,
  `open-code-review.ts` — all V2-API.
* Orphan skill `longrun-stability-audit`.
* Goal-mode files `agent/goal.md`, `autonomy.md`,
  `AGENTS.goal.md` (when shipped — see bundle layout). There is no `/goal`
  command: goal mode seeds and owns its goal file. The swarm playbook is the
  default for **both** primaries: goal's prompt body names it, and auto's
  standing card carries the same mandate, so an auto session fans out instead
  of working single-threaded. Goal seeding/steering and
  the mode cards are fork plugins (`packages/core/src/plugin/fork/modes.ts`),
  so a machine-B build must come from this repo.
* The `opencode()` wrapper *text* (mouse-garbage TTY fix + egress self-heal),
  machine-A `~/.bashrc` verbatim **except** the egress probe set: since
  2026-10-15 V3 it extracts every `baseURL` from `opencode.jsonc` and probes
  them with an AND gate (direct only when all pass), so it adapts to whatever
  provider set the config declares; with the DeepSeek-only config that is one
  endpoint (`api.deepseek.com`).

**Not reproduced (by design or by nature)**

* **Secret values** — re-seed per §3.
* **fcitx5 IME surface** — needs the pinned input-method env + desktop stack
  (§3); not required for the seat's text semantics.
* **`plugin/mpskills-update.ts`** — V2 port (2026-10-12), self-contained: on the
  first `skill` call in a 24h window it fetches the vendored upstream checkout
  under `${HOME}/.cache/opencode/`, re-runs `vendor-skills`, reinstalls to
  `~/.config/opencode/skills`, and commits. It resolves the fork checkout from
  `OPENCODE_FORK_REPO` (default `${HOME}/Documents/Development/private/agent-design/projects/opencode`)
  and reuses that checkout's configured `http.proxy` for the fetch, so a
  censored network needs no extra setup beyond the proxy the fork already has.
* **`plugin/open-code-review.ts`** — V2 port (2026-10-12) of alibaba/open-code-review
  (header carries the upstream SHA and the local modification list). Registers
  `ocr_review`/`ocr_health` tools + `/ocr-review`/`/ocr-health` commands and
  spawns `ocr` from PATH, so a target seat must provision the `ocr` CLI
  (`npm install -g @alibaba-group/open-code-review`, its `~/.opencodereview/`
  provider block, and the api_key_cmd credential helper) separately — the
  bundle deliberately ships no ocr config. The port has no runtime package
  imports (the V1 `@opencode-ai/plugin` dependency is gone), so the config
  loader's background npm install is no longer needed for it.
* **`plugin/skill-hints.ts`** — V2 port (2026-10-12) of the V1 skill-hints
  plugin: compaction and PDF nudges ride on system parts instead of synthetic
  parts; texts and scan bounds are byte-identical to V1.
* **Egress conditions** — the wrapper assumes mainland-CN reachability
  quirks + a local causeway proxy chain (18880 → 17878). On a box without
  causeway it degrades to direct exec (`command opencode`) after failed probes.

**First-launch silent failure to watch for**

A plugin that fails to load or reload is **logged only**. After first launch check:

```sh
grep -E 'level=(WARN|ERROR).*message="(failed to load plugin|failed to reload plugins|configured plugin watch failed)"' \
  ~/.local/share/opencode/log/opencode.log
```

verify.sh runs this sweep every time (WARN level). The V1 pair this used to watch
(`plugin config hook failed`, `background dependency install failed`) has no
producer left in the V2 tree — the plugin supervisor warns on a load failure
(`packages/core/src/plugin/supervisor.ts:63`), errors on a reload failure
(`:239`), and the config loader errors on a failed plugin watch
(`packages/core/src/config/plugin/source.ts:67`).

---

## 6. Bundle layout

```
bootstrap/
├── README.md                     this file
├── install.sh                    idempotent installer (--dry-run/--home/--link/…)
├── verify.sh                     post-install audit (--home for testing)
├── config/
│   ├── opencode.jsonc            byte-copy of live ~/.config/opencode/opencode.jsonc
│   ├── auth.json.template        1-provider skeleton (deepseek), placeholder values
│   ├── env.template              1 var NAME, empty value
│   └── environment.d/
│       ├── 10-opencode-db.conf   the DB pin (real value)
│       ├── 20-opencode-http.conf BUN_CONFIG_MAX_HTTP_REQUESTS (fan-out)
│       └── 90-fcitx5.conf        names only
├── shell/
│   └── bashrc-opencode-block.sh  byte-exact ~/.bashrc extraction + install notes
├── agent-hooks/                  full guard battery (4 files)
├── skills-extra/
│   ├── longrun-stability-audit/  SKILL.md + references/
│   └── review-delegate/          SKILL.md + scripts/build-review-spec.ts
├── plugin/
│   ├── block-unsafe-kill.ts      plugin port of the guard
│   ├── secret-path-guard.ts      blocks file tools on credential paths (2026-10-06)
│   ├── local-tools.ts            drawio/marker/planning tools (V2 port, 2026-10-12)
│   ├── skill-hints.ts            compaction/PDF nudges as system parts (V2 port, 2026-10-12)
│   ├── mpskills-update.ts        vendored-skills refresh on skill calls (V2 port, 2026-10-12)
│   └── open-code-review.ts       ocr tools + commands (V2 port, 2026-10-12)
├── agent/                        goal.md (goal agent definition)
├── autonomy.md                   autonomous-execution policy (instructions array)
└── AGENTS.goal.md                swarm playbook — default for auto and goal (instructions array)
```

---

## 7. Provenance

* `config/opencode.jsonc` is a byte-copy of machine A's live
  `~/.config/opencode/opencode.jsonc` at cut time (refreshed 2026-10-15; the
  deepseek default track landed 2026-10-08). The repo-root `opencode.jsonc` is
  refreshed from the live file too — compare before trusting either:
  `diff ../../opencode.jsonc config/opencode.jsonc`. `bun run check-drift`
  flags the snapshot as drift when the live config moves past it.
* `shell/bashrc-opencode-block.sh` extraction was diff-verified byte-identical
  against `~/.bashrc` lines 111, 210-240, 252-290; later deviations are logged in
  the file's DEVIATION LOG (2026-09-30 probe-set extension, 2026-10-15 V3 — the
  probe set is derived from the config's `baseURL`s — and the DeepSeek-only
  convergence that followed).
* `agent-hooks/`, `plugin/{block-unsafe-kill.ts,secret-path-guard.ts,local-tools.ts,skill-hints.ts,mpskills-update.ts,open-code-review.ts}`,
  `skills-extra/`, and the local-tools support files
  (`dotfiles/opencode/lib/drawio.py` + three skill files, deployed by
  `script/install-local-tools.ts`) are the portable source of truth: install.sh copies them
  bundle → `~/.config/agent-hooks/`, `~/.config/opencode/plugin/` and
  `~/.config/opencode/skills/`. Edits land in the bundle first and are
  redeployed to the seat copies, which must stay byte-identical afterwards
  (verify.sh WARNs when the installed copies drift from the bundle).
  `autonomy.md` and `AGENTS.goal.md` are byte-copies of
  `dotfiles/opencode/{autonomy.md,AGENTS.goal.md}`.
* No secret values were copied into this bundle (verified: auth.json carries
  placeholders; environment.d templates carry names only).

---

## Service model (V2, decided 2026-10-12)

Default = the shared background service (`opencode serve --service`), not
`--standalone`. Measured with tmux from the sandbox HOME (fresh DB, linux-x64
build, time from launch to the prompt on screen): standalone 1.73 s and 2.02 s,
service cold start 2.06 s, service warm 1.52 s. With the real 3.5 GB DB the gap
widens, because a standalone launch boots a private server (DB open, migrations,
catalog load) every time while a warm service already did. One service is also one
SQLite writer instead of one per open TUI.

The service keeps the environment of the client that spawned it, so the pins must
not depend on who spawns it: `~/.local/bin/opencode` exports `OPENCODE_DB` and
`OPENCODE_DISABLE_MODELS_FETCH`, and `install.sh` step 4 persists three —
`OPENCODE_DB`, `OPENCODE_DISABLE_MODELS_FETCH`, `BUN_CONFIG_MAX_HTTP_REQUESTS` —
with `opencode service set env` (read at every spawn). Proxies are deliberately NOT
persisted: the `opencode()` bash wrapper launches a proxied TUI session with
`--standalone`, so a recovered direct connection needs no cleanup.
