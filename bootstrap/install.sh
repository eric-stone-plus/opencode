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
#     --user <name>          legacy, display only (banner).
#     --link                 file-symlink config/opencode.jsonc into place instead
#                            of copying (live-edit into the checkout). Never used
#                            for skills/ or command/ (directory symlinks there are
#                            forbidden: sync-upstream rm+cp's from the same tree).
#     --no-bashrc            do not touch ~/.bashrc (skips the egress/TTY wrapper).
#
# What it installs (see README for the full runbook):
#   1  dirs ~/.config/opencode/{plugin,command,agent} ~/.config/environment.d
#      ~/.config/agent-hooks ~/.local/bin
#   2  config: opencode.jsonc (copy from --home, or --link), auth.json (template,
#      only if absent), env (template, only if absent)
#   3  ~/.local/bin/opencode pin wrapper (OPENCODE_DB=opencode-main.db +
#      OPENCODE_DISABLE_MODELS_FETCH=1 + OPENCODE_DISABLE_LSP_DOWNLOAD=1 -> exec
#      binary) and, when ~/.opencode/bin/opencode exists, the same DB/fetch pins
#      in the V2 background service config (`opencode service set env`): the
#      service keeps the env of whichever client spawned it
#   4  environment.d/10-opencode-db.conf (managed) + the other *.conf templates
#      (only if absent, never overwritten)
#   5  agent-hooks battery (4 files) + wiring of the 5 guard surfaces
#      (4 hook configs IF they exist; the opencode plugin port via step 7)
#   6  skills-extra/ collision-checked copy (never rm's an existing skill)
#   7  plugin/: block-unsafe-kill.ts + secret-path-guard.ts + local-tools.ts (drawio/
#      marker/planning tools) + skill-hints.ts + open-code-review.ts copies
#   8  command/ + agent/ mode cards (managed: agent/auto.md + agent/goal.md) +
#      AGENTS.md (the seat rules file, managed). The retired instruction files
#      (autonomy.md, AGENTS.goal.md) are deleted from the seat: their content
#      moved into the mode cards and opencode.jsonc no longer lists them.
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
REFUSED=0

usage() {
  cat <<'EOF'
install.sh — reproduce the opencode seat from this bootstrap bundle.

  --dry-run              print every action, change nothing
  --home <path>          target home (default: $HOME); use a scratch dir to test
  --user <name>          legacy, display only
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
# Canonicalize: the hook configs and the .bashrc source line record this path,
# and verify.sh compares it against the canonical home. A symlinked parent
# would otherwise leave the non-canonical spelling behind.
TARGET_HOME=$(cd "$TARGET_HOME" && pwd -P)
# The seat user is the owner of TARGET_HOME, not necessarily the invoking user:
# a root-run `--home /home/u` must not accept root-owned system files as
# writable dotfiles targets, and must still accept U's own files.
SEAT_UID=$(stat -c '%u' "$TARGET_HOME" 2>/dev/null) || {
  echo "install.sh: cannot determine the owner of $TARGET_HOME; refusing to guess" >&2
  exit 1
}
# A root-run `--home /home/u` would create root-owned files in the seat and
# verify.sh (run as the seat user) would reject them; the safe contract is to
# run as the seat user. This also keeps every chmod below on seat-owned paths.
if [ "$(id -u)" != "$SEAT_UID" ]; then
  echo "install.sh: $TARGET_HOME is owned by uid $SEAT_UID; run as that user (root-run installs are refused)" >&2
  exit 1
fi


sed_re_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

TS=$(date +%Y%m%d%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# Paths whose mode was already reported: the same file can be reached by an
# install step and the final normalization pass, and --dry-run must not count
# the same would-chmod twice.
MODE_SEEN="$WORK/mode-seen"
: > "$MODE_SEEN"

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
# (the git branch it was built on). Force the canonical DB for every launch
# flavor, including non-interactive PATH lookups that never see environment.d.
# Managed by bootstrap/install.sh.
export OPENCODE_DB=opencode-main.db
# Fork policy: never fetch the models.dev catalog implicitly (the bundled
# snapshot and the DB-cached catalog are the only sources).
export OPENCODE_DISABLE_MODELS_FETCH=1
# Language servers are installed by hand: a missing one would otherwise auto-download
# inside the awaited edit/write path with no timeout. Delete this line to restore it.
export OPENCODE_DISABLE_LSP_DOWNLOAD=1
# The V2 background service keeps the env of the client that spawned it, so the pins
# above only reach it when this wrapper spawns it (install.sh also persists them with
# `opencode service set env`).
exec "$HOME/.opencode/bin/opencode" "$@"
WRAP
  # umask 002 would make `cat`+`chmod +x` create 0775; the shim is executed by
  # the operator's shell, so keep it owner-writable, world-readable/executable.
  chmod 0755 "$SHIM" 2>/dev/null || { say "WARN  could not normalize mode: $SHIM"; REFUSED=1; }
}

ensure_dir() {
  if [ -d "$1" ]; then note "unchanged dir $1"; else act "mkdir -p $1"; [ "$DRY_RUN" -eq 1 ] || mkdir -p "$1"; changed; fi
}

backup_file() {
  # timestamped backup of anything we are about to overwrite.
  # Default -P: a symlink, dangling or not, is backed up as the link itself.
  # Pass L for a destination we write *through* (`apply_wiring`, `.bashrc` on
  # a dotfiles symlink): the target's content is the data at risk, not the link.
  local f="$1" follow="${2:-P}" b
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then return 0; fi
  b="$f.bak.$TS"
  if [ -e "$b" ] || [ -L "$b" ]; then b="$b.$$"; fi
  act "backup $f -> $(basename "$b")"
  LAST_BACKUP="$b"
  if [ "$DRY_RUN" -eq 0 ]; then
    cp -p"$follow" "$f" "$b"
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
  local f="$1" mode owner
  if [ ! -e "$f" ]; then return 0; fi
  if ! owner=$(stat -L -c '%u' "$f" 2>/dev/null); then
    say "WARN  cannot determine the owner of $f; not tightening its mode"
    REFUSED=1
    return 0
  fi
  if [ "$owner" != "$SEAT_UID" ]; then
    say "WARN  $f resolves to a file not owned by the seat user; not tightening its mode"
    REFUSED=1
    return 0
  fi
  if ! mode=$(stat -L -c '%a' "$f" 2>/dev/null); then
    say "WARN  cannot determine the mode of $f; not tightening it"
    REFUSED=1
    return 0
  fi
  if [ "$(( 8#$mode & 077 ))" -ne 0 ]; then
    act "chmod 600 $f (secret seed was mode $mode)"
    if [ "$DRY_RUN" -eq 0 ]; then chmod 600 "$f" 2>/dev/null || { say "WARN  could not tighten mode: $f"; REFUSED=1; }; fi
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
      chmod go-w "$dst" 2>/dev/null || { say "WARN  could not normalize mode: $dst"; REFUSED=1; }
    else
      note "(would back up the link itself first; its target is never written)"
    fi
    changed
  elif [ ! -e "$dst" ]; then
    act "create $dst (from ${src#"$BOOTSTRAP_DIR"/})"
    # New file: cp -p stamps the bundle template's mode (intended — templates
    # carry the perms they want; secret seeds are tightened by require_private).
    [ "$DRY_RUN" -eq 1 ] || { ensure_dir_quiet "$(dirname "$dst")"; cp -p "$stage" "$dst"; chmod go-w "$dst" 2>/dev/null || { say "WARN  could not normalize mode: $dst"; REFUSED=1; }; }
    changed
  elif cmp -s "$stage" "$dst"; then
    note "unchanged $dst"
    # An existing destination keeps its mode (the update path below does not
    # restamp it), so a file created under umask 002 stays 0664. Remove the
    # group/world write bits without touching the user's own bits; report a
    # mode-only change so --dry-run and the summary stay truthful.
    normalize_mode_file "$dst"
  else
    act "update $dst (from ${src#"$BOOTSTRAP_DIR"/})"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$dst"
      # Plain cp (no -p): the existing destination keeps its own mode; its
      # permissions must not be restamped from the bundle template.
      cp "$stage" "$dst"
      chmod go-w "$dst" 2>/dev/null || { say "WARN  could not normalize mode: $dst"; REFUSED=1; }
    else
      note "(would timestamp-backup the existing file first)"
    fi
    changed
  fi
  rm -f "$stage"
  STAGE_SED=""
}

ensure_dir_quiet() { [ -d "$1" ] || mkdir -p "$1"; }

# A dotfiles symlink is a supported layout. The target file is chmod'ed by the
# caller, but verify's parents_safe also rejects a writable parent chain;
# normalize the target's ancestors up to the target home (never above it).
normalize_link_target() {
  local dst="$1" target d
  [ -L "$dst" ] || return 0
  target=$(readlink -f "$dst" 2>/dev/null || true)
  [ -n "$target" ] || return 0
  # Never chmod outside the seat home: a supported dotfiles symlink may point
  # at /srv/dotfiles, and walking/chmod'ing shared or system ancestors would
  # damage them. Such a target is reported by verify instead.
  case "$target" in
    "$TARGET_HOME"/*) ;;
    *) return 0 ;;
  esac
  # Only a regular file owned by the seat user: never chmod a directory or a
  # foreign-owned target through a link (a root-run --home install must not
  # strip modes from system files), and let the caller's validation report it.
  [ -f "$target" ] || return 0
  [ "$(stat -c '%u' "$target" 2>/dev/null)" = "$SEAT_UID" ] || return 0
  chmod go-w "$target" 2>/dev/null || true
  d=$(dirname "$target")
  while [ "$d" != "/" ] && [ "$d" != "." ]; do
    # Only a seat-owned real directory: never chmod a foreign-owned ancestor
    # (a root-run install is refused, but a seat can still contain one). The
    # home itself is included: the final pass normalizes it anyway, and the
    # --link/.bashrc checks run before that pass.
    if [ ! -L "$d" ] && [ "$(stat -c '%u' "$d" 2>/dev/null)" = "$SEAT_UID" ]; then
      chmod go-w "$d" 2>/dev/null || true
    fi
    [ "$d" = "$TARGET_HOME" ] && break
    d=$(dirname "$d")
  done
}

# The same ancestor rule verify.sh applies to a symlink target: no group/world
# write bits and no foreign owner (root is the system exception) up to the
# target home, or to / for a target outside it.
link_parents_safe() {
  local target="$1" dir owner
  # Callers pass readlink -f output; an empty or relative value would loop
  # forever on dirname "." — reject it rather than hang the install.
  case "$target" in
    /*) ;;
    *) return 1 ;;
  esac
  dir=$(dirname "$target")
  while :; do
    [ -z "$(find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    owner=$(stat -c '%u' "$dir" 2>/dev/null) || return 1
    [ "$owner" = "$SEAT_UID" ] || [ "$owner" = "0" ] || return 1
    [ "$dir" = "$TARGET_HOME" ] && return 0
    [ "$dir" = "/" ] && return 0
    dir=$(dirname "$dir")
  done
}

# Dry-run counterpart of the --link normalization. A real run chmods the
# checkout files up to the repository root and the seat home, so only a
# symlink, a foreign owner, or an unsafe ancestor ABOVE the repository root can
# still make it fail. Reads only; never chmods.
link_parents_safe_after_normalize() {
  local target="$1" dir owner
  case "$target" in
    /*) ;;
    *) return 1 ;;
  esac
  dir=$(dirname "$target")
  while :; do
    # The final pass normalizes the seat home; a target below it inherits that.
    [ "$dir" = "$TARGET_HOME" ] && return 0
    [ -z "$(find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    owner=$(stat -c '%u' "$dir" 2>/dev/null) || return 1
    [ "$owner" = "$SEAT_UID" ] || [ "$owner" = "0" ] || return 1
    [ "$dir" = "/" ] && return 0
    dir=$(dirname "$dir")
  done
}

# True when a target inside the seat home can be repaired by
# normalize_link_target: every ancestor below the home is a real directory that
# is either seat-owned (chmod-able) or root-owned and already not writable.
# A foreign non-root owner, a symlinked ancestor, or a writable root-owned
# ancestor is not fixable.
dotfile_fixable() {
  local target="$1" d owner mode
  case "$target" in
    "$TARGET_HOME"/*) ;;
    *) return 1 ;;
  esac
  d=$(dirname "$target")
  while :; do
    [ -L "$d" ] && return 1
    owner=$(stat -c '%u' "$d" 2>/dev/null) || return 1
    mode=$(stat -c '%a' "$d" 2>/dev/null) || return 1
    if [ "$owner" = "$SEAT_UID" ]; then
      : # normalize_link_target can chmod this directory
    elif [ "$owner" = "0" ]; then
      [ $((0$mode & 022)) -eq 0 ] || return 1
    else
      return 1
    fi
    [ "$d" = "$TARGET_HOME" ] && return 0
    d=$(dirname "$d")
  done
}

# Normalize/validate a symlink's resolved target. An in-home seat-owned target
# is repaired (target and fixable ancestors); an outside-home target is only
# validated; anything that cannot be repaired is refused. Reports a real
# normalization through act()/changed() so --dry-run and the applied run agree.
# Returns 0 when safe, 1 when refused.
normalize_dotfile_target() {
  local f="$1" target d
  grep -Fxq "$f" "$MODE_SEEN" 2>/dev/null && return 0
  target=$(readlink -f "$f" 2>/dev/null || true)
  if [ -z "$target" ] || [ ! -f "$target" ] ||
    [ "$(stat -c '%u' "$target" 2>/dev/null)" != "$SEAT_UID" ]; then
    say "WARN  $f target is missing or foreign-owned; not normalizing it"
    REFUSED=1
    return 1
  fi
  case "$target" in
    "$TARGET_HOME"/*)
      if ! dotfile_fixable "$target"; then
        say "WARN  $f target has an ancestor that cannot be normalized; verify will fail"
        REFUSED=1
        return 1
      fi
      if [ -n "$(find "$target" -maxdepth 0 -perm /022 2>/dev/null)" ] ||
        ! link_parents_safe "$target"; then
        act "normalize mode of $target and its ancestors"
        changed
        # The final pass walks the same directories; mark them seen so a dry
        # run does not report the same would-chmod twice.
        d=$(dirname "$target")
        while :; do
          printf '%s\n' "$d" >> "$MODE_SEEN"
          [ "$d" = "$TARGET_HOME" ] && break
          d=$(dirname "$d")
        done
        printf '%s\n' "$target" >> "$MODE_SEEN"
      fi
      if [ "$DRY_RUN" -eq 0 ]; then normalize_link_target "$f"; fi
      ;;
    *)
      if [ -n "$(find "$target" -maxdepth 0 -perm /022 2>/dev/null)" ] ||
        ! link_parents_safe "$target"; then
        say "WARN  $f target is group/world-writable or has an unsafe ancestor; verify will fail"
        REFUSED=1
        return 1
      fi
      ;;
  esac
  if [ "$DRY_RUN" -eq 0 ]; then
    target=$(readlink -f "$f" 2>/dev/null || true)
    if [ -z "$target" ] || [ ! -f "$target" ] ||
      [ "$(stat -c '%u' "$target" 2>/dev/null)" != "$SEAT_UID" ] ||
      [ -n "$(find "$target" -maxdepth 0 -perm /022 2>/dev/null)" ] ||
      ! link_parents_safe "$target"; then
      say "WARN  $f target is missing, foreign-owned, or group/world-writable; verify will fail"
      REFUSED=1
      return 1
    fi
  fi
  printf '%s\n' "$f" >> "$MODE_SEEN"
  return 0
}

# Converge one regular file's mode and report a mode-only change. A symlink is
# never chmod'ed directly: normalize_link_target only touches an in-home target
# it can prove is a seat-owned regular file.
normalize_mode_file() {
  local f="$1" mode
  grep -Fxq "$f" "$MODE_SEEN" 2>/dev/null && return 0
  if [ -L "$f" ]; then
    normalize_dotfile_target "$f" || true
    return 0
  fi
  [ -f "$f" ] || return 0
  if [ "$(stat -c '%u' "$f" 2>/dev/null)" != "$SEAT_UID" ]; then
    say "WARN  $f is not owned by the seat user; not normalizing its mode"
    REFUSED=1
    return 0
  fi
  mode=$(stat -c '%a' "$f" 2>/dev/null) || return 0
  [ $((0$mode & 022)) -ne 0 ] || return 0
  printf '%s\n' "$f" >> "$MODE_SEEN"
  if [ "$DRY_RUN" -eq 1 ]; then
    act "chmod go-w $f"
    changed
  elif chmod go-w "$f" 2>/dev/null; then
    act "chmod go-w $f"
    changed
  else
    say "WARN  could not normalize mode: $f"
    REFUSED=1
  fi
}

# The directory counterpart used by the final pass.
normalize_mode_dir() {
  local d="$1" mode
  grep -Fxq "$d" "$MODE_SEEN" 2>/dev/null && return 0
  if [ -L "$d" ]; then return 0; fi
  [ -d "$d" ] || return 0
  if [ "$(stat -c '%u' "$d" 2>/dev/null)" != "$SEAT_UID" ]; then
    say "WARN  $d is not owned by the seat user; not normalizing its mode"
    REFUSED=1
    return 0
  fi
  mode=$(stat -c '%a' "$d" 2>/dev/null) || return 0
  [ $((0$mode & 022)) -ne 0 ] || return 0
  printf '%s\n' "$d" >> "$MODE_SEEN"
  if [ "$DRY_RUN" -eq 1 ]; then
    act "chmod go-w $d"
    changed
  elif chmod go-w "$d" 2>/dev/null; then
    act "chmod go-w $d"
    changed
  else
    say "WARN  could not normalize mode: $d"
    REFUSED=1
  fi
}

# --- 1. dirs -----------------------------------------------------------------
say "== bootstrap seat install =="
say "target home : $TARGET_HOME"
say "username    : $SED_USER (display only)"
say "bundle      : $BOOTSTRAP_DIR"
[ "$DRY_RUN" -eq 1 ] && say "mode        : DRY-RUN (no changes will be made)"
say ""
say "-- step 1: directories"
# A symlinked write root sends every file below it into the link target; the
# per-directory guards cannot see the root itself. Refuse all the roots this
# script writes through, not only the config root.
for root in \
  "$TARGET_HOME/.config" \
  "$TARGET_HOME/.local" \
  "$TARGET_HOME/.local/share" \
  "$TARGET_HOME/.local/state" \
  "$TARGET_HOME/.config/opencode" \
  "$TARGET_HOME/.config/opencode/plugin" \
  "$TARGET_HOME/.config/opencode/command" \
  "$TARGET_HOME/.config/opencode/agent" \
  "$TARGET_HOME/.config/opencode/skills" \
  "$TARGET_HOME/.config/opencode/shell" \
  "$TARGET_HOME/.config/environment.d" \
  "$TARGET_HOME/.config/agent-hooks" \
  "$TARGET_HOME/.local/bin" \
  "$TARGET_HOME/.local/share/opencode" \
  "$TARGET_HOME/.local/share/opencode/log" \
  "$TARGET_HOME/.claude" \
  "$TARGET_HOME/.zcode" \
  "$TARGET_HOME/.grok" \
  "$TARGET_HOME/.grok/hooks" \
  "$TARGET_HOME/.kimi-code"; do
  if [ -L "$root" ]; then
    echo "install.sh: $root is a symlink; refusing to install through it" >&2
    exit 1
  fi
done
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
  # The link target is the checkout's file; a clone under umask 002 leaves it
  # 0664 and its directories 0775, which verify rejects (another local user
  # could edit the config or replace the target). Normalize the target and its
  # ancestors up to the repository root; verify walks the chain to the seat home
  # or /, so a writable ancestor above the repo root is refused below.
  repo_root=$(cd "$BOOTSTRAP_DIR/.." && pwd -P)
  # The final pass normalizes the seat home, but the check below runs before
  # it; do it now so a 0775 home does not make --link refuse a fixable target.
  normalize_mode_dir "$TARGET_HOME"
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ -L "$want" ]; then
      say "WARN  $want is a symlink; not normalizing through it"
      REFUSED=1
    elif ! chmod go-w "$want" 2>/dev/null; then
      say "WARN  could not normalize $want; verify will fail if it is group/world-writable"
      REFUSED=1
    fi
    for d in "$BOOTSTRAP_DIR/config" "$BOOTSTRAP_DIR" "$repo_root"; do
      [ "$d" = "/" ] && continue
      [ -L "$d" ] || chmod go-w "$d" 2>/dev/null || { say "WARN  could not normalize $d"; REFUSED=1; }
    done
    if ! link_parents_safe "$want"; then
      say "WARN  $want has a group/world-writable or foreign-owned ancestor; verify will fail"
      REFUSED=1
    fi
  else
    # A dry run must predict the same refusal: the four checkout paths are
    # chmod-able only when they are real and seat-owned, and an ancestor above
    # the repository root is never touched by a real run.
    for d in "$want" "$BOOTSTRAP_DIR/config" "$BOOTSTRAP_DIR" "$repo_root"; do
      if [ -L "$d" ]; then
        say "WARN  $d is a symlink; --link would refuse"
        REFUSED=1
      elif [ "$(stat -c '%u' "$d" 2>/dev/null)" != "$SEAT_UID" ]; then
        say "WARN  $d is missing or not owned by the seat user; --link would refuse"
        REFUSED=1
      fi
    done
    if ! link_parents_safe_after_normalize "$repo_root"; then
      say "WARN  $repo_root has a group/world-writable or foreign-owned ancestor above the checkout; --link would refuse"
      REFUSED=1
    fi
  fi
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
    note "NOTE: --link keeps the bundle copy byte-identical (no rewrite)."
  fi
else
  install_file "$BOOTSTRAP_DIR/config/opencode.jsonc" "$CFG/opencode.jsonc"
fi

# cli.json: TUI keybinds, seeded only when absent. sync-upstream also installs it
# from the repo root, so a fresh clone that only runs this installer still gets
# the same keybinds without overwriting later tuning.
CLI_JSON="$BOOTSTRAP_DIR/../cli.json"
if [ -f "$CLI_JSON" ]; then
  if [ -L "$CFG/cli.json" ] && [ ! -e "$CFG/cli.json" ]; then
    # A dangling link has no content to preserve, and leaving it makes verify
    # fail ("cli.json missing"). Replace it with the repo copy.
    act "replace dangling symlink $CFG/cli.json with the repo copy"
    if [ "$DRY_RUN" -eq 0 ]; then
      backup_file "$CFG/cli.json"
      rm -f "$CFG/cli.json"
      cp -p "$CLI_JSON" "$CFG/cli.json"
      chmod go-w "$CFG/cli.json" 2>/dev/null || { say "WARN  could not normalize mode: $CFG/cli.json"; REFUSED=1; }
    fi
    changed
  elif [ -L "$CFG/cli.json" ]; then
    note "unchanged $CFG/cli.json (symlink; never written through)"
    normalize_dotfile_target "$CFG/cli.json" || true
  elif [ -e "$CFG/cli.json" ]; then
    note "unchanged $CFG/cli.json (exists; never overwritten)"
    normalize_mode_file "$CFG/cli.json"
  else
    act "create $CFG/cli.json from repo cli.json"
    if [ "$DRY_RUN" -eq 0 ]; then cp -p "$CLI_JSON" "$CFG/cli.json"; chmod go-w "$CFG/cli.json" 2>/dev/null || { say "WARN  could not normalize mode: $CFG/cli.json"; REFUSED=1; }; fi
    changed
  fi
else
  say "WARN  repo cli.json not found at $CLI_JSON (skipped); verify will fail without it"
  REFUSED=1
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
  note "REMEMBER: fill the provider key(s) (README 'Secrets re-seed')"
fi
# F4: mode 0600 always — template ships 0644 and a pre-existing copy may too.
require_private "$DATA/auth.json"

# env seed file: only when absent (machine A may hold live seeds there).
if [ -L "$CFG/env" ] && [ ! -e "$CFG/env" ]; then
  say "WARN  $CFG/env is a dangling symlink -> $(readlink "$CFG/env") (left as-is; seed file is never overwritten)"
  REFUSED=1
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
  && grep -q "OPENCODE_DISABLE_MODELS_FETCH=1" "$SHIM" 2>/dev/null \
  && ! grep -q "OPENCODE_EXPERIMENTAL_" "$SHIM" 2>/dev/null \
  && grep -q "OPENCODE_DISABLE_LSP_DOWNLOAD=1" "$SHIM" 2>/dev/null; then
  note "unchanged $SHIM (pin wrapper already in place)"
  # An older install under umask 002 left the shim 0775; converge the mode even
  # on the unchanged fast path (the `! -L` guard above keeps this off a link).
  # Compare first so a mode-only fix is reported and appears in --dry-run.
  shim_mode=$(stat -c '%a' "$SHIM" 2>/dev/null || true)
  if [ "$shim_mode" != "755" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      act "chmod 0755 $SHIM"
      changed
    elif chmod 0755 "$SHIM" 2>/dev/null; then
      act "chmod 0755 $SHIM"
      changed
    else
      say "WARN  could not normalize mode: $SHIM"
      REFUSED=1
    fi
  fi
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
# V2 background service: it keeps the env of whichever client spawned it, so persist the
# same pins in its own config. Any later spawn then agrees on the DB and the fetch policy,
# whichever client or wrapper starts it. Writes service config only; never opens the DB.
OC_REAL="$TARGET_HOME/.opencode/bin/opencode"
if [ -x "$OC_REAL" ]; then
  for pin in "OPENCODE_DB opencode-main.db" "OPENCODE_DISABLE_MODELS_FETCH 1" "BUN_CONFIG_MAX_HTTP_REQUESTS 4096"; do
    act "service set env $pin"
    if [ "$DRY_RUN" -eq 0 ]; then
      # shellcheck disable=SC2086
      HOME="$TARGET_HOME" OPENCODE_DB=opencode-main.db "$OC_REAL" service set env $pin \
        || note "service set env $pin failed (re-run after the binary works)"
    fi
  done
  # `service set env` writes the config and then stops the service, so the client that re-ensures it
  # spawns it with the pins just written. Restart once anyway so a service that is already running is
  # recycled onto them instead of waiting for the next spawn (see PERSONAL.md, "Residual risk").
  if [ "$DRY_RUN" -eq 0 ]; then
    act "service restart (apply the pins written above)"
    HOME="$TARGET_HOME" OPENCODE_DB=opencode-main.db "$OC_REAL" service restart \
      || note "service restart failed; the pins apply on the next service spawn"
  fi
else
  note "service env pins skipped: $OC_REAL is not built yet (re-run install.sh after the first sync-upstream)"
fi

say ""
say "-- step 4: environment.d"
# Managed: the DB pin must converge (it is the consolidation mechanism).
STAGE_SED=""
install_file "$BOOTSTRAP_DIR/config/environment.d/10-opencode-db.conf" \
             "$TARGET_HOME/.config/environment.d/10-opencode-db.conf"
install_file "$BOOTSTRAP_DIR/config/environment.d/20-opencode-http.conf" \
             "$TARGET_HOME/.config/environment.d/20-opencode-http.conf"
# Seed-only: never overwrite existing ones (may carry live plumbing on machine A).
for f in 90-fcitx5.conf; do
  dst="$TARGET_HOME/.config/environment.d/$f"
  if [ -L "$dst" ] && [ ! -e "$dst" ]; then
    say "WARN  $dst is a dangling symlink -> $(readlink "$dst") (left as-is; templates never overwrite)"
    REFUSED=1
  elif [ -e "$dst" ]; then
    note "unchanged $dst (exists; templates never overwrite)"
    normalize_mode_file "$dst"
  else
    act "create $dst from template (names only; fill values, see README)"
    [ "$DRY_RUN" -eq 1 ] || { cp -p "$BOOTSTRAP_DIR/config/environment.d/$f" "$dst"; chmod go-w "$dst" 2>/dev/null || { say "WARN  could not normalize mode: $dst"; REFUSED=1; }; }
    changed
  fi
done
# 90-fcitx5.conf holds no secrets and keeps default perms. There is no
# secret-bearing environment.d drop-in left: the qwen template went with the
# vendor on 2026-10-15 (ADR 0010).
note "environment.d changes take effect on next login (systemd user generator)."

# --- 5. agent-hooks battery + guard-surface wiring ----------------------------
say ""
say "-- step 5: agent-hooks kill-guard battery"
AH="$TARGET_HOME/.config/agent-hooks"
for f in block-unsafe-kill.sh cases.json run-cases.sh run-cases.ts; do
  STAGE_SED="s|/home/eric|$(sed_re_escape "$TARGET_HOME")|g"
  install_file "$BOOTSTRAP_DIR/agent-hooks/$f" "$AH/$f"
done
for f in block-unsafe-kill.sh run-cases.sh; do
  if [ -f "$AH/$f" ]; then
    ah_mode=$(stat -c '%a' "$AH/$f" 2>/dev/null || true)
    if [ "$ah_mode" != "755" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        act "chmod 755 $AH/$f"
        changed
      elif chmod 755 "$AH/$f" 2>/dev/null; then
        act "chmod 755 $AH/$f"
        changed
      else
        say "WARN  could not normalize mode: $AH/$f"
        REFUSED=1
      fi
    fi
  fi
done

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
  if [ ! -s "$out" ]; then say "WARN  empty wiring output for $dst (left as-is)"; REFUSED=1; return 0; fi
  if [ "$mode" = "unchanged" ] || cmp -s "$out" "$dst"; then
    note "unchanged $dst (already wired to $GUARD)"
    # A pre-existing 0664 hook config decides whether the guard runs; converge
    # the mode even when the content already matches. normalize_mode_file never
    # chmods a symlink directly and reports a mode-only change (dry-run too).
    normalize_mode_file "$dst"
    return 0
  fi
  act "wire $dst -> $GUARD (${what:-rewritten})"
  # Validate a dotfiles symlink in both modes: a dry run must refuse an unsafe
  # target too, and a real run normalizes a fixable in-home target before the
  # cp writes through it.
  if [ -L "$dst" ]; then
    normalize_dotfile_target "$dst" || return 0
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    # A dotfiles symlink is a supported layout; back up the content the cp
    # below writes through, not just the link.
    if [ -L "$dst" ]; then
      backup_file "$dst" L
    else
      backup_file "$dst"
    fi
    # Plain cp (no -p): $out is a umask-0644 temp file; stamping its mode
    # would clobber the user's 0600 settings.json. Existing dst keeps its mode.
    cp "$out" "$dst"
    chmod go-w "$dst" 2>/dev/null || { say "WARN  could not normalize mode: $dst"; REFUSED=1; }
    normalize_link_target "$dst"
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
    # Pass 1: remove comments, replacing each with a space so tokens never
    # merge (`tru/*x*/e` must not become `true`).
    out, i, n, in_str = [], 0, len(s), False
    while i < n:
        c = s[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            in_str = c != '"'
            i += 1
            continue
        if c == '"':
            in_str = True
        elif s.startswith("//", i):
            while i < n and s[i] != "\n":
                i += 1
            out.append(" ")
            continue
        elif s.startswith("/*", i):
            e = s.find("*/", i + 2)
            i = n if e < 0 else e + 2
            out.append(" ")
            continue
        out.append(c)
        i += 1
    text = "".join(out)
    # Pass 2: drop trailing commas now that comments are gone
    # (`"a": 1, // note` followed by `}`).
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            in_str = c != '"'
            i += 1
            continue
        if c == '"':
            in_str = True
        elif c == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
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
    REFUSED=1
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
    REFUSED=1
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
if [ -L "$SK" ]; then
  # A symlinked skills parent would make every copy land in the link target
  # (often the checkout itself) and every child look installed. Refuse the
  # whole skills step (6 and 6b), not only the directory loop: the vendored
  # root files (LICENSE, PROVENANCE.md) would otherwise still be copied
  # through the link.
  say "WARN  $SK is a symlink; refusing to copy skills through it (replace it with a real directory)"
  REFUSED=1
else
for s in "$BOOTSTRAP_DIR"/skills-extra/*/; do
  [ -d "$s" ] || continue
  if [ ! -f "$s/SKILL.md" ]; then
    # A bundle skill directory without SKILL.md is a packaging error: the seat
    # would silently lose the skill, and verify.sh skips the same directory.
    say "WARN  bundle skill $s has no SKILL.md; skipped (packaging error)"
    REFUSED=1
    continue
  fi
  name=$(basename "$s")
  dst="$SK/$name"
  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
    act "copy skill $name -> $dst"
    [ "$DRY_RUN" -eq 1 ] || cp -a "$s" "$dst"
    changed
  elif [ -L "$dst" ]; then
    say "WARN  COLLISION: $dst is a symlink; install the bundle copy (never written through)"
  elif diff -r -q --no-dereference "$s" "$dst" >/dev/null 2>&1; then
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

# --- 6b. vendored skills (frozen) -------------------------------------------
say ""
say "-- step 6b: vendored skills (copy missing; existing copies are never overwritten)"
VENDORED_SKILLS="$BOOTSTRAP_DIR/../skills"
if [ -d "$VENDORED_SKILLS" ]; then
  for s in "$VENDORED_SKILLS"/*/; do
    [ -d "$s" ] || continue
    name=$(basename "$s")
    dst="$SK/$name"
    if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
      act "copy vendored skill $name -> $dst"
      [ "$DRY_RUN" -eq 1 ] || cp -a "$s" "$dst"
      changed
    elif [ -L "$dst" ]; then
      # `diff -r` follows a directory symlink, so a link to a matching tree
      # would look "unchanged" while verify.sh rejects it.
      say "WARN  COLLISION: $dst is a symlink; install the frozen copy (never written through)"
    elif diff -r -q --no-dereference "$s" "$dst" >/dev/null 2>&1; then
      note "unchanged vendored skill $name"
    else
      say "WARN  COLLISION: $dst differs from vendored skills/$name (never overwritten; sync-upstream is the managed updater)"
    fi
  done
  # The frozen set also carries LICENSE and PROVENANCE.md at its root.
  for f in "$VENDORED_SKILLS"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    dst="$SK/$name"
    if [ "$name" = "PROVENANCE.md" ]; then
      # The skill loader discovers every `*.md` at the skills root as a skill
      # (`packages/core/src/config/plugin/skill.ts`), and PROVENANCE.md has no
      # frontmatter to make it skip. Install it without the suffix, and migrate
      # the legacy name only when it is still the frozen copy: a differing file
      # is the operator's, so it is reported instead of deleted.
      dst="$SK/PROVENANCE"
      legacy="$SK/PROVENANCE.md"
      if [ -L "$legacy" ]; then
        say "WARN  COLLISION: $legacy is a symlink; move it out of the skills root (it registers as a skill)"
        REFUSED=1
      elif [ -e "$legacy" ] && [ ! "$f" -ef "$legacy" ]; then
        if cmp -s "$f" "$legacy"; then
          act "remove legacy $legacy (a root .md registers as a skill)"
          [ "$DRY_RUN" -eq 1 ] || rm -f "$legacy"
          changed
        elif grep -q 'Generated by `bun run vendor-skills`' "$legacy" 2>/dev/null; then
          # A seat installed from an older frozen revision carries the same
          # generated header with a different revision/date. It is still ours:
          # back it up and replace it, or verify.sh and install.sh would tell
          # the operator to re-run each other forever.
          act "remove stale legacy $legacy (generated copy; a root .md registers as a skill)"
          if [ "$DRY_RUN" -eq 0 ]; then
            backup_file "$legacy"
            rm -f "$legacy"
          fi
          changed
        else
          say "WARN  COLLISION: $legacy differs from the frozen copy; move it out of the skills root (it registers as a skill)"
          REFUSED=1
        fi
      elif [ -e "$legacy" ]; then
        # The checkout itself is the seat's skills directory. The legacy file
        # is the frozen source, so removing it would delete tracked data; the
        # layout cannot be converged, so refuse instead of leaving a file the
        # loader discovers as a skill.
        say "WARN  COLLISION: the checkout's skills/ is the seat's skills/ ($legacy is the frozen source); move the checkout out of the seat"
        REFUSED=1
      fi
    fi
    if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
      act "copy vendored $name -> $dst"
      [ "$DRY_RUN" -eq 1 ] || cp -p "$f" "$dst"
      changed
    elif [ -L "$dst" ]; then
      # `cmp` follows the link, so a link to a matching file would look
      # "unchanged" while verify.sh rejects it.
      say "WARN  COLLISION: $dst is a symlink; install the frozen copy (never written through)"
    elif cmp -s "$f" "$dst"; then
      note "unchanged vendored $name"
    else
      say "WARN  COLLISION: $dst differs from vendored skills/$name (never overwritten)"
    fi
  done
else
  say "WARN  vendored skills/ not found at $VENDORED_SKILLS (skipped)"
fi
fi

# --- 7. plugin ---------------------------------------------------------------
say ""
say "-- step 7: plugin/"
PL="$TARGET_HOME/.config/opencode/plugin"
# The installed plugins are V2-API with no runtime package imports (effect and
# @opencode/plugin resolve through the host's module shim). local-tools.ts is
# the V2 port of the old dotfiles/opencode/tools trio; its drawio validator
# lives at lib/drawio.py (script/install-local-tools.ts deploys it).
# A symlinked plugin directory would send every install_file into the link
# target; install_file guards the leaf, not the parent.
if [ -L "$PL" ]; then
  say "WARN  $PL is a symlink; refusing to install plugins through it (replace it with a real directory)"
  REFUSED=1
  # The retired-updater removal below is skipped for a link (removing through
  # it would delete from the link target). Warn instead of leaving the
  # fetch/re-vendor/git-commit plugin silently reachable.
  if [ -e "$PL/mpskills-update.ts" ] || [ -L "$PL/mpskills-update.ts" ]; then
    say "WARN  retired updater mpskills-update.ts is still reachable through the plugin symlink; remove it manually"
  fi
else
  for f in block-unsafe-kill.ts secret-path-guard.ts local-tools.ts skill-hints.ts open-code-review.ts; do
    STAGE_SED=""   # shipped as-is; the plugins resolve ${HOME} at run time
    install_file "$BOOTSTRAP_DIR/plugin/$f" "$PL/$f"
  done
  # `install_file` preserves an existing destination's mode and stamps the
  # bundle's mode on create; a checkout with umask 002 or a pre-existing 0664
  # would leave a group/world-writable security gate. Normalize the plugins.
  for f in block-unsafe-kill.ts secret-path-guard.ts local-tools.ts skill-hints.ts open-code-review.ts; do
    if [ -f "$PL/$f" ] && [ ! -L "$PL/$f" ]; then
      normalize_mode_file "$PL/$f"
    fi
  done
  # mpskills-update.ts was deleted on 2026-10-16 (skills freeze: no fetch, no
  # re-vendor, no auto-commit). A stale seat copy would keep refreshing the
  # vendored skills behind the operator's back, so the install removes it.
  if [ -e "$PL/mpskills-update.ts" ] || [ -L "$PL/mpskills-update.ts" ]; then
    # No timestamp backup: the mechanism is retired on purpose (the content stays in git history), and a
    # dormant copy of a fetch/re-vendor/git-commit plugin on disk is exactly what the freeze removes.
    if [ "$DRY_RUN" -eq 0 ]; then
      rm -f "$PL/mpskills-update.ts"
    fi
    act "retired $PL/mpskills-update.ts (skills are frozen; updates are an operator task)"
  fi
fi

# --- 7b. local-tools support files -------------------------------------------
say ""
say "-- step 7b: local-tools support files (drawio/marker/planning)"
LOCAL_TOOLS="$BOOTSTRAP_DIR/../script/install-local-tools.ts"
LOCAL_SRC="$BOOTSTRAP_DIR/../dotfiles/opencode"
# A symlinked parent or leaf makes `-f`/`cmp` follow the link: a matching target
# would report "unchanged" and never reach the guard below, while a later update
# writes through the link. Check the links before the fast path. The manifest is
# written by install-local-tools.ts with a direct writeFile (follows symlinks).
LOCAL_LINK=""
for path in \
  "$CFG/skills" "$CFG/lib" \
  "$CFG/skills/drawio" "$CFG/skills/marker" "$CFG/skills/planning-with-files" \
  "$CFG/lib/drawio.py" \
  "$CFG/skills/drawio/SKILL.md" "$CFG/skills/marker/SKILL.md" "$CFG/skills/planning-with-files/SKILL.md" \
  "$CFG/local-tools-manifest.json"; do
  if [ -L "$path" ]; then
    LOCAL_LINK="$path"
    break
  fi
done
need_local=0
if [ -n "$LOCAL_LINK" ]; then
  need_local=1
else
  # Fast path only: the module's exported `managed` list is the source of
  # truth, and the manifest validator below derives its keys from it. A newly
  # managed file therefore still forces the installer even if this list is
  # stale (it just does not get the early cmp shortcut).
  for rel in lib/drawio.py skills/drawio/SKILL.md skills/marker/SKILL.md skills/planning-with-files/SKILL.md; do
    if [ ! -f "$CFG/$rel" ] || ! cmp -s "$LOCAL_SRC/$rel" "$CFG/$rel"; then
      need_local=1
      break
    fi
  done
  # The manifest is generated at the destination (not in dotfiles/). A missing,
  # unparseable, or incomplete manifest is not a baseline: install-local-tools.ts
  # reads a broken manifest as `{}` and then refuses every differing file as
  # "locally edited". Re-run the installer to rebuild it.
  if [ ! -f "$CFG/local-tools-manifest.json" ]; then
    need_local=1
  elif ! command -v bun >/dev/null 2>&1; then
    # Without bun the baseline cannot be validated; let the install branch
    # report the missing dependency instead of claiming "unchanged".
    need_local=1
  elif ! MANIFEST="$CFG/local-tools-manifest.json" DEST="$CFG" LOCAL_TOOLS="$LOCAL_TOOLS" bun -e '
    const { managed } = await import(process.env.LOCAL_TOOLS)
    const data = await Bun.file(process.env.MANIFEST).json().catch(() => undefined)
    const required = [...managed]
    if (!data || typeof data !== "object" || Array.isArray(data) || required.some((key) => typeof data[key] !== "string")) process.exit(1)
    // A stale manifest (a crash between the file writes and the manifest write)
    // would make the next bundle update look like a local edit. Validate the
    // recorded hash against the destination; a mismatch re-runs the installer,
    // which rewrites the manifest when the file is unchanged.
    for (const key of required) {
      const bytes = await Bun.file(process.env.DEST + "/" + key).bytes()
      if (Bun.CryptoHasher.hash("sha256", bytes, "hex") !== data[key]) process.exit(1)
    }
  ' >/dev/null 2>&1; then
    need_local=1
  fi
fi
if [ "$need_local" -eq 0 ]; then
  note "unchanged local-tools support files"
elif [ -n "$LOCAL_LINK" ]; then
  say "WARN  $LOCAL_LINK is a symlink; refusing to install local-tools support through it (replace it with a real file or directory)"
  REFUSED=1
elif [ -f "$LOCAL_TOOLS" ] && command -v bun >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    act "install local-tools support files into $CFG (bun $LOCAL_TOOLS $CFG)"
    changed
  elif bun "$LOCAL_TOOLS" "$CFG" >/dev/null; then
    act "install local-tools support files into $CFG"
    changed
  else
    say "WARN  local-tools install failed; run: bun $LOCAL_TOOLS $CFG"
    REFUSED=1
  fi
else
  say "WARN  bun or script/install-local-tools.ts missing; local-tools support not installed"
  REFUSED=1
fi
# The manifest is the local-edit baseline; a group/world-writable file lets
# another local user rewrite it. Repair the mode even on the unchanged path
# (install-local-tools.ts keeps an existing file's mode).
if [ -f "$CFG/local-tools-manifest.json" ] && [ ! -L "$CFG/local-tools-manifest.json" ]; then
  normalize_mode_file "$CFG/local-tools-manifest.json"
fi
# install-local-tools.ts writes with the process umask; normalize its Python
# helper and the copied skill/agent files. `find` does not follow symlinks, so
# a dotfiles link's target is never chmod'ed.
if [ -f "$CFG/lib/drawio.py" ] && [ ! -L "$CFG/lib/drawio.py" ] && [ ! -L "$CFG/lib" ]; then
  normalize_mode_file "$CFG/lib/drawio.py"
fi
for d in "$CFG/skills" "$CFG/agent" "$CFG/command"; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then
    if [ -n "$(find "$d" -type f -perm /022 2>/dev/null | head -n 1)" ]; then
      act "normalize modes under $d"
      changed
    fi
    if [ "$DRY_RUN" -eq 0 ]; then
      find "$d" -type f -exec chmod go-w {} + 2>/dev/null || { say "WARN  could not normalize some modes under $d"; REFUSED=1; }
      if [ -n "$(find "$d" -type f -perm /022 2>/dev/null | head -n 1)" ]; then
        say "WARN  files under $d are still group/world-writable"
        REFUSED=1
      fi
    fi
  fi
done

# --- 8. mode cards + seat rules ----------------------------------------------
say ""
say "-- step 8: agent mode cards (auto/goal) + AGENTS.md; retire the instruction files"
# Both mode cards are MANAGED (owner decision 2026-10-16: the mode policy has a
# single source, and the seat must match this checkout). The old agent/goal.md
# seed contract is gone with it: a per-machine model or variant pin belongs in
# opencode.jsonc's `agent.<id>.model`, which is operator state and never
# overwritten.
for d in command agent; do
  if [ -L "$CFG/$d" ]; then
    say "WARN  $CFG/$d is a symlink; refusing to install $d files through it (replace it with a real directory)"
    REFUSED=1
    continue
  fi
  found=0
  for f in "$BOOTSTRAP_DIR/$d"/*; do
    [ -f "$f" ] || continue
    found=1
    STAGE_SED=""
    install_file "$f" "$CFG/$d/$(basename "$f")"
  done
  [ "$found" -eq 1 ] || say "SKIP  bundle $d/ is empty (nothing to install)"
done
# The seat rules file was untracked operator state until 2026-10-16; it is now
# the managed single source (mirrors dotfiles/opencode/AGENTS.md), so a drift
# check can prove the no-self-evolution rules were not edited in place.
STAGE_SED=""
install_file "$BOOTSTRAP_DIR/AGENTS.md" "$CFG/AGENTS.md"
# Retired instruction documents: their content moved into the mode cards, and
# opencode.jsonc no longer lists them. Remove a stale seat copy so nothing
# silently re-loads a policy the cards now own.
for f in autonomy.md AGENTS.goal.md; do
  if [ -e "$CFG/$f" ] || [ -L "$CFG/$f" ]; then
    # No timestamp backup: the content moved into the mode cards and stays in git history.
    if [ "$DRY_RUN" -eq 0 ]; then
      rm -f "$CFG/$f"
    fi
    act "retired $CFG/$f (content moved into the mode cards)"
  else
    note "already absent: $CFG/$f"
  fi
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
  # A supported dotfiles symlink is written through, but only when the target
  # is a regular file owned by the user with safe ancestors; otherwise a
  # root-run --home install could append to a shared/system file.
  bashrc_ok=1
  if [ -L "$BASHRC" ]; then
    normalize_dotfile_target "$BASHRC" || bashrc_ok=0
  fi
  if [ "$bashrc_ok" -eq 1 ]; then
  state=$(bashrc_sources check)
  if [ "$state" = "ok" ]; then
    note "unchanged $BASHRC (sources the stable seat copy $BLOCK_SRC)"
    normalize_mode_file "$BASHRC"
  elif [ "$state" = "converge" ]; then
    act "converge egress wrapper source line(s) in $BASHRC to the stable seat path $BLOCK_SRC"
    if [ "$DRY_RUN" -eq 0 ]; then
      if [ -L "$BASHRC" ]; then backup_file "$BASHRC" L; else backup_file "$BASHRC"; fi
      bashrc_sources write
      normalize_link_target "$BASHRC"
    fi
    changed
  else
    act "append marked source line for $BLOCK_SRC to $BASHRC"
    if [ "$DRY_RUN" -eq 0 ]; then
      if [ -L "$BASHRC" ]; then backup_file "$BASHRC" L; else backup_file "$BASHRC"; fi
      write_bashrc_block >>"$BASHRC"
      normalize_link_target "$BASHRC"
    fi
    changed
  fi
  fi
fi

say ""
# --- final mode normalization ------------------------------------------------
# The checkout may have been cloned under umask 002 and `mkdir -p` inherits it;
# the seat's directories must not be group/world-writable. `find` does not
# follow symlinks, so a dotfiles link's target is never chmod'ed. This runs
# after every step so directories created by step 8 (agent/command) are covered.
for d in "$TARGET_HOME" "$TARGET_HOME/.config" "$CFG" "$TARGET_HOME/.config/agent-hooks" "$TARGET_HOME/.config/environment.d" \
  "$TARGET_HOME/.local" "$TARGET_HOME/.local/share" "$TARGET_HOME/.local/state" "$TARGET_HOME/.local/bin" \
  "$DATA" "$DATA/log" "$TARGET_HOME/.cache" "$TARGET_HOME/.claude" "$TARGET_HOME/.zcode" \
  "$TARGET_HOME/.grok" "$TARGET_HOME/.grok/hooks" "$TARGET_HOME/.kimi-code"; do
  normalize_mode_dir "$d"
done
if [ -d "$CFG" ] && [ ! -L "$CFG" ]; then
  if [ -n "$(find "$CFG" -mindepth 1 -type d -perm /022 2>/dev/null | head -n 1)" ]; then
    act "normalize modes under $CFG"
    changed
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    find "$CFG" -type d -exec chmod go-w {} + 2>/dev/null || { say "WARN  could not normalize some directories under $CFG"; REFUSED=1; }
    if [ -n "$(find "$CFG" -mindepth 1 -type d -perm /022 2>/dev/null | head -n 1)" ]; then
      say "WARN  directories under $CFG are still group/world-writable"
      REFUSED=1
    fi
  fi
fi
# .bashrc decides whether the egress wrapper is sourced; a regular file
# created under umask 002 must not stay group/world-writable. A symlink's
# target is handled by normalize_link_target in the .bashrc branch above.
# --no-bashrc promises not to touch the file at all, including its mode.
if [ "$NO_BASHRC" -eq 0 ] && [ -f "$BASHRC" ] && [ ! -L "$BASHRC" ]; then
  normalize_mode_file "$BASHRC"
fi
if [ "$REFUSED" -eq 1 ]; then
  say "== summary: install incomplete — a security-critical path was refused (see WARN above) =="
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say "== summary: $WOULD file change(s) would be made, $ACTIONS action(s) recorded =="
else
  say "== summary: $CHANGES change(s), $ACTIONS action(s) recorded =="
fi
if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$WOULD" -eq 0 ] && [ "$REFUSED" -eq 0 ]; then
    say "idempotent: nothing to do — target already matches the bundle."
  elif [ "$REFUSED" -eq 0 ]; then
    say "next: re-run without --dry-run to apply the $WOULD change(s)."
  fi
  say "DRY-RUN complete: no files were modified."
elif [ "$CHANGES" -eq 0 ] && [ "$REFUSED" -eq 0 ]; then
  say "idempotent: nothing to do — target already matches the bundle."
elif [ "$REFUSED" -eq 0 ]; then
  say "next: fill secrets (README 'Secrets re-seed'), re-login (environment.d),"
  say "      then run: bash $BOOTSTRAP_DIR/verify.sh --home $TARGET_HOME"
fi
if [ "$REFUSED" -eq 1 ]; then
  exit 1
fi
exit 0
