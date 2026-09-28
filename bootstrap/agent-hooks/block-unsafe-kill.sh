#!/usr/bin/env bash
# PreToolUse guard shared by every coding agent on this box.
# Refuses pattern-based process kills: the pattern string sits in the argv of
# the shell that runs it (agents execute whole scripts as `bash -c "<text>"`),
# so the matcher hits its own ancestor and SIGTERM kills the session.
# Protocol: event JSON on stdin. Deny = JSON on stdout + reason on stderr + exit 2.
set -uo pipefail
set -f   # no glob expansion: segments are data, not patterns

payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

cmd="$(printf '%s' "$payload" | jq -r '
  [ .tool_input.command, .tool_input.cmd, .tool_input.command_line,
    .input.command, .arguments.command, .args.command, .command ]
  | map(select(type == "string")) | first // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

PRE="$(cat <<'EOF'
(^|[[:space:];|&()"'`$])
EOF
)"
KILL="${PRE}(kill|killall|xargs)[[:space:];|-]"
READONLY=" grep rg ag ack fgrep egrep jq cat head tail less more nl wc sed awk echo printf true "

has() { printf '%s' "$cmd" | grep -qE "$1"; }

# git commit -m <message>: the message is pure data, not operators. An agent
# documenting a kill fix ("render_slices 用 pidfile 替 pkill -f …") had its
# commit DENIED because the message body carries `pkill` + a `-f`-shaped token;
# the retry dropped the `git add` half and shipped a stale snapshot (2026-09-16
# incident). Mask everything after the -m/--message=/-am flag to end of line.
# Chained commands (`&& …`) are safe: segments() splits on & before scanning.
cmd="$(printf '%s' "$cmd" | sed -E '
  s/((^|[[:space:]])git[[:space:]][^;&|]*commit[[:space:]]+(-[A-Za-z]+[[:space:]]+)*)-[ace]*m([[:space:]][^;&|]*)?([;&|].*)?$/\1-m <msg-masked>\5/
  s/((^|[[:space:]])git[[:space:]][^;&|]*commit[[:space:]][^;&|]*)--message[^;&|]*([;&|].*)?$/\1--message=<msg-masked>\3/')"

# Split into pipeline / statement segments, one per line.
segments() { printf '%s' "$cmd" | tr '|;&' '\n\n\n'; }

# Segments whose leading program is a read-only inspector treat the pattern as
# data, not as an operator. Command substitution or a kill voids the exemption.
is_data_segment() {
  local first
  first="$(printf '%s' "$1" | awk '{print $1; exit}')"
  case "$READONLY" in *" $first "*) ;; *) return 1 ;; esac
  case "$1" in *'$('* | *'`'*) return 1 ;; esac
  printf '%s' "$1" | grep -qE "$KILL" && return 1
  return 0
}

# Does any *token* of this segment carry the flag? Catches `-f`, `-9f`, `-fx`,
# `--full` in any position, so `pkill -9 -f x` and `pkill --signal TERM -f x`
# cannot slip past by inserting flags before it.
has_flag() {
  local w
  for w in $1; do
    case "$w" in
      "--$3") return 0 ;;
      --*) : ;;
      -*) case "$w" in *"$2"*) return 0 ;; esac ;;
    esac
  done
  return 1
}

# Segments that invoke $1 as a command word (quoted occurrences count too:
# `bash -c "pkill -f x"` still ends up in a real argv).
segs_with() {
  segments | grep -E "${PRE}$1"'([[:space:]]|$)' || true
}

scan_flag() { # $1=program $2=short letter $3=long name -> 0 if a live segment carries it
  local seg
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    is_data_segment "$seg" && continue
    has_flag "$seg" "$2" "$3" && return 0
  done < <(segs_with "$1")
  return 1
}

# gateway.cgroup_cleanup (hermes) SIGKILLs every PID in the caller's own
# cgroup — it is the gateway unit's ExecStopPost, never a shell command.
# From an agent shell the caller's cgroup IS the agent's process tree
# (2026-09-19: three opencode TUI deaths, "Process Exited from Signal 9").
# Commit messages are already masked above; reading the file is a data segment.
has_live_cgroup_cleanup() {
  local seg
  while IFS= read -r seg || [ -n "$seg" ]; do
    [ -n "$seg" ] || continue
    is_data_segment "$seg" && continue
    case "$seg" in *cgroup_cleanup*) return 0 ;; esac
  done < <(segments)
  return 1
}

reason=""
if has_live_cgroup_cleanup; then
  reason="gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup — from an agent shell that is the agent's own process tree. It is the hermes-gateway unit's ExecStopPost; run it only via systemctl --user stop/restart hermes-gateway-penetrate."
elif scan_flag pkill f full; then
  reason="pkill -f matches the full cmdline of every process, including the shell running this very command."
elif has "$KILL" && scan_flag pgrep f full; then
  reason="pgrep -f combined with kill on the same command line: the pattern still sits in the killing shell's own argv."
elif scan_flag killall r regex; then
  reason="killall -r matches by regex from inside a cmdline that contains the same text."
elif has "${PRE}ps[[:space:]]" && has '\|[[:space:]]*grep' && has "$KILL" \
  && ! has 'grep[^|;&]*[[:space:]](-[^[:space:]]*f|--file)'; then
  reason="ps | grep <literal> | kill: grep matches itself and the wrapping shell's argv."
fi
[ -n "$reason" ] || exit 0

fix="$(cat <<'EOF'
Do NOT retry the same shape. Use one of:
  1) two separate calls: `ps -eo pid=,ppid=,comm=,args=` then `kill -TERM <numeric PID>` (exclude $$ and $PPID)
  2) PID file from startup: `setsid ./prog > run.log 2>&1 & echo $! > run.pid` then `kill -- -"$(ps -o pgid= -p "$(cat run.pid)")"`
  3) pattern from a file: `ps -eo pid=,args= | grep -F -f /tmp/kill.pat | awk '{print $1}' | xargs -r kill`
  4) change the axis: `fuser -k PORT/tcp`, `systemctl kill UNIT`, `docker compose down`
Full rules: ~/.config/opencode/AGENTS.md
EOF
)"
msg="$reason $fix"

jq -cn --arg r "$msg" \
  '{decision:"deny", reason:$r,
    hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$r}}'
printf '%s\n' "$msg" >&2
exit 2
