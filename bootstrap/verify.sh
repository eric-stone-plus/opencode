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

# Same normalization as install.sh: `--home /h/` must audit the paths an
# install with `--home /h` wrote (no `//` forms, no false stale-wiring flags).
while [ "$TARGET_HOME" != "/" ] && [ "${TARGET_HOME%/}" != "$TARGET_HOME" ]; do
  TARGET_HOME="${TARGET_HOME%/}"
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
# Only the target home's REAL binary counts. The pin shim at ~/.local/bin is
# not a binary: it only execs "$HOME/.opencode/bin/opencode", so a seat whose
# real binary is missing must FAIL even though the shim (which install.sh
# always writes) is executable. The auditor's PATH never satisfies the check
# either: the shim the seat launches through cannot reach it.
OC_BIN=""
REAL_BIN="$TARGET_HOME/.opencode/bin/opencode"
if [ -x "$REAL_BIN" ] && [ -f "$REAL_BIN" ]; then
  OC_BIN="$REAL_BIN"
  pass "opencode binary (resolved against target home): $OC_BIN"
else
  fail "opencode binary missing or not executable: $REAL_BIN (the ~/.local/bin pin shim is not the binary; build+install it, README step 2)"
  if command -v opencode >/dev/null 2>&1; then
    info "auditor PATH has $(command -v opencode) — not counted (the seat's shim execs only $REAL_BIN)"
  fi
fi
# Every invocation pins HOME to the audited home: a pin shim can then only ever
# resolve inside that home, never silently into the auditor's own seat.
run_oc() {
  HOME="$TARGET_HOME" OPENCODE_DB=opencode-main.db "$OC_BIN" "$@"
}
SHIM="$TARGET_HOME/.local/bin/opencode"
if [ -f "$SHIM" ] && ! [ -L "$SHIM" ] && grep -q "OPENCODE_DB=opencode-main.db" "$SHIM" 2>/dev/null; then
  pass "shim pin wrapper present: $SHIM (exports OPENCODE_DB=opencode-main.db)"
  if grep -q "OPENCODE_EXPERIMENTAL_PLAN_MODE=1" "$SHIM" 2>/dev/null; then
    pass "shim enables the plan-file workflow (OPENCODE_EXPERIMENTAL_PLAN_MODE=1)"
  else
    warn "shim lacks OPENCODE_EXPERIMENTAL_PLAN_MODE=1: plan_exit is not registered and the plan profile is prompt-only (re-run install.sh)"
  fi
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
mode_check "$TARGET_HOME/.config/environment.d/95-qwen-provider.conf" WARN "95-qwen-provider.conf"
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
  # $1 label, $2 file, $3 json|toml
  local label="$1" f="$2" kind="$3" ref refs scan wired bad=0 stale=0
  if [ ! -f "$f" ]; then
    warn "$label: $f absent (install.sh wires it only when the config exists)"
    return 0
  fi
  if ! grep -q 'block-unsafe-kill\.sh' "$f"; then
    warn "$label: $f exists but is not wired to block-unsafe-kill.sh"
    return 0
  fi
  # Two questions, answered separately:
  #  * WIRED — is there a PreToolUse hook whose command references this home's
  #    guard? Structural: JSON hooks.PreToolUse[].hooks[].command, TOML
  #    [[hooks]] event = "PreToolUse" + command. A file that merely mentions
  #    the name (`"allow": ["Bash(cat block-unsafe-kill.sh)"]`) is not wired.
  #  * REFS — every guard path referenced anywhere in the file must equal this
  #    home's guard: a path that exists but belongs to another home/user is
  #    stale wiring, not a pass (a hardcoded /home/eric ref must not satisfy
  #    a scratch --home audit). Per-occurrence path walk (not a scan-wide
  #    prefix cut): two refs in one string must not merge into one bogus path,
  #    space-containing homes must survive, and a bare name mention is data.
  if command -v python3 >/dev/null 2>&1; then
    scan=$(python3 - "$f" "$kind" "$GUARD" <<'PYEOF'
import json, re, sys
path, kind, guard = sys.argv[1:4]
text = open(path, encoding="utf-8", errors="replace").read()
NAME = "block-unsafe-kill.sh"
BOUNDARY = " \t\n\"'`" + ";|&<>()"
ROOTED = ("/", "~", "./", "../")


def refs_in(text):
    refs = set()
    for m in re.finditer(re.escape(NAME), text):
        end = m.end()
        if end < len(text) and text[end] not in BOUNDARY + "=":
            continue  # block-unsafe-kill.sh.bak and friends are not guard refs
        g0 = end - len(guard)
        if g0 >= 0 and text[g0:end] == guard and (g0 == 0 or text[g0 - 1] in BOUNDARY + "="):
            refs.add(guard)  # exact match first: a `"` in the home is a boundary
            continue
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
    return refs


def strip_jsonc(s):
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
            continue
        elif s.startswith("/*", i):
            e = s.find("*/", i + 2)
            i = n if e < 0 else e + 2
            continue
        elif c == ",":
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            if j < n and s[j] in "}]":
                i += 1
                continue
        out.append(c)
        i += 1
    return "".join(out)


def load():
    if kind == "toml":
        import tomllib
        return tomllib.loads(text)
    return json.loads(strip_jsonc(text))


def strings(node):
    # Every decoded string value: refs are judged on what the harness will
    # run, not on the escaped source text (`\\` / `\"` in JSON and TOML).
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from strings(v)


def commands(data):
    if kind == "toml":
        hooks = data.get("hooks")
        for h in hooks if isinstance(hooks, list) else []:
            if isinstance(h, dict) and h.get("event") == "PreToolUse" and isinstance(h.get("command"), str):
                yield h["command"]
        return
    hooks = data.get("hooks") if isinstance(data, dict) else None
    pre = hooks.get("PreToolUse") if isinstance(hooks, dict) else None
    for entry in pre if isinstance(pre, list) else []:
        inner = entry.get("hooks") if isinstance(entry, dict) else None
        for h in inner if isinstance(inner, list) else []:
            if isinstance(h, dict) and isinstance(h.get("command"), str):
                yield h["command"]


try:
    data = load()
except Exception as e:
    # Unparseable (or no tomllib): fall back to a raw-text ref scan.
    wired, refs = f"unknown ({type(e).__name__})", refs_in(text)
else:
    wired = "yes" if any(guard in refs_in(c) for c in commands(data)) else "no"
    refs = set().union(*(refs_in(s) for s in strings(data)))
    # Comments are invisible to the parse but may still hold a stale path.
    refs |= {r for r in refs_in(text) if r.startswith(ROOTED) and "\\" not in r and '"' not in r}
print("WIRED " + wired)
for r in sorted(refs):
    print("REF " + r)
PYEOF
)
    wired=$(printf '%s\n' "$scan" | sed -n 's/^WIRED //p')
    refs=$(printf '%s\n' "$scan" | sed -n 's/^REF //p')
  else
    refs=$(grep -o '[][A-Za-z0-9_./-]*block-unsafe-kill\.sh' "$f" | sort -u)
    wired="unknown (python3 missing)"
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
  case "$wired" in
    yes) : ;;
    no)
      warn "$label: $f mentions block-unsafe-kill.sh but no PreToolUse hook command runs $GUARD (not wired; re-run install.sh step 5b)"
      return 0 ;;
    *)
      warn "$label: hook structure of $f not checked: $wired (path refs only)"
      if [ -z "$refs" ]; then
        warn "$label: no guard path reference in $f (bare name mentions only)"
        return 0
      fi ;;
  esac
  if [ "$bad" -eq 0 ] && [ "$stale" -eq 0 ]; then
    pass "$label wired to $GUARD"
  fi
}
surface "claude" "$TARGET_HOME/.claude/settings.json" json
surface "zcode" "$TARGET_HOME/.zcode/settings.json" json
surface "grok" "$TARGET_HOME/.grok/hooks/block-unsafe-kill.json" json
surface "kimi" "$TARGET_HOME/.kimi-code/config.toml" toml
info "5th surface = opencode plugin port (verified under plugin/ below)"

# --- 7b. bashrc egress wrapper source path (stable seat copy, not the bundle) --
BLK="$CFG/shell/bashrc-opencode-block.sh"
# Active wrapper source lines only (install.sh step 9 uses the same rule):
# `source` or `.` on a path ending in bashrc-opencode-block.sh; comments are not
# wiring and must not raise a stale-wiring warning.
bashrc_src_lines() {
  grep -v '^[[:space:]]*#' "$1" | grep -E '(^|[[:space:];&|(])(source|\.)[[:space:]]+[^#]*bashrc-opencode-block\.sh'
}
if [ -f "$TARGET_HOME/.bashrc" ]; then
  if bashrc_src_lines "$TARGET_HOME/.bashrc" | grep -vF "\"$BLK\"" | grep -q .; then
    warn "bashrc sources bashrc-opencode-block.sh from outside $BLK (bundle-path wiring — re-run install.sh step 9 to converge)"
  elif bashrc_src_lines "$TARGET_HOME/.bashrc" | grep -qF "\"$BLK\""; then
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
for f in block-unsafe-kill.ts mpskills-update.ts secret-path-guard.ts open-code-review.ts; do
  if [ -f "$CFG/plugin/$f" ]; then
    pass "plugin/$f present"
  else
    fail "plugin/$f missing"
  fi
done

# --- 9. skills-extra ---------------------------------------------------------
echo "-- skills-extra"
for s in longrun-stability-audit; do
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
  # Match the structured severity and message fields. A raw keyword search
  # also counts commands recorded in the log that happen to inspect these
  # messages, which turns the audit into a self-referential false positive.
  n1=$(grep -cE 'level=ERROR.*message="plugin config hook failed"([[:space:]]|$)' "$LOG" 2>/dev/null || true)
  n2=$(grep -cE 'level=WARN.*message="background dependency install failed"([[:space:]]|$)' "$LOG" 2>/dev/null || true)
  if [ "${n1:-0}" -gt 0 ]; then
    warn "'plugin config hook failed' x$n1 in log — swallowed config-hook errors (a broken plugin file is the usual cause; mpskills-update.ts resolves \${HOME} and skips a missing script itself)"
  else
    pass "no 'plugin config hook failed' in log"
  fi
  if [ "${n2:-0}" -gt 0 ]; then
    warn "'background dependency install failed' x$n2 in log — background @opencode-ai/plugin npm install failed silently; re-run install with network/proxy up"
  else
    pass "no 'background dependency install failed' in log"
  fi
fi

# --- 11. goal agent + instructions files -------------------------------------
echo "-- goal agent + instructions files"
if [ -f "$BOOTSTRAP_DIR/agent/goal.md" ]; then
  if [ -f "$CFG/agent/goal.md" ]; then
    pass "agent/goal.md installed"
  else
    fail "agent/goal.md shipped in bundle but missing at $CFG/agent/goal.md"
  fi
elif [ -f "$CFG/agent/goal.md" ]; then
  pass "agent/goal.md present at target (not shipped in this bundle revision)"
else
  warn "agent/goal.md absent at target and not shipped in bundle"
fi
# The `instructions` files opencode.jsonc loads (autonomy.md, AGENTS.goal.md):
# a listed-but-missing file silently drops that policy from every session.
for f in autonomy.md AGENTS.goal.md; do
  if [ -f "$CFG/$f" ]; then
    if [ -f "$BOOTSTRAP_DIR/$f" ] && ! cmp -s "$BOOTSTRAP_DIR/$f" "$CFG/$f"; then
      warn "$f differs from the bundle copy (managed file; re-run install.sh step 8)"
    else
      pass "$f installed (opencode.jsonc instructions)"
    fi
  elif [ -f "$CFG/opencode.jsonc" ] && ! grep -qF "$f" "$CFG/opencode.jsonc"; then
    info "$f absent and not listed in opencode.jsonc instructions"
  else
    fail "$f missing at $CFG/$f but listed in opencode.jsonc instructions (install.sh step 8)"
  fi
done

echo
echo "== summary: $FAILS fail(s), $WARNS warn(s) =="
if [ "$FAILS" -gt 0 ]; then
  exit 1
fi
exit 0
