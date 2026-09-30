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
#     --motoko-plugin <path> symlink target for plugin/motoko.ts (default: the
#                            path recorded in plugin/MOTOKO_SYMLINK.txt).
#     --no-bashrc            do not touch ~/.bashrc (skips the egress/TTY wrapper).
#
# What it installs (see README for the full runbook):
#   1  dirs ~/.config/opencode/{plugin,command,agent} ~/.config/environment.d
#      ~/.config/agent-hooks ~/.local/bin
#   2  config: opencode.jsonc (copy+username-sed, or --link), auth.json (template,
#      only if absent), env (template, only if absent)
#   3  ~/.local/bin/opencode pin wrapper (OPENCODE_DB=opencode-main.db +
#      OPENCODE_EXPERIMENTAL_PLAN_MODE=1 -> exec binary)
#   4  environment.d/10-opencode-db.conf (managed) + the other *.conf templates
#      (only if absent, never overwritten)
#   5  agent-hooks battery (4 files) + wiring of the 5 guard surfaces
#      (4 hook configs IF they exist; the opencode plugin port via step 7)
#   6  skills-extra/ collision-checked copy (never rm's an existing skill)
#   7  plugin/: block-unsafe-kill.ts + mpskills-update.ts copies, motoko.ts
#      file-symlink (dangling target = non-fatal, warned)
#   8  command/ + agent/ goal files (only those shipped in the bundle)
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
MOTOKO_TARGET=""

usage() {
  cat <<'EOF'
install.sh — reproduce the opencode seat from this bootstrap bundle.

  --dry-run              print every action, change nothing
  --home <path>          target home (default: $HOME); use a scratch dir to test
  --user <name>          legacy, display only (plans paths derive from --home)
  --link                 file-symlink config/opencode.jsonc into place (live-edit)
  --motoko-plugin <path> symlink target for plugin/motoko.ts
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
    --motoko-plugin) MOTOKO_TARGET="${2:?--motoko-plugin needs a path}"; shift ;;
    --no-bashrc) NO_BASHRC=1 ;;
    -h|--help) usage 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; usage 1 ;;
  esac
  shift
done

[ -n "$TARGET_HOME" ] || { echo "install.sh: empty target home" >&2; exit 1; }
[ -d "$TARGET_HOME" ] || { echo "install.sh: target home is not a directory: $TARGET_HOME" >&2; exit 1; }

SEAT_HOME="${TARGET_HOME#/}"

sed_re_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

if [ -z "$MOTOKO_TARGET" ]; then
  MOTOKO_TARGET=$(sed -n 's/^TARGET:[[:space:]]*//p' "$BOOTSTRAP_DIR/plugin/MOTOKO_SYMLINK.txt" 2>/dev/null | head -n 1)
fi

TS=$(date +%Y%m%d%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

ACTIONS=0
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
  local f="$1" b
  if [ ! -e "$f" ]; then return 0; fi
  b="$f.bak.$TS"
  [ -e "$b" ] && b="$b.$$"
  act "backup $f -> $(basename "$b")"
  if [ "$DRY_RUN" -eq 0 ]; then
    cp -p "$f" "$b"
    prune_backups "$f"
  fi
}

prune_backups() {
  # Keep at most 20 timestamped backups per target; drop the oldest by mtime.
  local f="$1" keep=20 b i excess
  local -a baks=() old_first=()
  for b in "$f".bak.*; do
    [ -e "$b" ] || continue
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
  local f="$1" mode
  if [ ! -e "$f" ]; then return 0; fi
  mode=$(stat -c '%a' "$f" 2>/dev/null) || return 0
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
  if [ ! -e "$dst" ]; then
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
if [ -e "$DATA/auth.json" ]; then
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
if [ -e "$CFG/env" ]; then
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
for f in 90-fcitx5.conf 95-quinte-provider.conf motoko-home.conf motoko-keys.conf; do
  dst="$TARGET_HOME/.config/environment.d/$f"
  if [ -e "$dst" ]; then
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
for f in 95-quinte-provider.conf motoko-home.conf motoko-keys.conf; do
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
        # Only rewrite whole file names: `block-unsafe-kill.sh.bak` is data.
        if end < len(s) and s[end] not in BOUNDARY + "=":
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

wire_json_hook() {
  # $1 = json config path. Rewrites an existing block-unsafe-kill.sh command to
  # the target home path, or inserts the standard PreToolUse stanza when absent.
  local dst="$1" out="$WORK/wire.$RANDOM.$$"
  if [ ! -f "$dst" ]; then
    say "SKIP  $dst does not exist (not created wholesale)"
    return 0
  fi
  if ! python3 - "$dst" "$GUARD" "$WORK" >"$out" <<'PYEOF'
import json, re, sys
path, guard, work = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    raw = fh.read()

def strip_jsonc(s):
    # Tolerate JSONC targets (// and /* */ comments, trailing commas): strip
    # them outside string literals so json.load cannot choke on real-world
    # .claude/settings.json files.
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
            # drop a trailing comma when the next significant char closes
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

data = json.loads(strip_jsonc(raw))
changed = False
# Rewrite only the path token(s) that reference the guard script; keep any
# wrapper command and arguments around them intact (e.g. "sh /x/guard.sh -v").
# The shared rewriter handles KEY= prefixes, space-containing homes and
# backslashes; the string check above only detects *which* strings need work.
sys.path.insert(0, work)
from guard_rewrite import rewrite_guard_paths

def walk(node):
    global changed
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and "block-unsafe-kill.sh" in v:
                nv = rewrite_guard_paths(v, guard)
                if nv != v:
                    node[k] = nv
                    changed = True
            else:
                walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)

walk(data)
if "block-unsafe-kill.sh" not in json.dumps(data):
    hook = {"hooks": [{"type": "command", "command": guard, "timeout": 10}]}
    data.setdefault("hooks", {}).setdefault("PreToolUse", []).append(hook)
    changed = True
print(json.dumps(data, indent=2, ensure_ascii=False))
PYEOF
  then
    say "WARN  python3 JSON wiring failed for $dst (left as-is)"
    rm -f "$out"
    return 0
  fi
  if [ ! -s "$out" ]; then rm -f "$out"; say "WARN  empty wiring output for $dst (left as-is)"; return 0; fi
  if cmp -s "$out" "$dst"; then
    note "unchanged $dst (already wired to $GUARD)"
    rm -f "$out"
  else
    act "wire $dst -> $GUARD"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$dst"
      # Plain cp (no -p): $out is a umask-0644 temp file; stamping its mode
      # would clobber the user's 0600 settings.json. Existing dst keeps its mode.
      cp "$out" "$dst"
    else
      note "(would timestamp-backup the existing file first)"
    fi
    changed
    rm -f "$out"
  fi
}

wire_json_hook "$TARGET_HOME/.claude/settings.json"
wire_json_hook "$TARGET_HOME/.zcode/settings.json"
wire_json_hook "$TARGET_HOME/.grok/hooks/block-unsafe-kill.json"

KIMI="$TARGET_HOME/.kimi-code/config.toml"
if [ ! -f "$KIMI" ]; then
  say "SKIP  $KIMI does not exist (not created wholesale)"
elif grep -q 'block-unsafe-kill\.sh' "$KIMI"; then
  stage="$WORK/kimi.$$"
  # Rewrite only the path token, never the whole quoted string: wrapper command
  # and args survive, e.g. command = "bash /x/block-unsafe-kill.sh -v --flag".
  # The shared rewriter handles KEY= prefixes and space-containing homes.
  python3 "$WORK/guard_rewrite.py" "$GUARD" "$KIMI" >"$stage"
  if cmp -s "$stage" "$KIMI"; then
    note "unchanged $KIMI (already wired to $GUARD)"
  else
    act "wire $KIMI -> $GUARD"
    if [ "$DRY_RUN" -eq 0 ]; then backup_file "$KIMI"; cp "$stage" "$KIMI"; else note "(would timestamp-backup the existing file first)"; fi
    changed
  fi
  rm -f "$stage"
else
  act "append kill-guard [[hooks]] block to $KIMI"
  if [ "$DRY_RUN" -eq 0 ]; then
    backup_file "$KIMI"
    {
      echo ''
      echo '# --- opencode bootstrap kill-guard wiring (added by bootstrap/install.sh) ---'
      echo '[[hooks]]'
      echo 'event = "PreToolUse"'
      echo 'matcher = "Bash"'
      echo "command = \"$GUARD\""
      echo 'timeout = 10'
    } >>"$KIMI"
  fi
  changed
fi
say "     (5th surface = the opencode plugin port; wired by step 7)"

# --- 6. skills-extra ---------------------------------------------------------
say ""
say "-- step 6: skills-extra (collision-checked; existing skills are never removed)"
SK="$TARGET_HOME/.config/opencode/skills"
for s in "$BOOTSTRAP_DIR"/skills-extra/*/; do
  [ -d "$s" ] || continue
  name=$(basename "$s")
  dst="$SK/$name"
  if [ ! -e "$dst" ]; then
    act "copy skill $name -> $dst"
    [ "$DRY_RUN" -eq 1 ] || cp -a "$s" "$dst"
    changed
  elif diff -r -q "$s" "$dst" >/dev/null 2>&1; then
    note "unchanged skill $name"
  else
    say "WARN  COLLISION: $dst exists and differs from the bundle copy (never overwritten)"
    # Backup the local copy once per content (idempotent: no backup pile-up),
    # then leave it in place — merging is a human decision.
    if ls "$dst".bak.* >/dev/null 2>&1; then
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
for f in block-unsafe-kill.ts mpskills-update.ts; do
  STAGE_SED=""   # shipped as-is on purpose (mpskills-update.ts hardcodes /home/eric)
  install_file "$BOOTSTRAP_DIR/plugin/$f" "$PL/$f"
done
motoko_dst="$PL/motoko.ts"
if [ -z "$MOTOKO_TARGET" ]; then
  say "SKIP  motoko.ts not linked: no MOTOKO_TARGET (empty --motoko-plugin value"
  say "      / no TARGET line in plugin/MOTOKO_SYMLINK.txt)"
elif [ -L "$motoko_dst" ] && [ "$(readlink "$motoko_dst")" = "$MOTOKO_TARGET" ]; then
  note "unchanged symlink $motoko_dst"
else
  if [ -e "$motoko_dst" ] || [ -L "$motoko_dst" ]; then
    act "replace $motoko_dst with symlink -> $MOTOKO_TARGET"
    if [ "$DRY_RUN" -eq 0 ]; then backup_file "$motoko_dst"; rm -f "$motoko_dst"; ln -s "$MOTOKO_TARGET" "$motoko_dst"; fi
  else
    act "symlink $motoko_dst -> $MOTOKO_TARGET"
    [ "$DRY_RUN" -eq 1 ] || ln -s "$MOTOKO_TARGET" "$motoko_dst"
  fi
  changed
fi
if [ -n "$MOTOKO_TARGET" ] && [ ! -e "$MOTOKO_TARGET" ]; then
  note "NOTE: $MOTOKO_TARGET does not exist here -> dangling symlink (non-fatal:"
  note "      the plugin loader ignores load failures and opencode continues)."
  note "      Clone motoko and pass --motoko-plugin <path> to fix."
fi

# --- 8. goal command/agent files --------------------------------------------
say ""
say "-- step 8: command/ + agent/ goal files + autonomy.md shipped in the bundle"
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
      if [ -e "$dst" ]; then
        note "seed kept $dst (agent definition installed only when absent)"
        continue
      fi
    fi
    install_file "$f" "$CFG/$d/$(basename "$f")"
  done
  [ "$found" -eq 1 ] || say "SKIP  bundle $d/ is empty (nothing to install)"
done
STAGE_SED=""
install_file "$BOOTSTRAP_DIR/autonomy.md" "$CFG/autonomy.md"

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

bashrc_converge_sources() {
  # Rewrite (never duplicate) any source line for the wrapper to the stable
  # seat path: first source line becomes the canonical one, extra ones are
  # dropped, and the stale "keep it at $BOOTSTRAP_DIR" comment is reworded.
  python3 - "$BASHRC" "$STABLE_SRC" "$MARK_END" <<'PYEOF'
import sys
path, stable, endmark = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8", errors="surrogateescape") as fh:
    lines = fh.read().splitlines(keepends=True)
out = []
seen_src = False
for ln in lines:
    s = ln.rstrip("\n")
    if "source" in s and "bashrc-opencode-block.sh" in s and not s.lstrip().startswith("#"):
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
    out.append(stable + "\n")
with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
    fh.write("".join(out))
PYEOF
}

BASHRC="$TARGET_HOME/.bashrc"
if [ "$NO_BASHRC" -eq 1 ]; then
  say "SKIP  --no-bashrc given (block copy still installed; .bashrc untouched)"
elif [ ! -f "$BASHRC" ]; then
  say "SKIP  $BASHRC does not exist (not created wholesale)"
else
  needs=0
  n_stable=$(grep -cxF "$STABLE_SRC" "$BASHRC" 2>/dev/null) || n_stable=0
  if [ "$n_stable" -ne 1 ]; then needs=1; fi
  if grep 'source' "$BASHRC" | grep 'bashrc-opencode-block\.sh' | grep -vxF "$STABLE_SRC" | grep -q .; then
    needs=1
  fi
  if [ "$needs" -eq 0 ]; then
    note "unchanged $BASHRC (sources the stable seat copy $BLOCK_SRC)"
  elif grep -qF 'bashrc-opencode-block.sh' "$BASHRC" || grep -qF "$MARK" "$BASHRC"; then
    act "converge egress wrapper source line(s) in $BASHRC to the stable seat path $BLOCK_SRC"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$BASHRC"
      bashrc_converge_sources
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
