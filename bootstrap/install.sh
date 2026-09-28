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
#     --user <name>          username for the opencode.jsonc plans allowlist sed
#                            (default: current user). Machine A carried
#                            "home/eric/.local/share/opencode/plans/*.md".
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
#   3  ~/.local/bin/opencode pin wrapper (OPENCODE_DB=opencode-main.db -> exec binary)
#   4  environment.d/10-opencode-db.conf (managed) + the other *.conf templates
#      (only if absent, never overwritten)
#   5  agent-hooks battery (4 files) + wiring of the 5 guard surfaces
#      (4 hook configs IF they exist; the opencode plugin port via step 7)
#   6  skills-extra/ collision-checked copy (never rm's an existing skill)
#   7  plugin/: block-unsafe-kill.ts + mpskills-update.ts copies, motoko.ts
#      file-symlink (dangling target = non-fatal, warned)
#   8  command/ + agent/ goal files (only those shipped in the bundle)
#   9  ~/.bashrc: marked source line for shell/bashrc-opencode-block.sh
#      (interactive-only; --no-bashrc to skip)
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
  --user <name>          username for the opencode.jsonc plans allowlist sed
                         (default: current user)
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

if [ -z "$MOTOKO_TARGET" ]; then
  MOTOKO_TARGET=$(sed -n 's/^TARGET:[[:space:]]*//p' "$BOOTSTRAP_DIR/plugin/MOTOKO_SYMLINK.txt" 2>/dev/null | head -n 1)
fi

TS=$(date +%Y%m%d%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

ACTIONS=0
CHANGES=0

say() { printf '%s\n' "$*"; }
act() { ACTIONS=$((ACTIONS + 1)); if [ "$DRY_RUN" -eq 1 ]; then printf 'DRY-RUN: %s\n' "$*"; else printf 'DO: %s\n' "$*"; fi; }
note() { printf '     %s\n' "$*"; }
changed() { CHANGES=$((CHANGES + 1)); }
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
  [ "$DRY_RUN" -eq 1 ] || cp -p "$f" "$b"
}

# stage SRC through optional sed(1) expressions in "$STAGE_SED" (newline list),
# then converge onto DST. Overwrite policy: timestamp-backup first.
install_file() {
  local src="$1" dst="$2" stage="$WORK/stage.$RANDOM.$$"
  if [ ! -f "$src" ]; then
    say "SKIP  missing bundle file: $src"
    return 0
  fi
  cp -p "$src" "$stage"
  if [ -n "${STAGE_SED:-}" ]; then
    sed -i "$STAGE_SED" "$stage"
  fi
  if [ ! -e "$dst" ]; then
    act "create $dst (from ${src#"$BOOTSTRAP_DIR"/})"
    [ "$DRY_RUN" -eq 1 ] || { ensure_dir_quiet "$(dirname "$dst")"; cp -p "$stage" "$dst"; }
    changed
  elif cmp -s "$stage" "$dst"; then
    note "unchanged $dst"
  else
    act "update $dst (from ${src#"$BOOTSTRAP_DIR"/})"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$dst"
      cp -p "$stage" "$dst"
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
say "sed username: $SED_USER"
say "bundle      : $BOOTSTRAP_DIR"
[ "$DRY_RUN" -eq 1 ] && say "mode        : DRY-RUN (no changes will be made)"
say ""
say "-- step 1: directories"
for d in "$TARGET_HOME/.config/opencode/plugin" "$TARGET_HOME/.config/opencode/command" \
         "$TARGET_HOME/.config/opencode/agent" "$TARGET_HOME/.config/opencode/skills" \
         "$TARGET_HOME/.config/environment.d" "$TARGET_HOME/.config/agent-hooks" \
         "$TARGET_HOME/.local/bin"; do
  ensure_dir "$d"
done

# --- 2. config files ---------------------------------------------------------
say ""
say "-- step 2: config files"
CFG="$TARGET_HOME/.config/opencode"

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
    note "NOTE: --link keeps the bundle copy byte-identical; the plans allowlist"
    note "      still says home/eric/... unless you edit it in the checkout."
  fi
else
  STAGE_SED="s|home/eric/.local/share/opencode/plans/|home/$SED_USER/.local/share/opencode/plans/|"
  install_file "$BOOTSTRAP_DIR/config/opencode.jsonc" "$CFG/opencode.jsonc"
fi

# auth.json: template, only when absent. Never touch an existing one (holds keys).
if [ -e "$CFG/auth.json" ]; then
  note "unchanged $CFG/auth.json (exists; secrets are never overwritten)"
else
  act "create $CFG/auth.json from config/auth.json.template (placeholder keys)"
  if [ "$DRY_RUN" -eq 0 ]; then cp -p "$BOOTSTRAP_DIR/config/auth.json.template" "$CFG/auth.json"; chmod 600 "$CFG/auth.json"; fi
  changed
  note "REMEMBER: fill the 4 provider keys (README 'Secrets re-seed')"
fi

# env seed file: only when absent (machine A may hold live seeds there).
if [ -e "$CFG/env" ]; then
  note "unchanged $CFG/env (exists; seed file is never overwritten)"
else
  act "create $CFG/env from config/env.template (empty seed values)"
  [ "$DRY_RUN" -eq 1 ] || cp -p "$BOOTSTRAP_DIR/config/env.template" "$CFG/env"
  changed
fi

# --- 3. PATH shim ------------------------------------------------------------
say ""
say "-- step 3: ~/.local/bin/opencode shim (anti-fork pin wrapper)"
SHIM="$TARGET_HOME/.local/bin/opencode"
if [ -f "$SHIM" ] && ! [ -L "$SHIM" ] && grep -q "OPENCODE_DB=opencode-main.db" "$SHIM" 2>/dev/null; then
  note "unchanged $SHIM (pin wrapper already in place)"
elif [ -e "$SHIM" ] || [ -L "$SHIM" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    act "would replace existing shim with pin wrapper (backup kept as opencode.pre-pin)"
  else
    mv "$SHIM" "$SHIM.pre-pin"
    write_wrapper
    act "replaced shim with pin wrapper (previous at $SHIM.pre-pin)"
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
note "environment.d changes take effect on next login (systemd user generator)."

# --- 5. agent-hooks battery + guard-surface wiring ----------------------------
say ""
say "-- step 5: agent-hooks kill-guard battery"
AH="$TARGET_HOME/.config/agent-hooks"
for f in block-unsafe-kill.sh cases.json run-cases.sh run-cases.ts; do
  STAGE_SED="s|/home/eric|$TARGET_HOME|g"
  install_file "$BOOTSTRAP_DIR/agent-hooks/$f" "$AH/$f"
done
[ "$DRY_RUN" -eq 1 ] || chmod 755 "$AH/block-unsafe-kill.sh" "$AH/run-cases.sh"

say ""
say "-- step 5b: wire guard surfaces (only where the target config already exists)"
GUARD="$TARGET_HOME/.config/agent-hooks/block-unsafe-kill.sh"

wire_json_hook() {
  # $1 = json config path. Rewrites an existing block-unsafe-kill.sh command to
  # the target home path, or inserts the standard PreToolUse stanza when absent.
  local dst="$1" out="$WORK/wire.$RANDOM.$$"
  if [ ! -f "$dst" ]; then
    say "SKIP  $dst does not exist (not created wholesale)"
    return 0
  fi
  if ! python3 - "$dst" "$GUARD" >"$out" <<'PYEOF'
import json, sys
path, guard = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
changed = False

def walk(node):
    global changed
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and "block-unsafe-kill.sh" in v:
                if v != guard:
                    node[k] = guard
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
      cp -p "$out" "$dst"
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
  sed "s|\"[^\"]*block-unsafe-kill\\.sh\"|\"$GUARD\"|" "$KIMI" >"$stage"
  if cmp -s "$stage" "$KIMI"; then
    note "unchanged $KIMI (already wired to $GUARD)"
  else
    act "wire $KIMI -> $GUARD"
    if [ "$DRY_RUN" -eq 0 ]; then backup_file "$KIMI"; cp -p "$stage" "$KIMI"; else note "(would timestamp-backup the existing file first)"; fi
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
if [ -L "$motoko_dst" ] && [ "$(readlink "$motoko_dst")" = "$MOTOKO_TARGET" ]; then
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
if [ ! -e "$MOTOKO_TARGET" ]; then
  note "NOTE: $MOTOKO_TARGET does not exist here -> dangling symlink (non-fatal;"
  note "      opencode logs a plugin load/config error and continues). Clone motoko"
  note "      and pass --motoko-plugin <path> to fix."
fi

# --- 8. goal command/agent files --------------------------------------------
say ""
say "-- step 8: command/ + agent/ goal files shipped in the bundle"
for d in command agent; do
  found=0
  for f in "$BOOTSTRAP_DIR/$d"/*; do
    [ -f "$f" ] || continue
    found=1
    # goal-edit.md carries the seat username in its goals write globs
    STAGE_SED="s|home/eric/.local/share/opencode/goals/|home/$SED_USER/.local/share/opencode/goals/|"
    install_file "$f" "$CFG/$d/$(basename "$f")"
  done
  [ "$found" -eq 1 ] || say "SKIP  bundle $d/ is empty (nothing to install)"
done

# --- 9. bashrc egress/TTY wrapper -------------------------------------------
say ""
say "-- step 9: ~/.bashrc egress/TTY wrapper block"
BASHRC="$TARGET_HOME/.bashrc"
MARK='# >>> opencode bootstrap egress block >>>'
if [ "$NO_BASHRC" -eq 1 ]; then
  say "SKIP  --no-bashrc given"
elif [ ! -f "$BASHRC" ]; then
  say "SKIP  $BASHRC does not exist (not created wholesale)"
elif grep -qF "$MARK" "$BASHRC"; then
  note "unchanged $BASHRC (wrapper block already sourced)"
else
  act "append marked source line for shell/bashrc-opencode-block.sh to $BASHRC"
  if [ "$DRY_RUN" -eq 0 ]; then
    backup_file "$BASHRC"
    {
      echo ''
      echo "$MARK"
      echo '# Load-bearing: mouse-garbage TTY fix + egress self-heal (see the file header).'
      echo "[[ \$- == *i* ]] && source \"$BOOTSTRAP_DIR/shell/bashrc-opencode-block.sh\""
      echo '# <<< opencode bootstrap egress block <<<'
    } >>"$BASHRC"
  fi
  changed
fi

say ""
say "== summary: $CHANGES change(s), $ACTIONS action(s) recorded =="
if [ "$CHANGES" -eq 0 ]; then
  say "idempotent: nothing to do — target already matches the bundle."
else
  say "next: fill secrets (README 'Secrets re-seed'), re-login (environment.d),"
  say "      then run: bash $BOOTSTRAP_DIR/verify.sh --home $TARGET_HOME"
fi
[ "$DRY_RUN" -eq 1 ] && say "DRY-RUN complete: no files were modified."
exit 0
