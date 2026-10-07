#!/usr/bin/env bash
# install.sh — reproduce the opencode seat from this bootstrap bundle (machine B).
#
# Idempotent: re-running converges and reports every file as created / changed /
# unchanged. Never deletes user data; every overwrite gets a timestamped backup.
#
# Usage:
#   bash install.sh [options]
#     --dry-run              print every action, change nothing
#     --home <path>          target home (default: $HOME). Use a scratch dir for
#                            testing; NEVER point this at the wrong home.
#     --user <name>          legacy, display only (banner). The opencode.jsonc
#                            plans allowlist paths are rewritten from --home now.
#     --link                 file-symlink config/opencode.jsonc into place instead
#                            of copying (live-edit into the checkout). Never used
#                            for skills/ or command/ (directory symlinks there are
#                            forbidden: sync-upstream rm+cp's from the same tree).
#     --no-bashrc            do not touch ~/.bashrc (skips the egress/TTY wrapper).
#
# What it installs (see README for the full runbook):
#   1  dirs ~/.config/opencode/{plugin,command,agent} ~/.config/environment.d
#      ~/.config/agent-hooks ~/.local/bin
#   2  config: opencode.jsonc (copy + plans-path sed from --home, or --link), auth.json (template,
#      only if absent), env (template, only if absent)
#   3  ~/.local/bin/opencode pin wrapper (OPENCODE_DB=opencode-main.db +
#      OPENCODE_EXPERIMENTAL_PLAN_MODE=1 -> exec binary)
#   4  environment.d/10-opencode-db.conf (managed) + the other *.conf templates
#      (only if absent, never overwritten)
#   5  agent-hooks battery (4 files) + wiring of the 5 guard surfaces
#      (4 hook configs IF they exist; the opencode plugin port via step 7)
#   6  skills-extra/ collision-checked copy (never rm's an existing skill)
#   7  plugin/: block-unsafe-kill.ts + mpskills-update.ts + secret-path-guard.ts
#      + open-code-review.ts copies
#   8  command/ + agent/ goal files (only those shipped in the bundle),
#      autonomy.md + AGENTS.goal.md (the `instructions` files; managed)
#   9  shell/bashrc-opencode-block.sh copied to ~/.config/opencode/shell/ and
#      sourced from that stable seat path (interactive-only; --no-bashrc skips
#      the ~/.bashrc edit; older bundle-path source lines are rewritten in
#      place, never duplicated).
#
# POSIX-ish bash; needs: bash, cp, cmp, sed, python3 (JSON hook wiring).

set -eu

BOOTSTRAP_DIR=$(cd "$(dirname "$0")" && pwd -P)
DRY_RUN=0
TARGET_HOME="${HOME:-}"
SED_USER="${USER:-$(id -un 2>/dev/null || echo unknown)}"
LINK_MODE=0
NO_BASHRC=0

usage() {
  cat <<'EOF'
install.sh — reproduce the opencode seat from this bootstrap bundle.

  --dry-run              print every action, change nothing
  --home <path>          target home (default: $HOME); use a scratch dir to test
  --user <name>          legacy, display only (plans paths derive from --home)
  --link                 file-symlink config/opencode.jsonc into place (live-edit)
  --no-bashrc            do not touch ~/.bashrc
  -h, --help             this text

See README.md for the full runbook and the precision boundary.
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --home) TARGET_HOME="${2:?--home needs a path}"; shift ;;
    --user) SED_USER="${2:?--user needs a name}"; shift ;;
    --link) LINK_MODE=1 ;;
    --no-bashrc) NO_BASHRC=1 ;;
    -h|--help) usage 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage 1 ;;
  esac
  shift
done

[ -n "$TARGET_HOME" ] || { echo "install.sh: empty target home" >&2; exit 1; }
# Normalize trailing slashes: `--home /h/` must produce the same paths (and the
# same exact-match .bashrc source line) as `--home /h`, or every later run
# re-converges and verify.sh sees the `//` form as foreign wiring.
while [ "$TARGET_HOME" != "/" ] && [ "${TARGET_HOME%/}" != "$TARGET_HOME" ]; do
  TARGET_HOME="${TARGET_HOME%/}"
done
[ -d "$TARGET_HOME" ] || { echo "install.sh: target home is not a directory: $TARGET_HOME" >&2; exit 1; }

SEAT_HOME="${TARGET_HOME#/}"

sed_re_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

TS=$(date +%Y%m%d%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

ACTIONS=0
LAST_BACKUP=""
CHANGES=0
WOULD=0

say() { printf '%s\n' "$*"; }
act() { ACTIONS=$((ACTIONS + 1)); if [ "$DRY_RUN" -eq 1 ]; then printf 'DRY-RUN: %s\n' "$*"; else printf 'DO: %s\n' "$*"; fi; }
note() { printf '     %s\n' "$*"; }
# Dry-run must not inflate the applied-change tally: it counts a separate
# "would change" figure so the summary stays truthful.
changed() {
  if [ "$DRY_RUN" -eq 1 ]; then WOULD=$((WOULD + 1)); else CHANGES=$((CHANGES + 1)); fi
}
write_wrapper() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  cat > "$SHIM" <<'WRAP'
#!/usr/bin/env bash
# Anti-fork pin: the binary names its SQLite DB after its build channel
# (packages/core/src/database/database.ts path(): channel not in
# latest|beta|prod -> opencode-<channel>.db). Force the canonical DB for
# every launch flavor, including non-interactive PATH lookups that never
# see environment.d. Managed by bootstrap/install.sh.
export OPENCODE_DB=opencode-main.db
# The four-profile config (plan allows plan_exit, edits only plan files) is
# written for the plan-file workflow, which is gated on this flag
# (packages/opencode/src/tool/registry.ts): without it plan_exit does not
# exist and plan is prompt-only.
export OPENCODE_EXPERIMENTAL_PLAN_MODE=1
exec "$HOME/.opencode/bin/opencode" "$@"
WRAP
  chmod +x "$SHIM"
}

ensure_dir() {
  if [ -d "$1" ]; then note "unchanged dir $1"; else act "mkdir -p $1"; [ "$DRY_RUN" -eq 1 ] || mkdir -p "$1"; changed; fi
}

backup_file() {
  # timestamped backup of anything we are about to overwrite
  # (a symlink, dangling or not, is backed up as the link itself: -P never
  # follows it, so the backup records where it pointed).
  local f="$1" b
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then return 0; fi
  b="$f.bak.$TS"
  if [ -e "$b" ] || [ -L "$b" ]; then b="$b.$$"; fi
  act "backup $f -> $(basename "$b")"
  LAST_BACKUP="$b"
  if [ "$DRY_RUN" -eq 0 ]; then
    cp -pP "$f" "$b"
    prune_backups "$f"
  fi
}

prune_backups() {
  # Keep at most 20 timestamped backups per target; drop the oldest by mtime.
  # Only names backup_file itself produces count (<f>.bak.<14 digits>, with an
  # optional .<pid> collision suffix): a user's own `.bashrc.bak.precious` is
  # not ours to delete.
  local f="$1" keep=20 b i excess suffix
  local -a baks=() old_first=()
  for b in "$f".bak.[0-9]*; do
    [ -e "$b" ] || [ -L "$b" ] || continue
    suffix="${b#"$f".bak.}"
    [[ "$suffix" =~ ^[0-9]{14}(\.[0-9]+)?$ ]] || continue
    baks+=("$b")
  done
  if [ "${#baks[@]}" -le "$keep" ]; then return 0; fi
  while IFS= read -r b; do
    if [ -n "$b" ]; then old_first+=("$b"); fi
  done < <(for b in "${baks[@]}"; do printf '%s\t%s\n' "$(stat -c '%Y' "$b")" "$b"; done | sort -n | cut -f2-)
  excess=$(( ${#baks[@]} - keep ))
  for (( i = 0; i < excess; i++ )); do
    rm -f -- "${old_first[$i]}"
  done
}

require_private() {
  # Secret seed files must never be group/world-readable. Content is untouched
  # (pre-existing seeds may hold live values); only the mode converges to 0600.
  # A symlinked seed is judged (and tightened) at its target; -e is false for a
  # dangling one, which is skipped instead of aborting the run under set -e.
  local f="$1" mode
  if [ ! -e "$f" ]; then return 0; fi
  mode=$(stat -L -c '%a' "$f" 2>/dev/null) || return 0
  if [ -z "$mode" ]; then return 0; fi
  if [ "$(( 8#$mode & 077 ))" -ne 0 ]; then
    act "chmod 600 $f (secret seed was mode $mode)"
    if [ "$DRY_RUN" -eq 0 ]; then chmod 600 "$f"; fi
    changed
  fi
}

# stage SRC through optional sed(1) expressions in "$STAGE_SED" (newline list),
# then converge onto DST. Overwrite policy: timestamp-backup first.
install_file() {
  local src="$1" dst="$2" stage="$WORK/stage.$RANDOM.$$"
  if [ ! -f "$src" ]; then
    say "SKIP  missing bundle file: $src"
    STAGE_SED=""
    return 0
  fi
  cp -p "$src" "$stage"
  if [ -n "${STAGE_SED:-}" ]; then
    sed -i "$STAGE_SED" "$stage"
  fi
  if [ -L "$dst" ]; then
    # Never write THROUGH a symlink: after an `install.sh --link` run (or a
    # user's own link into some checkout) a plain cp would rewrite the link
    # target — e.g. the tracked bundle opencode.jsonc gets this home's path
    # sed'd in and loses the `home/eric` anchor every later install relies on.
    # A dangling link is the same case (cp refuses to write through it and
    # set -e would abort mid-install). Replace the link itself; the backup
    # keeps the link, its target is left untouched.
    act "replace symlink $dst (-> $(readlink "$dst")) with a copy of ${src#"$BOOTSTRAP_DIR"/}"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$dst"
      rm -f "$dst"
      cp -p "$stage" "$dst"
    else
      note "(would back up the link itself first; its target is never written)"
    fi
    changed
  elif [ ! -e "$dst" ]; then
    act "create $dst (from ${src#"$BOOTSTRAP_DIR"/})"
    # New file: cp -p stamps the bundle template's mode (intended — templates
    # carry the perms they want; secret seeds are tightened by require_private).
    [ "$DRY_RUN" -eq 1 ] || { ensure_dir_quiet "$(dirname "$dst")"; cp -p "$stage" "$dst"; }
    changed
  elif cmp -s "$stage" "$dst"; then
    note "unchanged $dst"
  else
    act "update $dst (from ${src#"$BOOTSTRAP_DIR"/})"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$dst"
      # Plain cp (no -p): the existing destination keeps its own mode; its
      # permissions must not be restamped from the bundle template.
      cp "$stage" "$dst"
    else
      note "(would timestamp-backup the existing file first)"
    fi
    changed
  fi
  rm -f "$stage"
  STAGE_SED=""
}

ensure_dir_quiet() { [ -d "$1" ] || mkdir -p "$1"; }

# --- 1. dirs -----------------------------------------------------------------
say "== bootstrap seat install =="
say "target home : $TARGET_HOME"
say "username    : $SED_USER (display only)"
say "bundle      : $BOOTSTRAP_DIR"
[ "$DRY_RUN" -eq 1 ] && say "mode        : DRY-RUN (no changes will be made)"
say ""
say "-- step 1: directories"
for d in "$TARGET_HOME/.config/opencode/plugin" "$TARGET_HOME/.config/opencode/command" \
         "$TARGET_HOME/.config/opencode/agent" "$TARGET_HOME/.config/opencode/skills" \
         "$TARGET_HOME/.config/opencode/shell" "$TARGET_HOME/.config/environment.d" \
         "$TARGET_HOME/.config/agent-hooks" "$TARGET_HOME/.local/bin"; do
  ensure_dir "$d"
done

# --- 2. config files ---------------------------------------------------------
say ""
say "-- step 2: config files"
CFG="$TARGET_HOME/.config/opencode"
DATA="$TARGET_HOME/.local/share/opencode"

if [ "$LINK_MODE" -eq 1 ]; then
  dst="$CFG/opencode.jsonc"
  want="$BOOTSTRAP_DIR/config/opencode.jsonc"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$want" ]; then
    note "unchanged symlink $dst"
  else
    if [ -e "$dst" ] || [ -L "$dst" ]; then
      act "replace $dst with symlink -> $want"
      if [ "$DRY_RUN" -eq 0 ]; then backup_file "$dst"; rm -f "$dst"; ln -s "$want" "$dst"; fi
    else
      act "symlink $dst -> $want"
      [ "$DRY_RUN" -eq 1 ] || ln -s "$want" "$dst"
    fi
    changed
    note "NOTE: --link keeps the bundle copy byte-identical (no sed rewrite);"
    note "      the plans allowlist is user-agnostic, so nothing needs patching."
  fi
else
  STAGE_SED="s|home/eric/.local/share/opencode/plans/|$(sed_re_escape "$SEAT_HOME")/.local/share/opencode/plans/|"
  install_file "$BOOTSTRAP_DIR/config/opencode.jsonc" "$CFG/opencode.jsonc"
fi

# auth.json: template, only when absent. Never touch an existing one (holds keys).
# Lives in the DATA dir (~/.local/share/opencode), not the config dir.
if [ -L "$DATA/auth.json" ] && [ ! -e "$DATA/auth.json" ]; then
  say "WARN  $DATA/auth.json is a dangling symlink -> $(readlink "$DATA/auth.json") (left as-is; secrets are never overwritten)"
elif [ -e "$DATA/auth.json" ]; then
  note "unchanged $DATA/auth.json (exists; secrets are never overwritten)"
else
  act "create $DATA/auth.json from config/auth.json.template (placeholder keys)"
  if [ "$DRY_RUN" -eq 0 ]; then
    ensure_dir_quiet "$DATA"
    cp -p "$BOOTSTRAP_DIR/config/auth.json.template" "$DATA/auth.json"
  fi
  changed
  note "REMEMBER: fill the 4 provider keys (README 'Secrets re-seed')"
fi
# F4: mode 0600 always — template ships 0644 and a pre-existing copy may too.
require_private "$DATA/auth.json"

# env seed file: only when absent (machine A may hold live seeds there).
if [ -L "$CFG/env" ] && [ ! -e "$CFG/env" ]; then
  say "WARN  $CFG/env is a dangling symlink -> $(readlink "$CFG/env") (left as-is; seed file is never overwritten)"
elif [ -e "$CFG/env" ]; then
  note "unchanged $CFG/env (exists; seed file is never overwritten)"
else
  act "create $CFG/env from config/env.template (empty seed values)"
  [ "$DRY_RUN" -eq 1 ] || cp -p "$BOOTSTRAP_DIR/config/env.template" "$CFG/env"
  changed
fi
# F4: the seed file holds key material once filled; never group/world-readable.
require_private "$CFG/env"

# --- 3. PATH shim ------------------------------------------------------------
say ""
say "-- step 3: ~/.local/bin/opencode shim (anti-fork pin wrapper)"
SHIM="$TARGET_HOME/.local/bin/opencode"
if [ -f "$SHIM" ] && ! [ -L "$SHIM" ] && grep -q "OPENCODE_DB=opencode-main.db" "$SHIM" 2>/dev/null \
  && grep -q "OPENCODE_EXPERIMENTAL_PLAN_MODE=1" "$SHIM" 2>/dev/null; then
  note "unchanged $SHIM (pin wrapper already in place)"
elif [ -e "$SHIM" ] || [ -L "$SHIM" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    act "would replace existing shim with pin wrapper (non-clobbering backup kept)"
  else
    # Always timestamped: an untimestamped first `.pre-pin` would silently
    # collide with (and be replaced by) the next run's backup naming.
    b="$SHIM.pre-pin.$TS"
    if [ -e "$b" ]; then b="$b.$$"; fi
    mv "$SHIM" "$b"
    write_wrapper
    act "replaced shim with pin wrapper (previous at $b)"
  fi
  changed
else
  write_wrapper
  act "pin wrapper $SHIM (forces OPENCODE_DB=opencode-main.db, then exec ~/.opencode/bin/opencode)"
  changed
fi

# --- 4. environment.d --------------------------------------------------------
say ""
say "-- step 4: environment.d"
# Managed: the DB pin must converge (it is the consolidation mechanism).
STAGE_SED=""
install_file "$BOOTSTRAP_DIR/config/environment.d/10-opencode-db.conf" \
             "$TARGET_HOME/.config/environment.d/10-opencode-db.conf"
# Seed-only: never overwrite existing ones (may carry live plumbing on machine A).
for f in 90-fcitx5.conf 95-qwen-provider.conf motoko-home.conf motoko-keys.conf; do
  dst="$TARGET_HOME/.config/environment.d/$f"
  if [ -L "$dst" ] && [ ! -e "$dst" ]; then
    say "WARN  $dst is a dangling symlink -> $(readlink "$dst") (left as-is; templates never overwrite)"
  elif [ -e "$dst" ]; then
    note "unchanged $dst (exists; templates never overwrite)"
  else
    act "create $dst from template (names only; fill values, see README)"
    [ "$DRY_RUN" -eq 1 ] || cp -p "$BOOTSTRAP_DIR/config/environment.d/$f" "$dst"
    changed
  fi
done
# F4: the three drop-ins whose headers declare mode 0600 must land 0600 even
# though the templates ship 0644 (two carry key placeholders; motoko-home is a
# machine path). 90-fcitx5.conf holds no secrets and keeps default perms.
for f in 95-qwen-provider.conf motoko-home.conf motoko-keys.conf; do
  require_private "$TARGET_HOME/.config/environment.d/$f"
done
note "environment.d changes take effect on next login (systemd user generator)."

# --- 5. agent-hooks battery + guard-surface wiring ----------------------------
say ""
say "-- step 5: agent-hooks kill-guard battery"
AH="$TARGET_HOME/.config/agent-hooks"
for f in block-unsafe-kill.sh cases.json run-cases.sh run-cases.ts; do
  STAGE_SED="s|/home/eric|$(sed_re_escape "$TARGET_HOME")|g"
  install_file "$BOOTSTRAP_DIR/agent-hooks/$f" "$AH/$f"
done
if [ "$DRY_RUN" -eq 0 ]; then
  for f in block-unsafe-kill.sh run-cases.sh; do
    if [ -f "$AH/$f" ]; then chmod 755 "$AH/$f"; fi
  done
fi

say ""
say "-- step 5b: wire guard surfaces (only where the target config already exists)"
GUARD="$TARGET_HOME/.config/agent-hooks/block-unsafe-kill.sh"

# Path-token rewriter shared by the JSON and the TOML wirings. A plain regex
# gets three shapes wrong: `KEY=/x/block-unsafe-kill.sh` loses its `KEY=`
# prefix, a path containing spaces (`/home/my user/.config/…`) shatters at the
# space, and a `re.sub` replacement string eats backslashes in the target
# home. This walks the string instead and splices the new path as literal text.
cat >"$WORK/guard_rewrite.py" <<'PYEOF'
import re, sys

NAME = "block-unsafe-kill.sh"
# Word boundaries: whitespace, quotes, shell metacharacters. `=` is walked
# over and cut back later (env-var prefix), never eaten from the value. The
# backtick sits here unescaped on purpose: a backslash before it would become
# a boundary char and shatter backslash-containing homes.
BOUNDARY = " \t\n\"'`" + ";|&<>()"
ROOTED = ("/", "~", "./", "../")


def rewrite_guard_paths(s: str, guard: str) -> str:
    out = []
    i = 0
    while True:
        j = s.find(NAME, i)
        if j < 0:
            out.append(s[i:])
            return "".join(out)
        end = j + len(NAME)
        # Already the target path: keep it verbatim. Without this a home that
        # contains a boundary char (`"`) is re-split on every run and the
        # correct path gets a second copy spliced into it.
        g0 = end - len(guard)
        if (
            g0 >= 0
            and s[g0:end] == guard
            and (g0 == 0 or s[g0 - 1] in BOUNDARY + "=")
            and (end == len(s) or s[end] in BOUNDARY + "=")
        ):
            out.append(s[i:end])
            i = end
            continue
        # Only rewrite whole file names: `block-unsafe-kill.sh.bak` is data.
        if end < len(s) and s[end] not in BOUNDARY + "=":
            out.append(s[i:end])
            i = end
            continue
        # Embedded sibling name (`myblock-unsafe-kill.sh`) is a different file,
        # matching verify.sh's ref extractor: data, not a path reference.
        if j > 0 and s[j - 1] not in BOUNDARY + "/~=":
            out.append(s[i:end])
            i = end
            continue
        # Path run: walk left over word characters.
        start = j
        while start > 0 and s[start - 1] not in BOUNDARY:
            start -= 1
        run = s[start:end]
        # Env-var prefix (`HOOK_GUARD=/x/block-unsafe-kill.sh`): keep `KEY=`
        # outside the rewrite, and only when the value looks like a path.
        eq = run.rfind("=")
        if (
            eq > 0
            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", run[:eq])
            and run[eq + 1 : eq + 2] in ("/", "~", ".")
        ):
            start += eq + 1
            run = run[eq + 1 :]
        # A bare name mention (`git commit -m "fix block-unsafe-kill.sh docs"`)
        # is prose, not a path reference — leave it verbatim like verify.sh does.
        if "/" not in run:
            out.append(s[i:end])
            i = end
            continue
        # Unrooted fragment with slashes (`user/.config/…`) continues a path
        # whose root is an earlier word (`/home/my user/.config/…`). Extend
        # left over non-flag words until a rooted word; if none is found
        # before a flag, a flag argument, or a bare numeric (timeout 30),
        # treat the fragment as its own argument and extend nothing.
        if "/" in run and not run.startswith(ROOTED):
            k = start
            ext = start
            rooted = False
            while True:
                p = k - 1
                if p < 0 or s[p] not in " \t":
                    break
                q = p
                # `=` is a word boundary here too, or `KEY=/home/my user/x.sh`
                # sees one unrooted `KEY=/home/my` word and under-extends.
                while q > 0 and s[q - 1] not in BOUNDARY + "=":
                    q -= 1
                word = s[q:p]
                if not word or word.startswith("-") or word.isdigit():
                    break
                ext = q
                if word.startswith(ROOTED):
                    rooted = True
                    break
                k = q
            if rooted:
                start = ext
        out.append(s[i:start])
        out.append(guard)
        i = end


def main() -> None:
    guard, path = sys.argv[1], sys.argv[2]
    with open(path) as fh:
        sys.stdout.write(rewrite_guard_paths(fh.read(), guard))


if __name__ == "__main__":
    main()
PYEOF

# Structural "is it wired" test shared by the JSON and TOML wirings: a hook
# command counts only when it carries a path reference to the guard (the
# shared rewriter's notion of a reference, probed with a sentinel). A bare
# mention elsewhere — `"allow": ["Bash(cat block-unsafe-kill.sh)"]`, a TOML
# comment — is data, not wiring.
cat >"$WORK/guard_wired.py" <<'PYEOF'
from guard_rewrite import rewrite_guard_paths

SENTINEL = "\x00guard\x00"


def refs_guard(cmd) -> bool:
    return isinstance(cmd, str) and SENTINEL in rewrite_guard_paths(cmd, SENTINEL)


def json_wired(data) -> bool:
    # hooks.PreToolUse[].hooks[].command (Claude / ZCode / Grok shape)
    hooks = data.get("hooks") if isinstance(data, dict) else None
    pre = hooks.get("PreToolUse") if isinstance(hooks, dict) else None
    for entry in pre if isinstance(pre, list) else []:
        inner = entry.get("hooks") if isinstance(entry, dict) else None
        for h in inner if isinstance(inner, list) else []:
            if isinstance(h, dict) and refs_guard(h.get("command")):
                return True
    return False


def toml_wired(data) -> bool:
    # [[hooks]] event = "PreToolUse", command = "...guard..." (Kimi shape)
    hooks = data.get("hooks") if isinstance(data, dict) else None
    for h in hooks if isinstance(hooks, list) else []:
        if isinstance(h, dict) and h.get("event") == "PreToolUse" and refs_guard(h.get("command")):
            return True
    return False
PYEOF

# Converge DST onto OUT (status file ST: line 1 = unchanged|edit|reformat|lossy,
# line 2 = what changed). Backup first; a lossy rewrite names its backup loudly.
apply_wiring() {
  local dst="$1" out="$2" st="$3" mode what
  mode=$(sed -n 1p "$st" 2>/dev/null); what=$(sed -n 2p "$st" 2>/dev/null)
  if [ ! -s "$out" ]; then say "WARN  empty wiring output for $dst (left as-is)"; return 0; fi
  if [ "$mode" = "unchanged" ] || cmp -s "$out" "$dst"; then
    note "unchanged $dst (already wired to $GUARD)"
    return 0
  fi
  act "wire $dst -> $GUARD (${what:-rewritten})"
  if [ "$DRY_RUN" -eq 0 ]; then
    backup_file "$dst"
    # Plain cp (no -p): $out is a umask-0644 temp file; stamping its mode
    # would clobber the user's 0600 settings.json. Existing dst keeps its mode.
    cp "$out" "$dst"
    if [ "$mode" = "lossy" ]; then
      say "WARN  $dst: comments / trailing commas could NOT be preserved by this rewrite;"
      say "WARN  the original text is kept verbatim at $LAST_BACKUP — merge them back by hand"
    fi
  else
    note "(would timestamp-backup the existing file first)"
    [ "$mode" = "lossy" ] && say "WARN  $dst: this rewrite would drop its comments / trailing commas (a backup would keep them)"
  fi
  changed
}

wire_json_hook() {
  # $1 = json config path. Rewrites an existing block-unsafe-kill.sh path token
  # to the target home path, or inserts the standard PreToolUse stanza when the
  # guard is not structurally wired. Edits are textual splices into the
  # original JSONC (comments, trailing commas and layout survive); a file that
  # needs no change is never rewritten.
  local dst="$1" out="$WORK/wire.$RANDOM.$$" st="$WORK/wire-st.$RANDOM.$$"
  if [ ! -f "$dst" ]; then
    say "SKIP  $dst does not exist (not created wholesale)"
    return 0
  fi
  if ! python3 - "$dst" "$GUARD" "$WORK" "$st" >"$out" <<'PYEOF'
import json, sys
path, guard, work, status = sys.argv[1:5]
sys.path.insert(0, work)
from guard_rewrite import rewrite_guard_paths
from guard_wired import json_wired

NAME = "block-unsafe-kill.sh"
with open(path, encoding="utf-8") as fh:
    raw = fh.read()


def strip_jsonc(s):
    # Independent JSONC -> JSON reduction (// and /* */ comments, trailing
    # commas), used to cross-check every splice below.
    out = []
    i, n = 0, len(s)
    in_str = False
    while i < n:
        c = s[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "/":
            while i < n and s[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if c == ",":
            j = i + 1
            while j < n:
                if s[j] in " \t\r\n":
                    j += 1
                elif s[j] == "/" and j + 1 < n and s[j + 1] == "/":
                    while j < n and s[j] != "\n":
                        j += 1
                elif s[j] == "/" and j + 1 < n and s[j + 1] == "*":
                    j += 2
                    while j + 1 < n and not (s[j] == "*" and s[j + 1] == "/"):
                        j += 1
                    j += 2
                else:
                    break
            if j < n and s[j] in "}]":
                i += 1
                continue
        out.append(c)
        i += 1
    return "".join(out)


class Parser:
    # Minimal JSONC parser that records source spans, so edits can be spliced
    # into the original text instead of re-serializing the whole document.
    def __init__(self, t):
        self.t, self.i = t, 0

    def ws(self):
        t, n = self.t, len(self.t)
        while self.i < n:
            c = t[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif t.startswith("//", self.i):
                while self.i < n and t[self.i] != "\n":
                    self.i += 1
            elif t.startswith("/*", self.i):
                e = t.find("*/", self.i + 2)
                if e < 0:
                    raise ValueError("unterminated comment")
                self.i = e + 2
            else:
                return

    def value(self):
        self.ws()
        t, a = self.t, self.i
        if a >= len(t):
            raise ValueError("unexpected end")
        c = t[a]
        if c in "{[":
            close = "}" if c == "{" else "]"
            node = {"k": "obj" if c == "{" else "arr", "open": a, "items": [], "last": None}
            self.i += 1
            while True:
                self.ws()
                if t[self.i] == close:
                    break
                key = None
                if node["k"] == "obj":
                    key = self.value()
                    if key["k"] != "str":
                        raise ValueError("non-string key")
                    self.ws()
                    if t[self.i] != ":":
                        raise ValueError("expected ':'")
                    self.i += 1
                v = self.value()
                node["items"].append((key["v"] if key else None, v))
                node["last"] = (key["start"] if key else v["start"], v["end"])
                self.ws()
                if t[self.i] == ",":
                    self.i += 1
                elif t[self.i] != close:
                    raise ValueError("expected ',' or close")
            node["start"], node["end"] = a, self.i + 1
            self.i += 1
            return node
        if c == '"':
            j = a + 1
            while t[j] != '"':
                j += 2 if t[j] == "\\" else 1
            self.i = j + 1
            return {"k": "str", "start": a, "end": self.i, "v": json.loads(t[a : self.i])}
        j = a
        while j < len(t) and t[j] not in ",]} \t\r\n/":
            j += 1
        self.i = j
        return {"k": "lit", "start": a, "end": j, "v": json.loads(t[a:j])}


def parse(t):
    p = Parser(t)
    root = p.value()
    p.ws()
    if p.i != len(t):
        raise ValueError("trailing data")
    return root


def member(obj, key):
    found = None
    for k, v in obj["items"]:
        if k == key:
            found = v  # last duplicate wins, like json.loads
    return found


def line_indent(t, pos):
    b = t.rfind("\n", 0, pos) + 1
    e = b
    while e < len(t) and t[e] in " \t":
        e += 1
    return t[b:e]


def insert(t, cont, render):
    # Append one element/member to container `cont`, spliced after its last
    # element (a trailing comma, if any, stays behind the new element).
    if cont["last"] is None:
        base = line_indent(t, cont["open"])
        ind = base + "  "
        at = cont["open"] + 1
        return t[:at] + "\n" + ind + render(ind) + "\n" + base + t[at:]
    ind = line_indent(t, cont["last"][0])
    at = cont["last"][1]
    return t[:at] + ",\n" + ind + render(ind) + t[at:]


def dumps_at(v, ind):
    return json.dumps(v, indent=2, ensure_ascii=False).replace("\n", "\n" + ind)


expected = json.loads(strip_jsonc(raw))
plain = strip_jsonc(raw) == raw
what = []

# 1. Path rewrite: only dict string values (wrapper commands and args around
#    the token survive; the shared rewriter handles KEY= prefixes, spaces and
#    backslashes in the target home).
def walk(node):
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and NAME in v:
                nv = rewrite_guard_paths(v, guard)
                if nv != v:
                    node[k] = nv
            else:
                walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)

walk(expected)
new_text = None
try:
    t = raw
    edits = []

    def spans(node):
        if node["k"] == "obj":
            for k, v in node["items"]:
                if v["k"] == "str" and NAME in v["v"]:
                    nv = rewrite_guard_paths(v["v"], guard)
                    if nv != v["v"]:
                        edits.append((v["start"], v["end"], json.dumps(nv, ensure_ascii=False)))
                else:
                    spans(v)
        elif node["k"] == "arr":
            for _, v in node["items"]:
                spans(v)

    spans(parse(t))
    for a, b, rep in sorted(edits, reverse=True):
        t = t[:a] + rep + t[b:]
    if edits:
        what.append(f"rewrote {len(edits)} guard path(s)")

    # 2. Structural wiring check; insert the standard stanza when absent.
    if not json_wired(expected):
        hook = {"hooks": [{"type": "command", "command": guard, "timeout": 10}]}
        expected.setdefault("hooks", {}).setdefault("PreToolUse", []).append(hook)
        root = parse(t)
        if root["k"] != "obj":
            raise ValueError("top level is not an object")
        hooks = member(root, "hooks")
        if hooks is None:
            t = insert(t, root, lambda ind: '"hooks": ' + dumps_at({"PreToolUse": [hook]}, ind))
        elif hooks["k"] != "obj":
            raise ValueError("hooks is not an object")
        else:
            pre = member(hooks, "PreToolUse")
            if pre is None:
                t = insert(t, hooks, lambda ind: '"PreToolUse": ' + dumps_at([hook], ind))
            elif pre["k"] != "arr":
                raise ValueError("hooks.PreToolUse is not an array")
            else:
                t = insert(t, pre, lambda ind: dumps_at(hook, ind))
        what.append("inserted PreToolUse stanza")
    if json.loads(strip_jsonc(t)) != expected:
        raise ValueError("splice cross-check mismatch")
    new_text = t
except (ValueError, IndexError, KeyError, json.JSONDecodeError):
    new_text = None

with open(status, "w") as fh:
    if not what:
        fh.write("unchanged\n\n")
        sys.stdout.write(raw)
    elif new_text is not None:
        fh.write("edit\n" + "; ".join(what) + "\n")
        sys.stdout.write(new_text)
    else:
        # Splice impossible (odd shape): full re-serialization. Lossless for a
        # plain-JSON file; for JSONC the caller warns and names the backup.
        fh.write(("reformat" if plain else "lossy") + "\n" + "; ".join(what) + " (re-serialized)\n")
        print(json.dumps(expected, indent=2, ensure_ascii=False))
PYEOF
  then
    say "WARN  python3 JSON wiring failed for $dst (left as-is)"
    rm -f "$out" "$st"
    return 0
  fi
  apply_wiring "$dst" "$out" "$st"
  rm -f "$out" "$st"
}

wire_json_hook "$TARGET_HOME/.claude/settings.json"
wire_json_hook "$TARGET_HOME/.zcode/settings.json"
wire_json_hook "$TARGET_HOME/.grok/hooks/block-unsafe-kill.json"

wire_toml_hook() {
  # $1 = kimi config.toml. Rewrites guard path tokens in place (wrapper command
  # and args survive, e.g. command = "bash /x/block-unsafe-kill.sh -v"), then
  # appends a [[hooks]] block unless one is structurally wired (event =
  # PreToolUse, command referencing the guard). The guard path is written as a
  # TOML basic string, so `"` and `\` in the target home are escaped.
  local dst="$1" out="$WORK/kimi.$RANDOM.$$" st="$WORK/kimi-st.$RANDOM.$$"
  if [ ! -f "$dst" ]; then
    say "SKIP  $dst does not exist (not created wholesale)"
    return 0
  fi
  if ! python3 - "$dst" "$GUARD" "$WORK" "$st" >"$out" <<'PYEOF'
import sys
path, guard, work, status = sys.argv[1:5]
sys.path.insert(0, work)
from guard_rewrite import rewrite_guard_paths
from guard_wired import toml_wired

with open(path, encoding="utf-8") as fh:
    raw = fh.read()


def toml_basic(s):
    out = []
    for ch in s:
        if ch in '"\\':
            out.append("\\" + ch)
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append("\\u%04X" % ord(ch))
        else:
            out.append(ch)
    return "".join(out)


what = []
t = rewrite_guard_paths(raw, toml_basic(guard)) if "block-unsafe-kill.sh" in raw else raw
if t != raw:
    what.append("rewrote guard path(s)")
try:
    import tomllib
    wired = toml_wired(tomllib.loads(t))
except Exception:
    # No tomllib (python < 3.11) or an unparseable file: degrade to the old
    # textual test rather than appending a second block blindly.
    wired = "block-unsafe-kill.sh" in t
    what.append("structural check unavailable, textual fallback")
if not wired:
    if t and not t.endswith("\n"):
        t += "\n"
    t += (
        "\n# --- opencode bootstrap kill-guard wiring (added by bootstrap/install.sh) ---\n"
        "[[hooks]]\n"
        'event = "PreToolUse"\n'
        'matcher = "Bash"\n'
        f'command = "{toml_basic(guard)}"\n'
        "timeout = 10\n"
    )
    what.append("appended [[hooks]] block")
with open(status, "w") as fh:
    fh.write(("edit" if t != raw else "unchanged") + "\n" + "; ".join(what) + "\n")
sys.stdout.write(t)
PYEOF
  then
    say "WARN  python3 TOML wiring failed for $dst (left as-is)"
    rm -f "$out" "$st"
    return 0
  fi
  apply_wiring "$dst" "$out" "$st"
  rm -f "$out" "$st"
}

wire_toml_hook "$TARGET_HOME/.kimi-code/config.toml"
say "     (5th surface = the opencode plugin port; wired by step 7)"

# --- 6. skills-extra ---------------------------------------------------------
say ""
say "-- step 6: skills-extra (collision-checked; existing skills are never removed)"
SK="$TARGET_HOME/.config/opencode/skills"
for s in "$BOOTSTRAP_DIR"/skills-extra/*/; do
  [ -d "$s" ] || continue
  name=$(basename "$s")
  dst="$SK/$name"
  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
    act "copy skill $name -> $dst"
    [ "$DRY_RUN" -eq 1 ] || cp -a "$s" "$dst"
    changed
  elif diff -r -q "$s" "$dst" >/dev/null 2>&1; then
    note "unchanged skill $name"
  else
    say "WARN  COLLISION: $dst exists and differs from the bundle copy (never overwritten)"
    # Backup the local copy once per content (idempotent: no backup pile-up),
    # then leave it in place — merging is a human decision.
    if compgen -G "$dst.bak.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]" >/dev/null; then
      note "(a timestamped backup already exists; not creating another — merge by hand)"
    elif [ "$DRY_RUN" -eq 0 ]; then
      cp -a "$dst" "$dst.bak.$TS"
      note "(existing copy backed up to $dst.bak.$TS; NOT overwritten — merge by hand)"
      changed
    else
      note "(would back up the existing copy to $dst.bak.$TS; NOT overwritten)"
    fi
  fi
done

# --- 7. plugin ---------------------------------------------------------------
say ""
say "-- step 7: plugin/"
PL="$TARGET_HOME/.config/opencode/plugin"
# open-code-review.ts ships as-is like the rest: it value-imports
# @opencode-ai/plugin at run time, but the fork's config loader installs that
# dependency into the config dir's node_modules on launch (npmSvc.install
# background fiber; verify.sh's log sweep watches its failure mode), so no
# npm step is needed here. It spawns `ocr` from PATH (npm i -g
# @alibaba-group/open-code-review on the target seat).
for f in block-unsafe-kill.ts mpskills-update.ts secret-path-guard.ts open-code-review.ts; do
  STAGE_SED=""   # shipped as-is: mpskills-update.ts resolves ${HOME} at run time
  install_file "$BOOTSTRAP_DIR/plugin/$f" "$PL/$f"
done

# --- 8. goal agent files -----------------------------------------------------
say ""
say "-- step 8: agent/ goal files + autonomy.md + AGENTS.goal.md shipped in the bundle"
# agent/goal.md is a SEED (same contract as script/sync-upstream.ts): installed
# only when absent, so a per-machine model/variant pin in the file survives
# re-installs. The seed note inside the file promises exactly this. Everything
# else here is managed content and converges on every run.
for d in command agent; do
  found=0
  for f in "$BOOTSTRAP_DIR/$d"/*; do
    [ -f "$f" ] || continue
    found=1
    STAGE_SED=""
    if [ "$d" = "agent" ]; then
      dst="$CFG/$d/$(basename "$f")"
      if [ -e "$dst" ] || [ -L "$dst" ]; then
        note "seed kept $dst (agent definition installed only when absent)"
        continue
      fi
    fi
    install_file "$f" "$CFG/$d/$(basename "$f")"
  done
  [ "$found" -eq 1 ] || say "SKIP  bundle $d/ is empty (nothing to install)"
done
# The two instruction files opencode.jsonc's `instructions` array loads.
# Managed (converge on every run), the same contract sync-upstream applies to
# its dotfiles/opencode copies of both.
for f in autonomy.md AGENTS.goal.md; do
  STAGE_SED=""
  install_file "$BOOTSTRAP_DIR/$f" "$CFG/$f"
done

# --- 9. bashrc egress/TTY wrapper -------------------------------------------
say ""
say "-- step 9: ~/.bashrc egress/TTY wrapper block"
# Review F5: the wrapper is copied into the seat's config tree and sourced
# from that stable path — a .bashrc that pins the bundle checkout breaks every
# new shell the moment the checkout moves.
BLOCK_SRC="$TARGET_HOME/.config/opencode/shell/bashrc-opencode-block.sh"
STABLE_SRC="[[ \$- == *i* ]] && source \"$BLOCK_SRC\""
MARK='# >>> opencode bootstrap egress block >>>'
MARK_END='# <<< opencode bootstrap egress block <<<'
STAGE_SED=""
install_file "$BOOTSTRAP_DIR/shell/bashrc-opencode-block.sh" "$BLOCK_SRC"

write_bashrc_block() {
  echo ''
  echo "$MARK"
  echo '# Load-bearing: mouse-garbage TTY fix + egress self-heal (see the file header).'
  echo '# Sourced from the seat config tree (stable path; the bundle checkout may move).'
  echo "$STABLE_SRC"
  echo "$MARK_END"
}

# One classifier for both the "does it need work" test and the rewrite, so the
# two can never disagree (they used to: the grep counted commented-out lines
# the rewrite skipped, so every run re-"converged" and left a backup; and a
# `. path/bashrc-opencode-block.sh` dot-source was invisible to both, so a
# second source line got appended). A wrapper source line is a non-comment
# line that runs `source` or `.` on a path ending in bashrc-opencode-block.sh.
cat >"$WORK/bashrc_sources.py" <<'PYEOF'
import re, sys

SRC_RE = re.compile(r"(?:^|[\s;&|(])(?:source|\.)\s+[^#\n]*bashrc-opencode-block\.sh")


def is_source(line: str) -> bool:
    return not line.lstrip().startswith("#") and bool(SRC_RE.search(line))


def main() -> None:
    mode, path, stable, mark, endmark = sys.argv[1:6]
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        lines = fh.read().splitlines(keepends=True)
    srcs = [ln.rstrip("\r\n") for ln in lines if is_source(ln)]
    has_mark = any(ln.rstrip("\r\n") == mark for ln in lines)
    if mode == "check":
        # ok       exactly one source line, and it is the stable one
        # converge source line(s) or our marker block exist: rewrite in place
        # append   nothing of ours yet: append the marked block
        if srcs == [stable]:
            print("ok")
        elif srcs or has_mark:
            print("converge")
        else:
            print("append")
        return
    # Rewrite (never duplicate): the first source line becomes the canonical
    # one, extra ones are dropped, and the stale "keep it at $BOOTSTRAP_DIR"
    # comment is reworded. Comments are left exactly as they are.
    out = []
    seen_src = False
    for ln in lines:
        s = ln.rstrip("\r\n")
        if is_source(ln):
            if seen_src:
                continue
            out.append(stable + "\n")
            seen_src = True
            continue
        if s.startswith("# Sourced from the bootstrap checkout"):
            out.append("# Sourced from the seat config tree (stable path; the bundle checkout may move).\n")
            continue
        if not seen_src and s.strip() == endmark:
            out.append(stable + "\n")
            seen_src = True
        out.append(ln)
    if not seen_src:
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        out.append(stable + "\n")
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
        fh.write("".join(out))


if __name__ == "__main__":
    main()
PYEOF

bashrc_sources() {
  python3 "$WORK/bashrc_sources.py" "$1" "$BASHRC" "$STABLE_SRC" "$MARK" "$MARK_END"
}

BASHRC="$TARGET_HOME/.bashrc"
if [ "$NO_BASHRC" -eq 1 ]; then
  say "SKIP  --no-bashrc given (block copy still installed; .bashrc untouched)"
elif [ ! -f "$BASHRC" ]; then
  say "SKIP  $BASHRC does not exist (not created wholesale)"
else
  state=$(bashrc_sources check)
  if [ "$state" = "ok" ]; then
    note "unchanged $BASHRC (sources the stable seat copy $BLOCK_SRC)"
  elif [ "$state" = "converge" ]; then
    act "converge egress wrapper source line(s) in $BASHRC to the stable seat path $BLOCK_SRC"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$BASHRC"
      bashrc_sources write
    fi
    changed
  else
    act "append marked source line for $BLOCK_SRC to $BASHRC"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$BASHRC"
      write_bashrc_block >>"$BASHRC"
    fi
    changed
  fi
fi

say ""
if [ "$DRY_RUN" -eq 1 ]; then
  say "== summary: $WOULD file change(s) would be made, $ACTIONS action(s) recorded =="
else
  say "== summary: $CHANGES change(s), $ACTIONS action(s) recorded =="
fi
if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$WOULD" -eq 0 ]; then
    say "idempotent: nothing to do — target already matches the bundle."
  else
    say "next: re-run without --dry-run to apply the $WOULD change(s)."
  fi
  say "DRY-RUN complete: no files were modified."
elif [ "$CHANGES" -eq 0 ]; then
  say "idempotent: nothing to do — target already matches the bundle."
else
  say "next: fill secrets (README 'Secrets re-seed'), re-login (environment.d),"
  say "      then run: bash $BOOTSTRAP_DIR/verify.sh --home $TARGET_HOME"
fi
exit 0
