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

# Canonicalized homes for every comparison below: a hardcoded path from the
# install machine (machine A's /home/eric) must never satisfy a scratch --home.
canon() {
  local d b
  d=$(dirname "$1"); b=$(basename "$1")
  if [ -d "$d" ]; then printf '%s/%s\n' "$(cd "$d" 2>/dev/null && pwd -P)" "$b"; else printf '%s\n' "$1"; fi
}
TARGET_HOME_R=$(canon "$TARGET_HOME")
REAL_HOME_R=""
[ -n "${HOME:-}" ] && REAL_HOME_R=$(canon "$HOME")

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
# Resolution order: the target home's REAL binary first, then the target's pin
# shim — a pin shim execs "$HOME/.opencode/bin/opencode" and must never be
# picked before the real thing when auditing a foreign --home. The auditor's
# PATH is consulted last and only as a warned fallback
# (`command -v` finds whatever the auditor's PATH points at).
OC_BIN=""
for cand in "$TARGET_HOME/.opencode/bin/opencode" "$TARGET_HOME/.local/bin/opencode"; do
  if [ -x "$cand" ]; then OC_BIN="$cand"; break; fi
done
if [ -n "$OC_BIN" ]; then
  pass "opencode binary (resolved against target home): $OC_BIN"
elif command -v opencode >/dev/null 2>&1; then
  OC_BIN=$(command -v opencode)
  warn "opencode only found on the auditor's PATH: $OC_BIN (target home has none)"
else
  fail "opencode not found for $TARGET_HOME and not on PATH (build+install it; README step 3)"
fi
# Every invocation pins HOME to the audited home: a pin shim can then only ever
# resolve inside that home, never silently into the auditor's own seat.
run_oc() {
  HOME="$TARGET_HOME" OPENCODE_DB=opencode-main.db "$OC_BIN" "$@"
}
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
  ver=$(run_oc --version 2>/dev/null | head -n 1)
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
if [ "$TARGET_HOME_R" != "$REAL_HOME_R" ]; then
  info "skipping live-environment check: auditing $TARGET_HOME, but the live env belongs to ${REAL_HOME_R:-<unset HOME>}"
else
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
fi

# --- 5. canonical DB (guarded) ----------------------------------------------
echo "-- canonical DB"
if [ -f "$DB" ]; then
  pass "canonical DB exists: $DB"
  # Guarded: opencode db path creates+migrates the DB — only run when it exists.
  # Even then it runs migrations on open; expect an error on a non-opencode DB.
  if [ -n "$OC_BIN" ]; then
    errf=$(mktemp "${TMPDIR:-/tmp}/verify-dbpath.XXXXXX")
    # Pin the DB name (the call must never pick a channel DB) and compare
    # canonicalized paths: $TARGET_HOME may contain symlinks and the binary
    # may print either form.
    resolved=$(run_oc db path 2>"$errf" | head -n 1)
    errtail=$(tr '\n' ' ' <"$errf" | cut -c1-160)
    rm -f "$errf"
    resolved_r=""
    [ -n "$resolved" ] && resolved_r=$(canon "$resolved")
    if [ -n "$resolved" ] && [ "$resolved_r" = "$(canon "$DB")" ]; then
      pass "opencode db path resolves to the canonical DB ($resolved)"
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
if isinstance(d, dict):
    names = sorted(d.keys())
    placeholders = sorted(
        k for k, v in d.items()
        if isinstance(v, dict) and str(v.get("key", "")).startswith("REPLACE_ME")
    )
else:
    # non-dict auth.json (corrupt/foreign shape): report empty, never crash
    names = []
    placeholders = []
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

# --- 6b. secret seed file modes ----------------------------------------------
echo "-- secret seed file modes"
# FAIL for auth.json / env: the primary secret surfaces must never be
# group/world-readable. WARN for the environment.d drop-ins: they carry
# placeholder names until re-seeded (and motoko-home/90-fcitx5 hold no secret
# at all), so a hard FAIL would block machine-B verification over files that
# still contain nothing sensitive.
mode_check() {
  local f="$1" sev="$2" label="$3" mode
  if [ ! -e "$f" ]; then
    info "$label: absent (nothing to check)"
    return 0
  fi
  mode=$(stat -c '%a' "$f" 2>/dev/null) || mode=""
  if [ -z "$mode" ]; then
    warn "$label: cannot stat mode of $f"
    return 0
  fi
  if [ "$(( 8#$mode & 077 ))" -eq 0 ]; then
    pass "$label: $f mode $mode (not group/world-readable)"
  elif [ "$sev" = "FAIL" ]; then
    fail "$label: $f mode $mode — secret seed must not be group/world-readable (install.sh require_private)"
  else
    warn "$label: $f mode $mode — should be 0600 once re-seeded (install.sh require_private)"
  fi
}
mode_check "$DATA/auth.json" FAIL "auth.json"
mode_check "$CFG/env" FAIL "env seed"
mode_check "$TARGET_HOME/.config/environment.d/95-quinte-provider.conf" WARN "95-quinte-provider.conf"
mode_check "$TARGET_HOME/.config/environment.d/motoko-keys.conf" WARN "motoko-keys.conf"
mode_check "$TARGET_HOME/.config/environment.d/motoko-home.conf" WARN "motoko-home.conf"

# --- 7. kill-guard battery + 5 hook surfaces ---------------------------------
echo "-- kill-guard wiring"
if [ -x "$GUARD" ]; then
  pass "guard script executable: $GUARD"
else
  fail "guard script missing or not executable: $GUARD"
fi
surface() {
  # $1 label, $2 file
  local label="$1" f="$2" ref refs bad=0 stale=0
  if [ ! -f "$f" ]; then
    warn "$label: $f absent (install.sh wires it only when the config exists)"
    return 0
  fi
  if ! grep -q 'block-unsafe-kill\.sh' "$f"; then
    warn "$label: $f exists but is not wired to block-unsafe-kill.sh"
    return 0
  fi
  # Every referenced guard path must equal this home's guard: a path that
  # exists but belongs to another home/user is stale wiring, not a pass
  # (a hardcoded /home/eric ref must not satisfy a scratch --home audit).
  # Per-occurrence path walk (not a scan-wide prefix cut): two refs in one
  # string must not merge into one bogus path, space-containing homes must
  # survive, and a bare name mention is data, not a path reference.
  if command -v python3 >/dev/null 2>&1; then
    refs=$(python3 - "$f" <<'PYEOF'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
NAME = "block-unsafe-kill.sh"
BOUNDARY = " \t\n\"'`" + ";|&<>()"
ROOTED = ("/", "~", "./", "../")
refs = set()
for m in re.finditer(re.escape(NAME), text):
    end = m.end()
    if end < len(text) and text[end] not in BOUNDARY + "=":
        continue  # block-unsafe-kill.sh.bak and friends are not guard refs
    start = m.start()
    if start > 0 and text[start - 1] not in BOUNDARY + "/~=":
        continue  # myblock-unsafe-kill.sh is a different file
    while start > 0 and text[start - 1] not in BOUNDARY:
        start -= 1
    run = text[start:end]
    eq = run.rfind("=")
    if (
        eq > 0
        and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", run[:eq])
        and run[eq + 1 : eq + 2] in ("/", "~", ".")
    ):
        run = run[eq + 1 :]
    if "/" not in run:
        continue  # bare name mention, not a path reference
    if not run.startswith(ROOTED):
        k = start + (len(text[start:end]) - len(run))
        ext = k
        rooted = False
        while True:
            p = k - 1
            if p < 0 or text[p] not in " \t":
                break
            q = p
            # `=` is a word boundary here too, or `KEY=/home/my user/x.sh`
            # sees one unrooted `KEY=/home/my` word and under-extends.
            while q > 0 and text[q - 1] not in BOUNDARY + "=":
                q -= 1
            word = text[q:p]
            if not word or word.startswith("-") or word.isdigit():
                break
            ext = q
            if word.startswith(ROOTED):
                rooted = True
                break
            k = q
        if rooted:
            run = text[ext:end]
    refs.add(run)
for r in sorted(refs):
    print(r)
PYEOF
)
  else
    refs=$(grep -o '[][A-Za-z0-9_./-]*block-unsafe-kill\.sh' "$f" | sort -u)
    warn "$label: python3 missing — ref scan degraded (paths with spaces may mis-report)"
  fi
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if [ "$ref" = "$GUARD" ]; then
      :
    elif [ -e "$ref" ]; then
      stale=$((stale + 1))
      warn "$label: stale guard ref '$ref' (exists but is not $GUARD — old home/username?)"
    else
      bad=$((bad + 1))
      fail "$label: references '$ref' which does not exist (stale username/path?)"
    fi
  done <<EOF
$refs
EOF
  if [ "$bad" -eq 0 ] && [ "$stale" -eq 0 ]; then
    pass "$label wired to $GUARD"
  fi
}
surface "claude" "$TARGET_HOME/.claude/settings.json"
surface "zcode" "$TARGET_HOME/.zcode/settings.json"
surface "grok" "$TARGET_HOME/.grok/hooks/block-unsafe-kill.json"
surface "kimi" "$TARGET_HOME/.kimi-code/config.toml"
info "5th surface = opencode plugin port (verified under plugin/ below)"

# --- 7b. bashrc egress wrapper source path (stable seat copy, not the bundle) --
BLK="$CFG/shell/bashrc-opencode-block.sh"
if [ -f "$TARGET_HOME/.bashrc" ]; then
  if grep 'source' "$TARGET_HOME/.bashrc" | grep 'bashrc-opencode-block\.sh' | grep -vF "$BLK" | grep -q .; then
    warn "bashrc sources bashrc-opencode-block.sh from outside $BLK (bundle-path wiring — re-run install.sh step 9 to converge)"
  elif grep -qF "$BLK" "$TARGET_HOME/.bashrc"; then
    if [ -f "$BLK" ]; then
      pass "bashrc sources the stable seat copy: $BLK"
    else
      fail "bashrc sources $BLK but that copy is missing (install.sh step 9)"
    fi
  else
    info "bashrc has no wrapper source line (install.sh writes one only when .bashrc exists; --no-bashrc skips)"
  fi
fi
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
for pair in "command/goal.md" "agent/goal.md"; do
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
      warn "$pair absent at target and not shipped in bundle"
    fi
  fi
done
if [ -f "$CFG/command/goal.md" ]; then
  if grep -q 'starts with "edit "' "$CFG/command/goal.md"; then
    pass "command/goal.md carries the /goal edit rules"
  else
    fail "command/goal.md lacks the /goal edit rules (stale template — re-sync from dotfiles)"
  fi
fi

echo
echo "== summary: $FAILS fail(s), $WARNS warn(s) =="
if [ "$FAILS" -gt 0 ]; then
  exit 1
fi
exit 0
