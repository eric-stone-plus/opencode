#!/usr/bin/env bash
# verify.sh — post-install audit of the opencode seat (machine B).
#
# Usage:
#   bash verify.sh [--home <path>]
#     --home <path>   audit a scratch home instead of $HOME (testing).
#
# Prints PASS / WARN / FAIL per check; exits non-zero if anything FAILED.
# Safety rule: the V1 `opencode db path` CREATES and MIGRATES the database as
# a side effect (Database.Service init); V2's `debug paths db` only resolves the
# path. The probe below stays guarded so a V1 binary can never create the DB.

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
[ -n "$bunv" ] && info "bun $bunv (fork build enforces bun@^1.4.2)"

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
  if grep -q "OPENCODE_DISABLE_MODELS_FETCH=1" "$SHIM" 2>/dev/null; then
    pass "shim disables the implicit models.dev fetch (OPENCODE_DISABLE_MODELS_FETCH=1)"
  else
    warn "shim lacks OPENCODE_DISABLE_MODELS_FETCH=1: this fork fetches only with OPENCODE_ENABLE_MODELS_FETCH set, but upstream V2 refreshes the catalog at boot and every 5 minutes (re-run install.sh)"
  fi
  if grep -q "OPENCODE_EXPERIMENTAL_" "$SHIM" 2>/dev/null; then
    warn "shim still exports dead OPENCODE_EXPERIMENTAL_* flags from the V1 runtime (re-run install.sh)"
  fi
  if grep -q "OPENCODE_DISABLE_LSP_DOWNLOAD=1" "$SHIM" 2>/dev/null; then
    pass "shim disables LSP auto-download (OPENCODE_DISABLE_LSP_DOWNLOAD=1)"
  else
    warn "shim lacks OPENCODE_DISABLE_LSP_DOWNLOAD=1: a missing language server auto-downloads inside the awaited edit/write path (re-run install.sh)"
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
  # V2 prints "opencode v0.0.0-main-<digits>"; V1 printed the bare "0.0.0-main-<digits>".
  ver=$(run_oc --version 2>/dev/null | head -n 1)
  ver=${ver#opencode v}
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
  # V2 resolves the path without opening the DB (`debug paths db`); a V1 binary
  # would need `db path`, which creates+migrates the DB, so it stays guarded.
  if [ -n "$OC_BIN" ]; then
    errf=$(mktemp "${TMPDIR:-/tmp}/verify-dbpath.XXXXXX")
    # Pin the DB name (the call must never pick a channel DB) and compare
    # canonicalized paths: $TARGET_HOME may contain symlinks and the binary
    # may print either form.
    resolved=$(run_oc debug paths db 2>"$errf" | head -n 1)
    errtail=$(tr '\n' ' ' <"$errf" | cut -c1-160)
    rm -f "$errf"
    resolved_r=""
    [ -n "$resolved" ] && resolved_r=$(canon "$resolved")
    if [ -n "$resolved" ] && [ "$resolved_r" = "$(canon "$DB")" ]; then
      pass "db path resolves to the canonical DB ($resolved)"
    elif [ -z "$resolved" ]; then
      warn "db path produced no path (inconclusive): $errtail"
    else
      fail "db path resolved to '$resolved' (expected $DB) $errtail"
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
  warn "canonical DB not present yet: $DB (fresh seat — the db path probe is skipped on purpose: a V1 binary would CREATE and MIGRATE the DB)"
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
      for want in deepseek; do
        case ",$names," in
          *",$want,"*) : ;;
          *) fail "auth provider missing: $want"; ok=0 ;;
        esac
      done
      if [ "$ok" -eq 1 ]; then
        pass "provider entry present (deepseek)"
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
# placeholder names until re-seeded (90-fcitx5 holds no secret
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
for f in block-unsafe-kill.ts secret-path-guard.ts local-tools.ts skill-hints.ts open-code-review.ts; do
  if [ -f "$CFG/plugin/$f" ]; then
    pass "plugin/$f present"
  else
    fail "plugin/$f missing"
  fi
done
# Skills freeze (2026-10-16): the auto-updater is removed on purpose. A stale
# seat copy would keep fetching, re-vendoring, and committing behind the
# operator's back.
if [ -e "$CFG/plugin/mpskills-update.ts" ]; then
  fail "plugin/mpskills-update.ts present — removed by the skills freeze; delete it"
else
  pass "plugin/mpskills-update.ts absent (skills frozen)"
fi
# Support file and skills for the local-tools plugin (script/install-local-tools.ts;
# the drawio tool fails closed without lib/drawio.py, the skills only lose guidance).
if [ -f "$CFG/lib/drawio.py" ]; then
  pass "lib/drawio.py present"
else
  warn "lib/drawio.py missing (drawio tool will refuse; run: bun run script/install-local-tools.ts)"
fi
for s in drawio marker planning-with-files; do
  if [ -d "$CFG/skills/$s" ]; then
    pass "skill present: $s"
  else
    warn "skill missing: $s (run: bun run script/install-local-tools.ts)"
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
  # V2 moved the swallow points: the plugin supervisor logs a load failure as a
  # warning (supervisor.ts:63) and a reload failure as an error (:239), and the
  # config loader logs a failed plugin watch (config/plugin/source.ts:67). The
  # V1 pair this used to watch ("plugin config hook failed" / "background
  # dependency install failed") has no producer left in the V2 tree.
  n=$(grep -cE 'level=(WARN|ERROR).*message="(failed to load plugin|failed to reload plugins|configured plugin watch failed)"([[:space:]]|$)' "$LOG" 2>/dev/null || true)
  if [ "${n:-0}" -gt 0 ]; then
    warn "swallowed plugin failure x$n in log — a broken plugin file is the usual cause (check that each file under plugin/ loads standalone)"
  else
    pass "no swallowed plugin failure in log"
  fi
fi

# --- 11. mode cards + seat rules ---------------------------------------------
echo "-- mode cards + seat rules"
# Both cards and the rules file are managed: shipped in the bundle and
# converging on every install. A missing seat copy silently drops that policy.
for f in agent/auto.md agent/goal.md AGENTS.md; do
  if [ -f "$BOOTSTRAP_DIR/$f" ]; then
    if [ ! -f "$CFG/$f" ]; then
      fail "$f shipped in bundle but missing at $CFG/$f (install.sh step 8)"
    elif cmp -s "$BOOTSTRAP_DIR/$f" "$CFG/$f"; then
      pass "$f installed and matches the bundle (managed)"
    else
      warn "$f differs from the bundle copy (managed; re-run install.sh step 8)"
    fi
  elif [ -f "$CFG/$f" ]; then
    pass "$f present at target (not shipped in this bundle revision)"
  else
    warn "$f absent at target and not shipped in bundle"
  fi
done
# Retired instruction documents (2026-10-16): their content moved into the mode
# cards. A stale seat copy would silently re-load a policy the cards now own.
for f in autonomy.md AGENTS.goal.md; do
  if [ -e "$CFG/$f" ]; then
    fail "$f present — retired (content moved into agent/auto.md + agent/goal.md); delete it"
  else
    pass "$f absent (retired)"
  fi
done
# opencode.jsonc must not carry the retired `instructions` array: it was the one
# injection path that bypassed the project trust gate (absolute and ~ entries
# load unconditionally), and the mode cards own that policy now.
if [ -f "$CFG/opencode.jsonc" ] && grep -qE '^[[:space:]]*"instructions"[[:space:]]*:' "$CFG/opencode.jsonc"; then
  fail "opencode.jsonc still lists instructions (retired; the mode cards own this policy)"
else
  pass "opencode.jsonc has no instructions array (cards own the policy)"
fi

echo
echo "== summary: $FAILS fail(s), $WARNS warn(s) =="
if [ "$FAILS" -gt 0 ]; then
  exit 1
fi
exit 0
