# bootstrap/ — opencode seat reproduction bundle

Versioned snapshot of everything needed to **precisely reproduce this opencode
seat** on another Linux machine ("machine B"). Cut from machine A on 2026-09-29.

Source of truth on machine A:

| Item | Path |
| --- | --- |
| fork repo (binary source) | `<checkout>` — machine A keeps it at `/home/eric/Documents/Development/private/agent-design/projects/opencode` (branch `main`); the clone path is arbitrary |
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
| `curl` | manual network diagnostics + `verify.sh` toolchain check | any |
| `sqlite3` | optional, direct DB inspection (`opencode debug paths db` prints the path) | any |
| `ocr` | automatic security gate (`open-code-review` plugin) and manual `code-audit` | **v1.13.1+** — `npm install -g @alibaba-group/open-code-review` |

### Step 1 — clone repos

```sh
# the fork (binary source) — clone onto machine B anywhere
mkdir -p ~/work/agent-design/projects
git clone https://github.com/eric-stone-plus/opencode.git ~/work/agent-design/projects/opencode
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
(cd packages/cli && bun run script/build.ts --single --skip-install)
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
not drift), the vendored `skills/` (`installSkills`, rm+cp), and the mode
architecture (`installGoalConfig`, rm+copyFile): `AGENTS.md` plus both cards
`agent/auto.md` and `agent/goal.md`. All three are **managed** — they converge on
every sync — and the retired `autonomy.md` / `AGENTS.goal.md` are deleted from
the seat. It does NOT touch `plugin/`, `opencode.jsonc`, or `command/*.md`.
`sync-upstream` is the operator's fork updater and can push; do not run it on a
fresh clone. The bundle installer (Step 3) installs the same seat files without
touching git.

### Step 3 — this bundle's installer

```sh
cd ~/work/agent-design/projects/opencode   # wherever bootstrap/ lives
bash bootstrap/install.sh --dry-run        # read the plan first
bash bootstrap/install.sh                  # apply
# test home (every home-specific path is derived from --home; the target must
# exist, so create it first):
mkdir -p /tmp/opencode/fakehome
bash bootstrap/install.sh --home /tmp/opencode/fakehome
# local tools support (drawio/marker/planning): install.sh step 7b installs
# these; this is the manual/idempotent equivalent (e.g., after editing the
# dotfiles/opencode/ sources).
bun run script/install-local-tools.ts
# scratch home: pass the target config dir explicitly
bun run script/install-local-tools.ts /tmp/opencode/fakehome/.config/opencode
```

Flags: `--dry-run`, `--home <path>`, `--user <name>` (legacy, banner only), `--link` (file-symlink
`opencode.jsonc` into the checkout instead of copying), `--no-bashrc`. Idempotent: a second run reports
`0 change(s)` and does nothing. Every overwritten file gets a timestamped
`*.bak.<YYYYmmddHHMMSS>` sibling (the newest 20 per target are kept, oldest
pruned by mtime; only that exact installer-made name is ever pruned, a
hand-made `.bashrc.bak.mine` is never touched); files that must never be
overwritten are listed in §5.

The installer also seeds `~/.config/opencode/cli.json` from the repo root when
the seat has none (TUI keybinds; existing tuning is never overwritten).

### Step 4 — secret entry (the only manual step)

Nothing in this bundle carries secret values. Fill `~/.local/share/opencode/auth.json`
(one provider key: `deepseek`) and the `environment.d` seed files per §3, then:

```sh
# install.sh created the skeleton if auth.json was absent:
ls -l ~/.local/share/opencode/auth.json   # mode 0600
# mode 0600 is converged on every run for auth.json, ~/.config/opencode/env
# and the secret-bearing environment.d drop-ins (content is never touched):
ls -l ~/.config/opencode/env

# V2 keeps credentials in the DB; auth.json is only the seed. Import it once
# from the operator's terminal — never from an agent shell, because this reads
# the credential seed (AGENTS.md "Key hygiene"). auth import takes the array
# shape, not the auth.json object shape; the env -u flags keep a stray session
# token from blocking the --standalone import.
SRC="$HOME/.local/share/opencode/auth.json" bun -e 'const a=JSON.parse(require("fs").readFileSync(process.env.SRC,"utf8")); const k=a.deepseek?.key; if(!k || /^REPLACE_ME/.test(k)) process.exit(1); process.stdout.write(JSON.stringify([{id:"crd_deepseek_seed",integrationID:"deepseek",label:"API key",active:true,value:{type:"key",key:k}}]))' | env -u OPENCODE_SESSION_TOKEN -u OPENCODE_SESSION_ID opencode auth import --standalone
# verify the integration is in the DB (names only, no key values):
env -u OPENCODE_SESSION_TOKEN -u OPENCODE_SESSION_ID opencode auth list --standalone --format json | grep -q deepseek && echo "deepseek credential present"
```

A fresh V2 database skips data migrations (`packages/core/src/database/migration.ts:29-42`),
so filling `auth.json` alone is not enough: without the `auth import` step
`opencode auth list` returns `[]` and the seat has no usable key. The `bun -e`
conversion is the same one `script/sandbox.sh` uses; it prints the key only into
the pipe, never to the terminal.

### Step 4b — OpenCodeReview (automatic security gate + manual audit)

The seat ships the V2 `open-code-review` plugin and the `code-audit` skill, but
the `ocr` CLI and its provider key are machine-local (never vendored):

```sh
npm install -g @alibaba-group/open-code-review   # v1.13.1+
ocr config provider                              # choose deepseek, paste the key
ocr config model                                 # deepseek-flash
ocr llm test                                     # connectivity check
```

`install.sh` installs `plugin/open-code-review.ts` (V2 `{id, setup}`) and every
skill under `bootstrap/skills-extra/` (`code-review-playbook`, `deep-audit`,
`code-audit`, `review-delegate`, `longrun-stability-audit`). `verify.sh` fails
if the plugin is missing, is a V1 `server` export, is a symlink, or if `ocr`
is not on PATH; it also warns when `ocr llm test` cannot reach the configured
provider/model (rerun it after `ocr config provider` / `ocr config model`).
Disable the automatic gate with `OPENCODE_SECURITY_GATE=0`.

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
| 2 | `~/.config/opencode/cli.json` | **only if absent**, from the repo-root `cli.json` (TUI keybinds); never overwrites tuning |
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
| 7 | `plugin/{block-unsafe-kill.ts,secret-path-guard.ts,local-tools.ts,skill-hints.ts,open-code-review.ts}` | copies, as-is; a stale `plugin/mpskills-update.ts` is backed up and removed (skills freeze, 2026-10-16) |
| 8 | `AGENTS.md`, `agent/auto.md`, `agent/goal.md` | all three **managed** (converge on every run; `check-drift` compares them byte-for-byte against this bundle). The retired `autonomy.md` / `AGENTS.goal.md` are deleted from the seat, and `opencode.jsonc` carries no `instructions` array. There is no `command/goal.md`: the `/goal` command was removed |
| 9 | `~/.bashrc` + `~/.config/opencode/shell/bashrc-opencode-block.sh` | the wrapper is copied to the seat config tree and sourced from that stable path (older `source`/`.` lines for it are rewritten in place, never duplicated; commented-out lines are left alone); marked, idempotent block inside an interactive guard; `--no-bashrc` skips |

Explicit non-goals (owned by `script/sync-upstream.ts` or by hand):
`tui.json`, the real binary. The vendored `skills/` set is installed frozen by
`install.sh` step 6b; `sync-upstream` is the managed updater for it.
(`AGENTS.md` and both mode cards are installed by both: same content, same
replace-in-place policy.)

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
`verify.sh` reports a placeholder auth.json as **WARN** while the DB credential is
present (the DB is the live store) and as **FAIL** only when the DB credential is
missing; re-seed from the console on rotation or after a reinstall.

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

### Project trust gate (untrusted repositories)

Opening a repository can execute code at session start with no prompt: a project
`opencode.jsonc`, its `.opencode/plugin/` directory, its `AGENTS.md` chain, and
its MCP/LSP entries are all project-controlled. The gate that decides whether any
of them loads is the **operator's declaration**, not the project:

- `<global config dir>/trusted-roots` — one **absolute** path per line, `#`
  comments. Relative, glob, and `~` lines are ignored *with a reason* (logged as
  a warning at startup); a root that does not exist yet is kept lexically
  ("declare before create"); a symlinked root trusts its resolved target; an
  unreadable file or root means **closed**.
- **No declaration means closed**: project config, the project `AGENTS.md`
  chain, project plugins/MCP, and the read-triggered nested `AGENTS.md` guidance
  are all off. That is the state of a fresh seat — a project cannot authorize
  itself.
- The declaration is read once at server start by the CLI
  (`packages/cli/src/server-process.ts`) and installed through
  `ProjectTrust.node.replace` in `packages/server/src/routes.ts`; the primitive is
  `packages/core/src/fork/project-trust.ts`.

**The escape hatch is the widest setting, not a no-op.** The env override is
three-state (`OPENCODE_CONFIG_PROJECT_DISABLE`, alias
`OPENCODE_DISABLE_PROJECT_CONFIG`):

| value | effect |
| --- | --- |
| unset | project-side discovery on, bounded by the declaration (closed with no declaration) |
| exactly `0` or `false` (trimmed, case-insensitive) | **project: true + trust ALL** — the declaration is ignored, and the read path walks without a bound. This is the historical "project config was never gated" behavior |
| anything else (`1`, `yes`, `on`, `true`, `2`, `no`, `off`, `""`, …) | **project: false** — hard off, regardless of the declaration |

So `=0` is not "re-enable the default"; it is "trust every repository". Set it
only for a shell where every directory is yours. The value is read once when the
server process starts: exporting it later in a client does nothing to an
already-running shared service.

### Updating the vendored skills

The mattpocock set under `skills/` is **frozen** (owner decision 2026-10-16):
nothing refreshes it while the agent runs. `skills/PROVENANCE.md` records the
pinned revision, and `bun run check-drift` compares the installed seat tree
against this checkout, so a hand-edit or a stray refresh shows up as drift.

Updating is an explicit, operator-run task:

```sh
git -C ~/.cache/opencode/mattpocock-upstream fetch origin main
git -C ~/.cache/opencode/mattpocock-upstream checkout <ref>
bun run update-skills --source ~/.cache/opencode/mattpocock-upstream
git diff --stat skills                    # review: vendoring is deterministic
git add skills && git commit -m "chore: vendor mattpocock skills (<ref8>)"
bun run check-drift                       # seat now matches the new pin
```

`update-skills` re-vendors `skills/` from the checkout (re-applying the UNFLAG
and description patches in `script/vendor-skills.ts`), reinstalls it to
`~/.config/opencode/skills/` with the same rm+cp-per-skill policy the sync uses,
and prints the revision plus a commit-message suggestion. It never fetches,
never commits, and never pushes — those are the operator's steps, and
`script/skills-freeze.test.ts` fails if that changes.

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
  (drawio/marker/planning tools), `skill-hints.ts`, `open-code-review.ts` — all
  V2-API. The vendored-skills auto-updater (`mpskills-update.ts`) was **deleted**
  on 2026-10-16: the skill set is frozen and updating it is an explicit operator
  task (§4 "Updating the vendored skills").
* Orphan skill `longrun-stability-audit`.
* Mode architecture (owner decision 2026-10-16): two primary cards,
  `agent/auto.md` (fast problem solving: execute, self-verify with the work's own
  checks, report terse — no swarm) and `agent/goal.md` (flawless delivery
  closure: the adversarial swarm playbook, exhaustive discussion, the
  confirmed/killed/single-source report). The card body **replaces** the harness
  system prompt (`packages/core/src/session/model-request.ts:117-121`), so each
  card carries its own `# Harness` section. The seat rules file `AGENTS.md` is
  now managed too and carries the no-self-evolution rule (the seat is read-only
  during work; no runtime writers; no auto-commits). There is no `/goal`
  command: goal mode seeds and owns its goal file. Goal seeding/steering and the
  mode cards are fork plugins
  (`packages/core/src/plugin/fork/modes.ts`), so a machine-B build must come
  from this repo.
* The `opencode()` wrapper *text* (mouse-garbage TTY fix + TUI-only
  `OPENCODE_SESSION_*` strip) is machine-A `~/.bashrc` verbatim **except** the
  egress probe set, which was removed on 2026-10-22. The wrapper performs no
  launch-time network detection; the shell's `proxy-on`/`proxy-off` environment
  is the only source. The V2 shared service keeps the environment of the client
  that spawned it, so after changing proxies restart the service
  (`opencode service restart`) or start a new one.

**Not reproduced (by design or by nature)**

* **Secret values** — re-seed per §3.
* **fcitx5 IME surface** — needs the pinned input-method env + desktop stack
  (§3); not required for the seat's text semantics.
* **`plugin/mpskills-update.ts`** — **deleted 2026-10-16** (skills freeze). It was
  a V2 port (2026-10-12) that, on the first `skill` call in a 24h window, fetched
  the vendored upstream checkout under `${HOME}/.cache/opencode/`, re-ran
  `vendor-skills`, reinstalled to `~/.config/opencode/skills`, and committed —
  agent-driven self-evolution with no operator in the loop. The replacement is
  the explicit flow in §4 "Updating the vendored skills"
  (`bun run update-skills --source <checkout>`), which never fetches and never
  commits.
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
* **Egress conditions** — the wrapper performs **no launch-time egress probe**.
  The shell's `proxy-on`/`proxy-off` environment and the V2 service environment
  are authoritative; `proxy-on` owns causeway gateway recovery. On a box without
  causeway, run `proxy-off` (or leave the shell env clean) and the wrapper
  starts `opencode` directly.

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
│   └── open-code-review.ts       ocr tools + commands (V2 port, 2026-10-12)
├── agent/                        auto.md + goal.md (mode cards; managed)
└── AGENTS.md                     seat rules incl. the no-self-evolution rule (managed)
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
  against `~/.bashrc` lines 111, 210-240, 252-290; later deviations are recorded
  in the file header and git history (the 2026-09-30 probe-set extension and the
  2026-10-15 V3 `baseURL` probe were both removed on 2026-10-22; the wrapper now
  performs no egress detection).
* `agent-hooks/`, `plugin/{block-unsafe-kill.ts,secret-path-guard.ts,local-tools.ts,skill-hints.ts,mpskills-update.ts,open-code-review.ts}`,
  `skills-extra/`, and the local-tools support files
  (`dotfiles/opencode/lib/drawio.py` + three skill files, deployed by
  `script/install-local-tools.ts`) are the portable source of truth: install.sh copies
  the agent-hooks, plugins, and skills-extra bundle → `~/.config/agent-hooks/`,
  `~/.config/opencode/plugin/`, and `~/.config/opencode/skills/`;
  `script/install-local-tools.ts` deploys the local-tools support files. Edits
  land in the bundle first and are redeployed to the seat copies, which must
  stay byte-identical afterwards (verify.sh WARNs when the installed copies
  drift from the bundle).
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
persisted. The wrapper no longer launches `--standalone`; it starts the shared
service/client with the shell's environment. Because the service keeps the
environment of the client that spawned it, restart the service
(`opencode service restart`) after changing proxies, or the old environment
persists.
