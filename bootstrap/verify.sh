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
REPO_ROOT=$(cd "$BOOTSTRAP_DIR/.." && pwd -P)
# Every ancestor up to `stop` must not be group/world-writable: a writable
# parent lets another local user replace an otherwise safe target. (The target
# file's ownership is checked separately; ancestors above the home are often
# root-owned and are deliberately out of scope.)
parents_safe() {
  local dir="$1" stop="$2" owner
  # Callers pass readlink -f output; a relative or empty value would loop
  # forever on dirname "." — reject it rather than hang the audit.
  case "$dir" in
    /*) ;;
    *) return 1 ;;
  esac
  while :; do
    [ -z "$(find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    # A foreign-owned 0755 ancestor can rename or replace the target even
    # though it is not group/world-writable. Root-owned system ancestors are
    # the expected exception.
    owner=$(stat -c '%u' "$dir" 2>/dev/null) || return 1
    [ "$owner" = "$(id -u)" ] || [ "$owner" = "0" ] || return 1
    [ "$dir" = "$stop" ] && return 0
    [ "$dir" = "/" ] && return 0
    dir=$(dirname "$dir")
  done
}
# Canonicalized homes for every comparison below: a hardcoded path from the
# install machine (machine A's /home/eric) must never satisfy a scratch --home.
canon() {
  # Resolve the whole path, not only its parent: `--home` itself can be a
  # symlink, and install.sh canonicalizes TARGET_HOME before writing paths.
  # Only directories can be `cd`-ed into; for a file fall through to the
  # parent-resolution branch (canon "$DB" / canon "$resolved" are files).
  if [ -d "$1" ]; then (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"; return; fi
  local d b
  d=$(dirname "$1"); b=$(basename "$1")
  if [ -d "$d" ]; then printf '%s/%s\n' "$(cd "$d" 2>/dev/null && pwd -P)" "$b"; else printf '%s\n' "$1"; fi
}
TARGET_HOME_R=$(canon "$TARGET_HOME")
REAL_HOME_R=""
[ -n "${HOME:-}" ] && REAL_HOME_R=$(canon "$HOME")
CFG="$TARGET_HOME_R/.config/opencode"
DATA="$TARGET_HOME_R/.local/share/opencode"
DB="$DATA/opencode-main.db"
LOG="$DATA/log/opencode.log"
GUARD="$TARGET_HOME_R/.config/agent-hooks/block-unsafe-kill.sh"

FAILS=0
WARNS=0

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '      %s\n' "$*"; }

# The DB holds the credential as plaintext JSON in SQLite, and the log can
# carry session data. The binary chmods the DB to 0600 only when it opens it,
# which is after this audit, so a group/world-accessible copy from an older
# build or a manual copy must fail here. The -wal/-shm sidecars carry the same
# plaintext rows and are opened by the probe too.
STORE_SAFE=1
for f in "$DB" "$DB-wal" "$DB-shm" "$LOG"; do
  if [ -e "$f" ] && [ ! -L "$f" ]; then
    if [ "$(stat -c '%u' "$f" 2>/dev/null)" != "$(id -u)" ]; then
      fail "$f is not owned by the current user"
      STORE_SAFE=0
    fi
    db_mode=$(stat -c '%a' "$f" 2>/dev/null)
    if [ -n "$db_mode" ] && [ $((0$db_mode & 077)) -ne 0 ]; then
      fail "$f is group/world-accessible (it can carry credentials or session data)"
      STORE_SAFE=0
    fi
  fi
done

# A symlinked store path can redirect the DB probe and `auth list` outside the
# target home (and `auth list` may migrate the DB). Refuse before section 5
# opens it; section 7 still runs the detailed audit. STORE_SAFE=0 skips the
# DB-opening probes below. The config/plugin roots are loaded by the server
# that `auth list` starts, so they gate the probe too; `.cache` is not a DB
# path and stays out of this list.
for f in "$TARGET_HOME_R/.local" "$TARGET_HOME_R/.local/share" "$TARGET_HOME_R/.local/state" \
  "$DATA" "$DATA/log" "$DB" "$DB-wal" "$DB-shm" "$LOG" \
  "$TARGET_HOME_R/.config" "$CFG" "$CFG/plugin"; do
  if [ -L "$f" ]; then
    fail "store path is a symlink: $f (replace it with a real path)"
    STORE_SAFE=0
  fi
done

echo "== verify opencode seat =="
echo "target home: $TARGET_HOME"
echo

# --- 1. toolchain deps -------------------------------------------------------
echo "-- deps"
missing=""
for c in jq bun git python3 curl timeout; do
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
  # Pin every XDG root: `debug paths db` reads XDG_DATA_HOME, and an auditor
  # shell that exports a different root would probe a different store. Clear
  # the config overrides for the same reason.
  env -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_TEST_HOME \
    HOME="$TARGET_HOME" \
    XDG_DATA_HOME="$TARGET_HOME/.local/share" \
    XDG_CONFIG_HOME="$TARGET_HOME/.config" \
    XDG_STATE_HOME="$TARGET_HOME/.local/state" \
    XDG_CACHE_HOME="$TARGET_HOME/.cache" \
    OPENCODE_DB=opencode-main.db \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    "$OC_BIN" "$@"
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
DB_PATH_OK=0
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
      DB_PATH_OK=1
    elif [ -z "$resolved" ]; then
      warn "db path produced no path (inconclusive): $errtail"
    else
      fail "db path resolved to '$resolved' (expected $DB) $errtail"
    fi
  else
    warn "db path resolution skipped (no binary)"
  fi
  if [ "$STORE_SAFE" -eq 1 ] && command -v python3 >/dev/null 2>&1; then
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
        fail "placeholder keys not re-seeded yet: $ph (README 'Secrets re-seed')"
      fi
      ;;
  esac
fi

# --- 6a. DB credential (V2 stores credentials in the DB) --------------------
echo "-- DB credential"
if [ ! -f "$DB" ]; then
  fail "canonical DB not present; credentials not imported (README 'auth import')"
elif [ -z "$OC_BIN" ]; then
  fail "opencode binary missing; cannot query the DB credential"
elif [ "$DB_PATH_OK" -ne 1 ]; then
  # A V1 binary's `auth list` opens/migrates the DB; without a verified V2
  # `debug paths db` result, refuse to touch it.
  fail "DB path not verified (V1 binary or non-canonical path); refusing auth list --standalone"
elif [ "$STORE_SAFE" -ne 1 ]; then
  warn "DB credential check skipped: a store path is a symlink (see the FAIL above)"
elif ! command -v python3 >/dev/null 2>&1; then
  warn "python3 missing; cannot parse the DB credential list"
else
  auth_json=$(mktemp) || auth_json=""
  auth_err=$(mktemp) || auth_err=""
  if [ -n "$auth_json" ] && [ -n "$auth_err" ] &&
    timeout 30 env -u OPENCODE_SESSION_TOKEN -u OPENCODE_SESSION_ID \
      -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_TEST_HOME \
      HOME="$TARGET_HOME" \
      XDG_DATA_HOME="$TARGET_HOME/.local/share" \
      XDG_CONFIG_HOME="$TARGET_HOME/.config" \
      XDG_STATE_HOME="$TARGET_HOME/.local/state" \
      XDG_CACHE_HOME="$TARGET_HOME/.cache" \
      OPENCODE_DB="opencode-main.db" \
      OPENCODE_DISABLE_MODELS_FETCH=1 \
      "$OC_BIN" auth list --standalone --format json >"$auth_json" 2>"$auth_err"; then
    if python3 - "$auth_json" <<'PYEOF'
import json, sys
try:
    integrations = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
# An env-backed connection (`type: "env"`) is not the imported DB credential:
# the provider entry exists either way, so require a stored credential.
sys.exit(0 if any(
    item.get("id") == "deepseek"
    and any(conn.get("type") == "credential" for conn in item.get("connections") or [])
    for item in integrations
) else 1)
PYEOF
    then
      pass "DB credential present (deepseek, type=credential)"
    else
      fail "DB has no stored deepseek credential (env-only or missing); run the auth import step (README 'Secrets re-seed')"
    fi
  else
    fail "auth list failed; check the DB credential (README 'auth import'): $([ -n "$auth_err" ] && head -c 200 "$auth_err" 2>/dev/null)"
  fi
  [ -z "$auth_json" ] || rm -f "$auth_json"
  [ -z "$auth_err" ] || rm -f "$auth_err"
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

# A symlinked cli.json is a supported seed layout (dotfiles), but its target
# decides which plugins the TUI loads: a foreign-owned or group/world-writable
# target is not trustworthy.
if [ -L "$CFG/cli.json" ]; then
  cli_target=$(readlink -f "$CFG/cli.json" 2>/dev/null || true)
  if [ -z "$cli_target" ] || [ ! -f "$cli_target" ]; then
    fail "cli.json is a dangling symlink ($(readlink "$CFG/cli.json" 2>/dev/null))"
  elif [ "$(stat -c '%u' "$cli_target" 2>/dev/null)" != "$(id -u)" ] ||
    [ -n "$(find "$cli_target" -maxdepth 0 -perm /022 2>/dev/null)" ] ||
    ! parents_safe "$(dirname "$cli_target")" "$TARGET_HOME_R"; then
    fail "cli.json target $cli_target is not owned by the current user, is group/world-writable, or has a writable parent"
  fi
fi
if [ -f "$CFG/cli.json" ]; then
  # The CLI loader decodes the WHOLE Info schema and falls back to defaults if
  # any field is invalid; checking only the two policy fields would PASS a file
  # the loader silently discarded (e.g. session.verbosity: "verbose"). Use the
  # fork's own schema/decoder through bun, and accept JSONC exactly as the
  # loader does (comments, trailing commas). A hand-rolled stripper can merge
  # tokens around a comment or mis-handle a trailing comma before a comment.
  cli_check_dir="$BOOTSTRAP_DIR/../packages/cli"
  if [ ! -d "$cli_check_dir" ]; then
    warn "cli.json schema check skipped: packages/cli is not present in this checkout"
  elif ! command -v bun >/dev/null 2>&1; then
    warn "cli.json schema check skipped: bun is not on PATH"
  elif cli_check_error=$( cd "$cli_check_dir" && bun -e '
import { parse } from "jsonc-parser"
import { Info } from "./src/config/schema.ts"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
const errors = []
const value = parse(readFileSync(process.argv[1], "utf8"), errors, { allowTrailingComma: true })
if (errors.length) process.exit(1)
const decoded = Schema.decodeUnknownOption(Info)(value)
if (decoded._tag === "None") process.exit(1)
const info = decoded.value
if (info.keybinds?.["app.exit"] !== "none") process.exit(1)
if (info.session?.thinking !== "show") process.exit(1)
' "$CFG/cli.json" 2>&1 ); then
    pass "cli.json decodes with the CLI schema and keeps the fork policy (app.exit=none, session.thinking=show)"
  elif printf '%s' "$cli_check_error" | grep -Eq "Cannot find module|Cannot find package|MODULE_NOT_FOUND|ENOENT|No such file or directory"; then
    # The checker imports the checkout's own schema and its dependencies; an
    # uninstalled checkout cannot judge the file. Do not tell the operator to
    # overwrite a good config because the toolchain is missing.
    warn "cli.json schema check skipped: the checkout's dependencies are not installed"
  else
    fail "cli.json is invalid under the CLI schema or lost the fork policy (app.exit=none, session.thinking=show); re-seed it from the repo root"
  fi
else
  # A missing cli.json is not a cosmetic warning: the TUI then falls back to
  # upstream defaults, including the exit key and hidden thinking. install.sh
  # seeds it, so an installed seat must have it.
  fail "cli.json missing (TUI keybinds + fork policy; install.sh seeds it from the repo root)"
fi

# --- 8. plugins --------------------------------------------------------------
echo "-- plugin/"
# A symlinked plugin directory would make every child look present and let
# install_file write into the link target; fail it once and reuse the verdict.
PLUGIN_LINK=0
if [ -L "$CFG/plugin" ]; then
  fail "$CFG/plugin is a symlink — plugins must be a real directory"
  PLUGIN_LINK=1
fi
# The config root and the other written directories are checked too: a
# symlinked root makes every child check follow the link, and install.sh
# refuses to write through it.
for d in "$TARGET_HOME_R/.config" "$CFG" "$CFG/shell" "$TARGET_HOME_R/.config/environment.d" "$TARGET_HOME_R/.config/agent-hooks" \
  "$TARGET_HOME_R/.local" "$TARGET_HOME_R/.local/share" "$TARGET_HOME_R/.local/state" \
  "$TARGET_HOME_R/.local/bin" "$DATA" "$TARGET_HOME_R/.cache" "$DATA/log" \
  "$TARGET_HOME_R/.claude" "$TARGET_HOME_R/.zcode" "$TARGET_HOME_R/.grok" "$TARGET_HOME_R/.grok/hooks" \
  "$TARGET_HOME_R/.kimi-code"; do
  if [ -L "$d" ]; then
    fail "$d is a symlink — replace it with a real directory"
  fi
done
# install.sh refuses these ancestors; a symlinked parent redirects the DB and
# auth.json even when the final component is a real directory.
for f in "$DB" "$LOG"; do
  if [ -L "$f" ]; then
    fail "$f is a symlink — replace it with a regular file"
  fi
done
# The directory mode matters even when the files are correct: a
# group/world-writable directory lets another local user replace a plugin.
for d in "$TARGET_HOME_R" "$TARGET_HOME_R/.config" "$CFG" "$CFG/plugin" "$CFG/skills" "$CFG/agent" "$CFG/command" "$CFG/shell" "$CFG/lib" \
  "$TARGET_HOME_R/.config/environment.d" "$TARGET_HOME_R/.config/agent-hooks" \
  "$TARGET_HOME_R/.local" "$TARGET_HOME_R/.local/share" "$TARGET_HOME_R/.local/state" \
  "$TARGET_HOME_R/.local/bin" "$DATA" "$DATA/log" "$TARGET_HOME_R/.cache" \
  "$TARGET_HOME_R/.claude" "$TARGET_HOME_R/.zcode" "$TARGET_HOME_R/.grok" "$TARGET_HOME_R/.grok/hooks" \
  "$TARGET_HOME_R/.kimi-code"; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then
    if [ "$(stat -c '%u' "$d" 2>/dev/null)" != "$(id -u)" ]; then
      fail "$d is not owned by the current user"
    fi
    if [ -n "$(find "$d" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
      fail "$d is group/world-writable"
    fi
  fi
done
# Nested seat directories (skills/<name>, plugin subdirs) matter too: a
# writable skill directory lets another local user add or replace files.
if [ -d "$CFG" ] && [ ! -L "$CFG" ]; then
  while IFS= read -r nested; do
    fail "$nested is group/world-writable or not owned by the current user"
  done < <(find "$CFG" -mindepth 1 -type d \( -perm /022 -o ! -user "$(id -u)" \) 2>/dev/null)
fi
# Executed/sourced files and files that decide which plugins load get the same
# owner/mode gate even when their content matches the bundle. `install.sh --link`
# and the documented live-edit layout may install a file symlink into this
# checkout; allow that when the resolved target is user-owned and not
# group/world-writable.
link_ok() {
  local target
  target=$(readlink -f "$1" 2>/dev/null || true)
  [ -n "$target" ] && [ -f "$target" ] || return 1
  [ "$(stat -c '%u' "$target" 2>/dev/null)" = "$(id -u)" ] || return 1
  [ -z "$(find "$target" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
  case "$target" in
    "$REPO_ROOT"/*) : ;;
    *) return 1 ;;
  esac
  parents_safe "$(dirname "$target")" "$REPO_ROOT"
}
for f in "$TARGET_HOME_R/.local/bin/opencode" "$TARGET_HOME_R/.config/agent-hooks/block-unsafe-kill.sh" \
  "$CFG/shell/bashrc-opencode-block.sh" "$CFG/lib/drawio.py" "$CFG/opencode.jsonc" "$CFG/AGENTS.md"; do
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then
    fail "$f missing"
  elif [ -L "$f" ]; then
    # The README's SYMLINK RULE allows individual file symlinks into a git
    # checkout (live-edit); accept one when the resolved target is user-owned,
    # not group/world-writable, and its ancestors are safe.
    if link_ok "$f"; then
      pass "$f is a symlink into the checkout (target and parents owned, not group/world-writable)"
    else
      fail "$f is a symlink — replace it with a real file"
    fi
  elif [ ! -f "$f" ]; then
    # A directory/FIFO at an executed/sourced path passes -e and the mode
    # check, and the later [ -f ] content comparison is silently skipped.
    fail "$f is not a regular file"
  elif [ "$(stat -c '%u' "$f" 2>/dev/null)" != "$(id -u)" ]; then
    fail "$f is not owned by the current user"
  elif [ -n "$(find "$f" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
    fail "$f is group/world-writable"
  fi
done
# The cli.json seed may be a dotfiles symlink (its target was checked above).
if [ -f "$CFG/cli.json" ] && [ ! -L "$CFG/cli.json" ]; then
  if [ "$(stat -c '%u' "$CFG/cli.json" 2>/dev/null)" != "$(id -u)" ] ||
    [ -n "$(find "$CFG/cli.json" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
    fail "cli.json is not owned by the current user or is group/world-writable"
  fi
fi
# A group/world-writable skill, agent card, command or environment file can
# inject instructions or environment.
for d in "$CFG/skills" "$CFG/agent" "$CFG/command" "$TARGET_HOME_R/.config/environment.d"; do
  if [ -d "$d" ] && [ ! -L "$d" ] && [ -n "$(find "$d" -type f \( -perm /022 -o ! -user "$(id -u)" \) 2>/dev/null | head -n 1)" ]; then
    fail "$d contains a group/world-writable or foreign-owned file"
  fi
  if [ -d "$d" ] && [ ! -L "$d" ]; then
    # find -type f does not follow symlinks; a link to a writable/foreign
    # target would otherwise escape the owner/mode gate.
    while IFS= read -r link; do
      # A directory symlink (an operator's extra skill) is a different layout;
      # the bundle-skill loop above already rejects one for a managed skill.
      [ -d "$link" ] && continue
      if ! link_ok "$link"; then
        fail "$link is a symlink to a target outside the checkout or with unsafe owner/mode/parents"
      fi
    done < <(find "$d" -type l 2>/dev/null)
  fi
done
# The four hook configs decide whether the kill-guard runs; an existing one must
# not be group/world-writable. Missing files are fine (install.sh wires only the
# configs that exist). stat -L follows a dotfiles symlink to the real target.
for f in "$TARGET_HOME_R/.claude/settings.json" "$TARGET_HOME_R/.zcode/settings.json" \
  "$TARGET_HOME_R/.grok/hooks/block-unsafe-kill.json" "$TARGET_HOME_R/.kimi-code/config.toml"; do
  if [ -L "$f" ] && [ ! -e "$f" ]; then
    # `-e` follows the link: a dangling dotfiles link would otherwise be
    # skipped while the kill-guard is silently unwired.
    fail "$f is a dangling symlink — the kill-guard would be unwired"
  elif [ -e "$f" ] && [ ! -f "$f" ]; then
    # A directory/FIFO here passes the existence check while the guard is
    # unwired; section 7's surface check only warns about "absent".
    fail "$f is not a regular file — the kill-guard would be unwired"
  elif [ -e "$f" ]; then
    if [ "$(stat -L -c '%u' "$f" 2>/dev/null)" != "$(id -u)" ]; then
      fail "$f is not owned by the current user"
    fi
    hook_mode=$(stat -L -c '%a' "$f" 2>/dev/null)
    if [ -n "$hook_mode" ] && [ $((0$hook_mode & 022)) -ne 0 ]; then
      fail "$f is group/world-writable"
    fi
    hook_target=$(readlink -f "$f" 2>/dev/null || true)
    if [ -n "$hook_target" ] && ! parents_safe "$(dirname "$hook_target")" "$TARGET_HOME_R"; then
      fail "$f has a group/world-writable parent directory"
    fi
  fi
done
# The kill-guard script is executed by every wired tool and the sourced wrapper
# runs in every shell; content matters, not only the executable bit.
if [ -f "$GUARD" ] && [ ! -L "$GUARD" ] && [ -f "$BOOTSTRAP_DIR/agent-hooks/block-unsafe-kill.sh" ]; then
  escaped_home=$(printf '%s' "$TARGET_HOME_R" | sed 's/[\\&|]/\\&/g')
  if sed "s|/home/eric|$escaped_home|g" "$BOOTSTRAP_DIR/agent-hooks/block-unsafe-kill.sh" | cmp -s - "$GUARD"; then
    pass "agent-hooks/block-unsafe-kill.sh matches the bundle (home rewritten)"
  else
    fail "agent-hooks/block-unsafe-kill.sh differs from the bundle (stale or tampered)"
  fi
fi
if [ -f "$CFG/shell/bashrc-opencode-block.sh" ] && [ ! -L "$CFG/shell/bashrc-opencode-block.sh" ] &&
  [ -f "$BOOTSTRAP_DIR/shell/bashrc-opencode-block.sh" ]; then
  if cmp -s "$BOOTSTRAP_DIR/shell/bashrc-opencode-block.sh" "$CFG/shell/bashrc-opencode-block.sh"; then
    pass "shell/bashrc-opencode-block.sh matches the bundle"
  else
    fail "shell/bashrc-opencode-block.sh differs from the bundle (stale or tampered)"
  fi
fi
for f in block-unsafe-kill.ts secret-path-guard.ts local-tools.ts skill-hints.ts; do
  if [ "$PLUGIN_LINK" -eq 1 ]; then
    : # the parent failure above covers every plugin
  elif [ -L "$CFG/plugin/$f" ]; then
    fail "plugin/$f is a symlink — replace it with the bundled copy"
  elif [ ! -f "$CFG/plugin/$f" ]; then
    fail "plugin/$f missing"
  elif [ "$(stat -c '%u' "$CFG/plugin/$f" 2>/dev/null)" != "$(id -u)" ] ||
    [ -n "$(find "$CFG/plugin/$f" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
    fail "plugin/$f is not owned by the current user or is group/world-writable"
  elif [ ! -f "$BOOTSTRAP_DIR/plugin/$f" ]; then
    fail "bundled plugin/$f is missing; cannot verify the installed copy"
  elif ! cmp -s "$BOOTSTRAP_DIR/plugin/$f" "$CFG/plugin/$f"; then
    fail "plugin/$f differs from the bundled copy (stale or tampered; reinstall from bootstrap/plugin/$f)"
  else
    pass "plugin/$f matches the bundled copy"
  fi
done
# open-code-review.ts gets a content-aware verdict below. The generic `-f` test
# follows symlinks and would report PASS before the symlink check FAILs.
# The V2 loader accepts only `{id, setup}` (or `{id, effect}`). The upstream
# OCR plugin exports a V1 `server`, which the V2 loader rejects; a symlink to
# that checkout would silently disable the automatic gate. Check the symlink
# first so a link is never reported as both PASS and FAIL.
if [ "$PLUGIN_LINK" -eq 1 ]; then
  : # the parent failure above covers this file too
elif [ -L "$CFG/plugin/open-code-review.ts" ]; then
  fail "plugin/open-code-review.ts is a symlink — replace it with the bundled copy"
elif [ -f "$CFG/plugin/open-code-review.ts" ] &&
  [ "$(stat -c '%u' "$CFG/plugin/open-code-review.ts" 2>/dev/null)" = "$(id -u)" ] &&
  [ -z "$(find "$CFG/plugin/open-code-review.ts" -maxdepth 0 -perm /022 2>/dev/null)" ] &&
  cmp -s "$BOOTSTRAP_DIR/plugin/open-code-review.ts" "$CFG/plugin/open-code-review.ts" &&
  grep -qE "id:[[:space:]]*[\"']open-code-review[\"']" "$CFG/plugin/open-code-review.ts" &&
  { grep -qE '(^|[^A-Za-z0-9_$])setup[[:space:]]*[:(,}]' "$CFG/plugin/open-code-review.ts" ||
    grep -qE '(^|[^A-Za-z0-9_$])effect[[:space:]]*[:,}]' "$CFG/plugin/open-code-review.ts"; } &&
  ! grep -qE '^[[:space:]]*server[[:space:]]*:' "$CFG/plugin/open-code-review.ts"; then
  pass "plugin/open-code-review.ts is the V2 {id, setup|effect} port and matches the bundle"
else
  fail "plugin/open-code-review.ts differs from the bundle or is not the V2 {id, setup|effect} port (V1 server export, symlink, stale copy, or missing setup/effect)"
fi
# Skills freeze (2026-10-16): the auto-updater is removed on purpose. A stale
# seat copy would keep fetching, re-vendoring, and committing behind the
# operator's back.
if [ "$PLUGIN_LINK" -eq 1 ]; then
  : # the parent failure above covers this file too
elif [ -e "$CFG/plugin/mpskills-update.ts" ] || [ -L "$CFG/plugin/mpskills-update.ts" ]; then
  fail "plugin/mpskills-update.ts present — removed by the skills freeze; delete it"
else
  pass "plugin/mpskills-update.ts absent (skills frozen)"
fi
# Support file and skills for the local-tools plugin (script/install-local-tools.ts;
# the drawio tool fails closed without lib/drawio.py, the skills only lose guidance).
LOCAL_SRC="$BOOTSTRAP_DIR/../dotfiles/opencode"
LIB_LINK=0
if [ -L "$CFG/lib" ]; then
  fail "$CFG/lib is a symlink — lib must be a real directory"
  LIB_LINK=1
fi
if [ "$LIB_LINK" -eq 1 ]; then
  : # the parent failure above covers lib/drawio.py
elif [ -L "$CFG/lib/drawio.py" ]; then
  fail "lib/drawio.py is a symlink — install the bundled copy (install.sh step 7b)"
elif [ -f "$CFG/lib/drawio.py" ]; then
  if [ -f "$LOCAL_SRC/lib/drawio.py" ] && cmp -s "$LOCAL_SRC/lib/drawio.py" "$CFG/lib/drawio.py"; then
    pass "lib/drawio.py matches the bundle"
  else
    fail "lib/drawio.py differs from the bundle (reinstall with install.sh step 7b)"
  fi
else
  fail "lib/drawio.py missing (drawio tool will refuse; install.sh step 7b or bun run script/install-local-tools.ts)"
fi
# The manifest is the local-edit baseline install-local-tools.ts validates; a
# symlinked/missing/tampered manifest lets a local edit pass as unchanged.
MANIFEST="$CFG/local-tools-manifest.json"
if [ -L "$MANIFEST" ]; then
  fail "local-tools-manifest.json is a symlink — replace it with a regular file"
elif [ ! -f "$MANIFEST" ]; then
  fail "local-tools-manifest.json missing (install.sh step 7b)"
elif [ "$(stat -c '%u' "$MANIFEST" 2>/dev/null)" != "$(id -u)" ] ||
  [ -n "$(find "$MANIFEST" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
  fail "local-tools-manifest.json is not owned by the current user or is group/world-writable"
elif command -v bun >/dev/null 2>&1; then
  if MANIFEST="$MANIFEST" DEST="$CFG" bun -e '
    const data = await Bun.file(process.env.MANIFEST).json().catch(() => undefined)
    const required = ["lib/drawio.py", "skills/drawio/SKILL.md", "skills/marker/SKILL.md", "skills/planning-with-files/SKILL.md"]
    if (!data || typeof data !== "object" || Array.isArray(data) || required.some((key) => typeof data[key] !== "string")) process.exit(1)
    for (const key of required) {
      const bytes = await Bun.file(process.env.DEST + "/" + key).bytes()
      if (Bun.CryptoHasher.hash("sha256", bytes, "hex") !== data[key]) process.exit(1)
    }
  ' >/dev/null 2>&1; then
    pass "local-tools-manifest.json is a regular file with valid hashes"
  else
    fail "local-tools-manifest.json hashes do not match the installed files (re-run install.sh step 7b)"
  fi
fi
# A symlinked skills parent makes every child look present; fail it once here
# and let the sections below reuse the verdict instead of blessing the children.
SKILLS_LINK=0
if [ -L "$CFG/skills" ]; then
  fail "$CFG/skills is a symlink — skills must be a real directory"
  SKILLS_LINK=1
fi
for s in drawio marker planning-with-files; do
  if [ -L "$CFG/skills/$s" ]; then
    fail "skill $s is a symlink — install the bundled copy (install.sh step 7b)"
  elif [ "$SKILLS_LINK" -eq 1 ]; then
    : # the parent failure above covers the whole tree
  elif [ -L "$CFG/skills/$s/SKILL.md" ]; then
    fail "skill $s/SKILL.md is a symlink — install the bundled copy (install.sh step 7b)"
  elif [ -f "$CFG/skills/$s/SKILL.md" ]; then
    if [ -f "$LOCAL_SRC/skills/$s/SKILL.md" ] && cmp -s "$LOCAL_SRC/skills/$s/SKILL.md" "$CFG/skills/$s/SKILL.md"; then
      pass "skill present: $s"
    else
      fail "skill $s differs from the bundle (install.sh step 7b)"
    fi
  elif [ -d "$CFG/skills/$s" ]; then
    fail "skill $s is incomplete (SKILL.md missing; install.sh step 7b)"
  else
    fail "skill missing: $s (install.sh step 7b or bun run script/install-local-tools.ts)"
  fi
done

# --- 9. skills-extra ---------------------------------------------------------
echo "-- skills-extra"
if [ "$SKILLS_LINK" -eq 1 ]; then
  : # the parent symlink failure was reported in the local-tools section
elif [ ! -d "$BOOTSTRAP_DIR/skills-extra" ]; then
  warn "skills-extra bundle missing at $BOOTSTRAP_DIR/skills-extra; cannot verify review skills"
else
  for s in "$BOOTSTRAP_DIR"/skills-extra/*/; do
    [ -d "$s" ] || continue
    [ -f "$s/SKILL.md" ] || continue
    name=$(basename "$s")
    if [ -L "$CFG/skills/$name" ]; then
      fail "skill $name is a symlink — replace it with the bundled copy (install.sh step 6)"
    elif [ -L "$CFG/skills/$name/SKILL.md" ]; then
      fail "skill $name/SKILL.md is a symlink — replace it with the bundled copy (install.sh step 6)"
    elif [ -f "$CFG/skills/$name/SKILL.md" ]; then
      if diff -r -q --no-dereference "$s" "$CFG/skills/$name" >/dev/null 2>&1; then
        pass "skill present: $name"
      else
        # install.sh step 6 never overwrites a differing skill; the operator
        # merges by hand. Report the divergence, do not fail a supported state.
        warn "skill $name differs from the bundle (local edit kept by install.sh step 6 — merge by hand)"
      fi
    elif [ -d "$CFG/skills/$name" ]; then
      fail "skill $name is incomplete (SKILL.md missing; install.sh step 6)"
    else
      fail "skill missing: $name (install.sh step 6)"
    fi
  done
fi

# --- 9a. vendored skills (frozen) -------------------------------------------
echo "-- vendored skills"
VENDORED_SKILLS="$BOOTSTRAP_DIR/../skills"
if [ "$SKILLS_LINK" -eq 1 ]; then
  : # the parent symlink failure was reported in the local-tools section
elif [ -d "$VENDORED_SKILLS" ]; then
  for s in "$VENDORED_SKILLS"/*/; do
    [ -d "$s" ] || continue
    name=$(basename "$s")
    if [ -L "$CFG/skills/$name" ]; then
      fail "vendored skill $name is a symlink — install the frozen copy"
    elif [ -L "$CFG/skills/$name/SKILL.md" ]; then
      fail "vendored skill $name/SKILL.md is a symlink — install the frozen copy"
    elif [ -f "$CFG/skills/$name/SKILL.md" ]; then
      if diff -r -q --no-dereference "$s" "$CFG/skills/$name" >/dev/null 2>&1; then
        pass "vendored skill present: $name"
      else
        fail "vendored skill $name differs from the frozen copy (install.sh never overwrites; compare with skills/$name)"
      fi
    else
      fail "vendored skill missing or incomplete: $name (install.sh step 6b)"
    fi
  done
  for f in "$VENDORED_SKILLS"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ -L "$CFG/skills/$name" ]; then
      fail "vendored file $name is a symlink — install the frozen copy"
    elif cmp -s "$f" "$CFG/skills/$name"; then
      pass "vendored file present: $name"
    else
      fail "vendored file $name differs from the frozen copy (install.sh step 6b)"
    fi
  done
else
  warn "vendored skills/ not found at $VENDORED_SKILLS"
fi

# --- 9b. review workflow prerequisites --------------------------------------
echo "-- review workflow"
if command -v ocr >/dev/null 2>&1; then
  # Anchor on the first version token: a greedy leading `.*` captures the last
  # `x.y.z` on a multi-token line (e.g. a trailing runtime version) and would
  # pass an old OCR because an unrelated version matched.
  ocr_version=$(timeout 30 ocr version 2>/dev/null | grep -iE 'open[- ]?code[- ]?review' | tr '[:upper:]' '[:lower:]' | sed -nE 's/^[^0-9]*open[- ]?code[- ]?review[[:space:]/:]+v?([0-9]+)\.([0-9]+)\.([0-9]+).*/\1.\2.\3/p' | head -n 1)
  if [ -n "$ocr_version" ]; then
    ocr_major=${ocr_version%%.*}
    ocr_rest=${ocr_version#*.}
    ocr_minor=${ocr_rest%%.*}
    ocr_patch=${ocr_rest#*.}
    if [ "$ocr_major" -gt 1 ] ||
      { [ "$ocr_major" -eq 1 ] && { [ "$ocr_minor" -gt 13 ] || { [ "$ocr_minor" -eq 13 ] && [ "$ocr_patch" -ge 1 ]; }; }; }; then
      pass "ocr on PATH (v$ocr_version)"
    else
      fail "ocr is too old (v$ocr_version); the gate needs v1.13.1+ — npm install -g @alibaba-group/open-code-review@latest"
    fi
  else
    # Fail closed: an unparseable version cannot prove the gate's minimum.
    fail "ocr on PATH but its version could not be parsed; the gate needs v1.13.1+ — npm install -g @alibaba-group/open-code-review@latest"
  fi
  # `ocr llm test` makes a network call; without a timeout a hung provider
  # blocks the whole verify. The plugin's ocr_health uses the same 60 s bound.
  if timeout 60 env -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_TEST_HOME \
    HOME="$TARGET_HOME" \
    XDG_CONFIG_HOME="$TARGET_HOME/.config" \
    XDG_DATA_HOME="$TARGET_HOME/.local/share" \
    XDG_STATE_HOME="$TARGET_HOME/.local/state" \
    XDG_CACHE_HOME="$TARGET_HOME/.cache" \
    ocr llm test </dev/null >/dev/null 2>&1; then
    pass "ocr LLM connection"
  else
    warn "ocr LLM test failed; configure provider/model and run 'ocr llm test' (README Step 4b)"
  fi
else
  fail "ocr missing — the security gate cannot run; npm install -g @alibaba-group/open-code-review"
fi
if [ ! -d "$BOOTSTRAP_DIR/skills-extra" ]; then
  warn "skills-extra bundle missing; cannot verify the review skills (run from the bootstrap checkout)"
else
  for s in code-review-playbook deep-audit code-audit review-delegate; do
    if [ -L "$CFG/skills/$s" ]; then
      fail "review skill $s is a symlink — install the bundled copy (install.sh step 6)"
    elif [ "$SKILLS_LINK" -eq 1 ]; then
      : # the parent symlink failure was reported above
    elif [ -f "$CFG/skills/$s/SKILL.md" ]; then
      if diff -r -q --no-dereference "$BOOTSTRAP_DIR/skills-extra/$s" "$CFG/skills/$s" >/dev/null 2>&1; then
        pass "review skill present: $s"
      else
        # Same policy as section 9: install.sh step 6 keeps a local edit, so a
        # divergence is a supported state to merge by hand, not a failure.
        warn "review skill $s differs from the bundle (local edit kept by install.sh step 6 — merge by hand)"
      fi
    else
      fail "review skill missing: $s (install.sh step 6)"
    fi
  done
fi

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
# A symlinked agent/ directory would make every card look present and let
# install_file write into the link target; fail it once and reuse the verdict.
AGENT_LINK=0
if [ -L "$CFG/agent" ]; then
  fail "$CFG/agent is a symlink — agent cards must be a real directory"
  AGENT_LINK=1
fi
if [ -L "$CFG/command" ]; then
  fail "$CFG/command is a symlink — commands must be a real directory"
fi
for f in agent/auto.md agent/goal.md AGENTS.md; do
  case "$f" in
    agent/*)
      if [ "$AGENT_LINK" -eq 1 ]; then
        continue # the parent failure above covers this card
      fi
      ;;
  esac
  if [ -f "$BOOTSTRAP_DIR/$f" ]; then
    if [ -L "$CFG/$f" ]; then
      fail "$f is a symlink — install the bundled copy (install.sh step 8)"
    elif [ ! -f "$CFG/$f" ]; then
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
# The trust gate decides whether a project's own config, AGENTS.md chain, plugins,
# and MCP servers load at all. Absent declaration = closed, which is the intended
# default; report it so an operator is not left guessing why a project config is
# ignored (bootstrap/README.md §4 "Project trust gate").
if [ -f "$CFG/trusted-roots" ]; then
  roots=$(grep -cvE '^[[:space:]]*(#|$)' "$CFG/trusted-roots" 2>/dev/null || true)
  info "trusted-roots declares ${roots:-0} root(s): project-side discovery is open inside them"
else
  info "trusted-roots absent: project config/instructions/plugins are closed on this seat"
fi

echo
echo "== summary: $FAILS fail(s), $WARNS warn(s) =="
if [ "$FAILS" -gt 0 ]; then
  exit 1
fi
exit 0
