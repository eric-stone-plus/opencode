#!/usr/bin/env bash
# Isolated runtime for testing a V2 build. NEVER source this file; always execute it.
# Why it exists: V2's first start migrates the opencode DB in place (drops the legacy `event` rows, imports auth.json once),
# and the systemd environment pins OPENCODE_DB to the real database, so an unisolated run touches real data.
#   sandbox.sh run   <name> <binary> [args...]   run a command with a fake HOME and a clean environment
#   sandbox.sh tui   <name> <binary> [args...]   start the TUI in a detached tmux session (socket oc-<name>, session S, 200x55)
#   sandbox.sh cap   <name>                      print the TUI screen (tmux capture-pane)
#   sandbox.sh keys  <name> <tmux keys...>       send keys to the TUI
#   sandbox.sh stop  <name>                      stop tmux + every process carrying this sandbox's marker (service, children)
#   sandbox.sh clean <name>                      stop + delete the sandbox
#   sandbox.sh where <name>                      print the sandbox root
# Isolation: HOME, XDG_*, OPENCODE_TEST_HOME and OPENCODE_DB all point inside the sandbox; the real environment
# (OPENCODE_DB=opencode-main.db, proxies, flags) is NOT inherited. Only the deepseek credential is seeded.
set -u
cmd="${1:-}"; name="${2:-}"
[ -z "$cmd" ] && { sed -n 2,12p "$0" >&2; exit 2; }
[ -z "$name" ] && { echo "sandbox name required" >&2; exit 2; }
case "$name" in *[!a-zA-Z0-9_-]*) echo "bad sandbox name" >&2; exit 2;; esac
REAL_HOME="${REAL_HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
ROOT="$REAL_HOME/.local/share/oc-v2-scratch/sandboxes"; S="$ROOT/$name"; H="$S/home"
[ "${BASH_SOURCE[0]}" != "$0" ] && { echo "refusing to be sourced: run it as a command" >&2; return 2; }
marker() { echo "OC_SANDBOX=$name"; }
env_args() {
  printf '%s\0' "HOME=$H" "OPENCODE_TEST_HOME=$H" "XDG_DATA_HOME=$H/.local/share" "XDG_CONFIG_HOME=$H/.config" "XDG_STATE_HOME=$H/.local/state" "XDG_CACHE_HOME=$H/.cache" \
    "XDG_RUNTIME_DIR=$S/run" "PATH=$PATH" "TERM=${TERM:-xterm-256color}" "LANG=${LANG:-C.UTF-8}" "COLORTERM=truecolor" \
    "OPENCODE_DB=sandbox.db" "OPENCODE_DISABLE_MODELS_FETCH=1" "OPENCODE_DISABLE_AUTOUPDATE=1" "$(marker)"
}
seed() {
  mkdir -p "$H/.config/opencode" "$H/.local/share/opencode" "$H/.local/state" "$H/.cache" "$S/run"; chmod 700 "$S/run"
  [ -f "$H/.config/opencode/opencode.jsonc" ] || cp "$REAL_HOME/.config/opencode/opencode.jsonc" "$H/.config/opencode/opencode.jsonc"
}
# A fresh V2 DB skips data migrations, so credentials are seeded through `auth import` (deepseek only), once per sandbox.
seed_credentials() { # $1 = binary
  [ -f "$S/.credentials-seeded" ] && return 0
  SRC="$REAL_HOME/.local/share/opencode/auth.json" bun -e 'const a=JSON.parse(require("fs").readFileSync(process.env.SRC,"utf8"));if(!a.deepseek?.key)process.exit(1);process.stdout.write(JSON.stringify([{id:"crd_sandboxdeepseek01",integrationID:"deepseek",label:"API key",active:true,value:{type:"key",key:a.deepseek.key}}]))' \
    | env -i $(env_args | tr '\0' ' ') "$1" auth import --standalone >/dev/null 2>&1 && touch "$S/.credentials-seeded" || echo "warning: credential seeding failed" >&2
}
guard() { # every resolved path must live inside the sandbox
  while IFS= read -r -d '' kv; do case "$kv" in HOME=*|OPENCODE_TEST_HOME=*|XDG_*) v="${kv#*=}"; case "$v" in "$S"/*) ;; *) echo "isolation check failed: $kv" >&2; exit 3;; esac;; esac; done < <(env_args)
}
killall_marked() {
  for p in $(ls /proc | grep -E '^[0-9]+$'); do [ "$p" = "$$" ] && continue; tr '\0' '\n' 2>/dev/null < /proc/$p/environ | grep -qx "$(marker)" && kill "$p" 2>/dev/null; done
  sleep 1
  for p in $(ls /proc | grep -E '^[0-9]+$'); do [ "$p" = "$$" ] && continue; tr '\0' '\n' 2>/dev/null < /proc/$p/environ | grep -qx "$(marker)" && kill -9 "$p" 2>/dev/null; done; true
}
case "$cmd" in
  run)  bin="${3:?binary required}"; shift 3; seed; guard; seed_credentials "$bin"; cd "$H"; exec env -i $(env_args | tr '\0' ' ') "$bin" "$@" ;;
  tui)  bin="${3:?binary required}"; shift 3; seed; guard; seed_credentials "$bin"; cd "$H"
        tmux -L "oc-$name" kill-server 2>/dev/null
        tmux -L "oc-$name" new-session -d -x 200 -y 55 -s S -c "$H" "exec env -i $(env_args | tr '\0' ' ') '$bin' $*"
        echo "tui started: tmux -L oc-$name (session S)" >&2 ;;
  cap)  tmux -L "oc-$name" capture-pane -p -t S ;;
  keys) shift 2; tmux -L "oc-$name" send-keys -t S "$@" ;;
  stop) tmux -L "oc-$name" kill-server 2>/dev/null; killall_marked; echo "stopped '$name'" >&2 ;;
  clean) "$0" stop "$name"; rm -rf "$S"; echo "removed '$name'" >&2 ;;
  where) echo "$S" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
