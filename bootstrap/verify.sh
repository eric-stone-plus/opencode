#!/usr/bin/env bash
# verify.sh — post-install audit of the opencode seat (machine B).
#
# Usage:
#   bash verify.sh [--home <path>]
#     --home <path>   audit a scratch home instead of $HOME (testing).
#
# Prints PASS / WARN / FAIL per check; exits non-zero if anything FAILED.
# Safety rule: `opencode db path` CREATES and MIGRATES the database as a side
# effect (Database.Service init), so it is only ever executed when the DB file
# already exists. This script must never be the thing that creates the DB.

set -u

TARGET_HOME="${HOME:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --home) TARGET_HOME="${2:?--home needs a path}"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "verify.sh: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

BOOTSTRAP_DIR=$(cd "$(dirname "$0")" && pwd -P)
CFG="$TARGET_HOME/.config/opencode"
DATA="$TARGET_HOME/.local/share/opencode"
DB="$DATA/opencode-main.db"
LOG="$DATA/log/opencode.log"
GUARD="$TARGET_HOME/.config/agent-hooks/block-unsafe-kill.sh"

FAILS=0
WARNS=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '      %s\n' "$*"; }

echo "== verify opencode seat =="
echo "target home: $TARGET_HOME"
echo

# --- 1. toolchain deps -------------------------------------------------------
echo "-- deps"
missing=""
for c in jq bun git python3 curl; do
  command -v "$c" >/dev/null 2>&1 || missing="$missing $c"
done
if [ -z "$missing" ]; then
  pass "toolchain present: jq bun git python3 curl"
else
  fail "missing toolchain commands:$missing"
fi
bunv=$(bun --version 2>/dev/null || true)
[ -n "$bunv" ] && info "bun $bunv (fork build enforces bun@^1.3.14)"

# --- 2. opencode binary / shim ----------------------------------------------
echo "-- binary"
OC_BIN=$(command -v opencode 2>/dev/null || true)
if [ -n "$OC_BIN" ]; then
  pass "opencode on PATH: $OC_BIN"
else
  fail "opencode not on PATH (build+install it; README step 3)"
fi
SHIM="$TARGET_HOME/.local/bin/opencode"
if [ -f "$SHIM" ] && ! [ -L "$SHIM" ] && grep -q "OPENCODE_DB=opencode-main.db" "$SHIM" 2>/dev/null; then
  pass "shim pin wrapper present: $SHIM (exports OPENCODE_DB=opencode-main.db)"
elif [ -L "$SHIM" ] || [ -e "$SHIM" ]; then
  tgt=$(readlink "$SHIM" 2>/dev/null || echo "(not a symlink)")
  warn "shim present but carries no pin: $SHIM -> $tgt (fork risk for non-channel launches; install.sh step 3 writes a pin wrapper)"
else
  fail "shim missing: $SHIM (install.sh step 3)"
fi

# --- 3. version / channel ----------------------------------------------------
echo "-- version"
if [ -n "$OC_BIN" ]; then
  ver=$("$OC_BIN" --version 2>/dev/null | head -n 1)
  case "$ver" in
    0.0.0-main-[0-9]*) pass "version $ver (fork build, channel=main)" ;;
    "") warn "opencode --version produced no output" ;;
    *) warn "version '$ver' does not match ^0\\.0\\.0-main-[0-9]+$ — channel fork risk (DB name would diverge without the OPENCODE_DB pin)" ;;
  esac
else
  warn "version check skipped (no binary)"
fi

# --- 4. OPENCODE_DB pin ------------------------------------------------------
echo "-- DB consolidation pin"
dbconf="$TARGET_HOME/.config/environment.d/10-opencode-db.conf"
if [ -f "$dbconf" ] && grep -q '^OPENCODE_DB=opencode-main\.db$' "$dbconf"; then
  pass "environment.d/10-opencode-db.conf pins OPENCODE_DB=opencode-main.db"
else
  fail "environment.d/10-opencode-db.conf missing or not pinning OPENCODE_DB=opencode-main.db"
fi
visible=""
[ "${OPENCODE_DB:-}" = "opencode-main.db" ] && visible="process env"
if [ -z "$visible" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user show-environment 2>/dev/null | grep -q '^OPENCODE_DB=opencode-main\.db$'; then
    visible="systemctl --user show-environment"
  fi
fi
if [ -n "$visible" ]; then
  pass "OPENCODE_DB=opencode-main.db visible in live environment ($visible)"
else
  fail "OPENCODE_DB not visible in environment — re-login after install (environment.d is a login-time mechanism)"
fi

# --- 5. canonical DB (guarded) ----------------------------------------------
echo "-- canonical DB"
if [ -f "$DB" ]; then
  pass "canonical DB exists: $DB"
  # Guarded: opencode db path creates+migrates the DB — only run when it exists.
  # Even then it runs migrations on open; expect an error on a non-opencode DB.
  if [ -n "$OC_BIN" ]; then
    errf=$(mktemp "${TMPDIR:-/tmp}/verify-dbpath.XXXXXX")
    resolved=$(HOME="$TARGET_HOME" "$OC_BIN" db path 2>"$errf" | head -n 1)
    errtail=$(tr '\n' ' ' <"$errf" | cut -c1-160)
    rm -f "$errf"
    if [ "$resolved" = "$DB" ]; then
      pass "opencode db path resolves to the canonical DB"
    elif [ -z "$resolved" ]; then
      warn "opencode db path produced no path (inconclusive): $errtail"
    else
      fail "opencode db path resolved to '$resolved' (expected $DB) $errtail"
    fi
  else
    warn "db path resolution skipped (no binary)"
  fi
  if command -v python3 >/dev/null 2>&1; then
    integ=$(python3 - "$DB" <<'PYEOF'
import sqlite3, sys
try:
    con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    row = con.execute("PRAGMA integrity_check").fetchone()
    print(row[0] if row else "no-result")
except Exception as e:
    print(f"error: {type(e).__name__}")
PYEOF
)
    if [ "$integ" = "ok" ]; then
      pass "sqlite integrity_check ok"
    else
      fail "sqlite integrity_check: $integ"
    fi
  fi
else
  warn "canonical DB not present yet: $DB (fresh seat — skipped 'opencode db path' on purpose: it would CREATE and MIGRATE the DB)"
fi

# --- 6. auth providers (names only, never values) ----------------------------
echo "-- auth (names only)"
AUTH="$DATA/auth.json"
if [ ! -f "$AUTH" ]; then
  fail "auth.json missing: $AUTH"
elif ! command -v python3 >/dev/null 2>&1; then
  warn "python3 missing; cannot parse auth.json"
else
  authout=$(python3 - "$AUTH" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("PARSE_ERROR"); raise SystemExit
names = sorted(d.keys()) if isinstance(d, dict) else []
placeholders = sorted(
    k for k, v in d.items()
    if isinstance(v, dict) and str(v.get("key", "")).startswith("REPLACE_ME")
)
print("NAMES " + ",".join(names))
print("PLACEHOLDERS " + ",".join(placeholders))
PYEOF
)
  case "$authout" in
    PARSE_ERROR*) fail "auth.json is not valid JSON" ;;
    *)
      names=$(printf '%s\n' "$authout" | sed -n 's/^NAMES //p')
      ph=$(printf '%s\n' "$authout" | sed -n 's/^PLACEHOLDERS //p')
      info "providers: $names"
      ok=1
      for want in bailian-token-plan-personal glm-coding-plan zhipuai-coding-plan xiaomi-token-plan-cn; do
        case ",$names," in
          *",$want,"*) : ;;
          *) fail "auth provider missing: $want"; ok=0 ;;
        esac
      done
      if [ "$ok" -eq 1 ]; then
        pass "all 4 provider entries present"
      fi
      if [ -n "$ph" ]; then
        warn "placeholder keys not re-seeded yet: $ph (README 'Secrets re-seed')"
      fi
      ;;
  esac
fi

# --- 7. kill-guard battery + 5 hook surfaces ---------------------------------
echo "-- kill-guard wiring"
if [ -x "$GUARD" ]; then
  pass "guard script executable: $GUARD"
else
  fail "guard script missing or not executable: $GUARD"
fi
surface() {
  # $1 label, $2 file
  local label="$1" f="$2" ref
  if [ ! -f "$f" ]; then
    warn "$label: $f absent (install.sh wires it only when the config exists)"
    return 0
  fi
  if ! grep -q 'block-unsafe-kill\.sh' "$f"; then
    warn "$label: $f exists but is not wired to block-unsafe-kill.sh"
    return 0
  fi
  ref=$(grep -o '[][A-Za-z0-9_./-]*block-unsafe-kill\.sh' "$f" | head -n 1)
  if [ -e "$GUARD" ] && grep -qF "$GUARD" "$f"; then
    pass "$label wired to $GUARD"
  elif [ -n "$ref" ] && [ -e "$ref" ]; then
    pass "$label wired to $ref (exists)"
  else
    fail "$label references '$ref' which does not exist (stale username/path?)"
  fi
}
surface "claude" "$TARGET_HOME/.claude/settings.json"
surface "zcode" "$TARGET_HOME/.zcode/settings.json"
surface "grok" "$TARGET_HOME/.grok/hooks/block-unsafe-kill.json"
surface "kimi" "$TARGET_HOME/.kimi-code/config.toml"
info "5th surface = opencode plugin port (verified under plugin/ below)"
if [ -f "$BOOTSTRAP_DIR/agent-hooks/run-cases.sh" ]; then
  info "regression battery (optional, needs jq+bun): bash $TARGET_HOME/.config/agent-hooks/run-cases.sh"
fi

# --- 8. plugins --------------------------------------------------------------
echo "-- plugin/"
for f in block-unsafe-kill.ts mpskills-update.ts; do
  if [ -f "$CFG/plugin/$f" ]; then
    pass "plugin/$f present"
  else
    fail "plugin/$f missing"
  fi
done
if [ -L "$CFG/plugin/motoko.ts" ]; then
  mt=$(readlink "$CFG/plugin/motoko.ts")
  if [ -e "$CFG/plugin/motoko.ts" ]; then
    pass "plugin/motoko.ts symlink resolves ($mt)"
  else
    warn "plugin/motoko.ts symlink is dangling ($mt) — non-fatal: startup continues with a logged plugin error"
  fi
else
  warn "plugin/motoko.ts missing or not a symlink (motoko plugin not installed)"
fi

# --- 9. skills-extra ---------------------------------------------------------
echo "-- skills-extra"
for s in longrun-stability-audit motoko-seat-ops; do
  if [ -d "$CFG/skills/$s" ]; then
    pass "skill present: $s"
  else
    warn "skill missing: $s (orphan skill; install.sh step 6)"
  fi
done

# --- 10. silent-failure log sweep -------------------------------------------
echo "-- log sweep (first-launch silent failures are logged only)"
if [ ! -f "$LOG" ]; then
  pass "no opencode log yet at $LOG (nothing to sweep)"
else
  n1=$(grep -c 'plugin config hook failed' "$LOG" 2>/dev/null || true)
  n2=$(grep -c 'background dependency install failed' "$LOG" 2>/dev/null || true)
  if [ "${n1:-0}" -gt 0 ]; then
    warn "'plugin config hook failed' x$n1 in log — swallowed config-hook errors (mpskills-update hardcodes /home/eric; expected on machine B, or a dangling motoko.ts)"
  else
    pass "no 'plugin config hook failed' in log"
  fi
  if [ "${n2:-0}" -gt 0 ]; then
    warn "'background dependency install failed' x$n2 in log — background @opencode-ai/plugin npm install failed silently; re-run install with network/proxy up"
  else
    pass "no 'background dependency install failed' in log"
  fi
fi

# --- 11. goal command/agent files -------------------------------------------
echo "-- goal command/agent"
for pair in "command/goal-edit.md" "agent/goal-edit.md"; do
  if [ -f "$BOOTSTRAP_DIR/$pair" ]; then
    if [ -f "$CFG/$pair" ]; then
      pass "$pair installed"
    else
      fail "$pair shipped in bundle but missing at $CFG/$pair"
    fi
  else
    if [ -f "$CFG/$pair" ]; then
      pass "$pair present at target (not shipped in this bundle revision)"
    else
      warn "$pair absent at target and not shipped in bundle (skip condition documented in the report)"
    fi
  fi
done

echo
echo "== summary: $FAILS fail(s), $WARNS warn(s) =="
if [ "$FAILS" -gt 0 ]; then
  exit 1
fi
exit 0
