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

# jq is the event parser. Missing or erroring jq must not look like "no
# command" in silence: warn and still pass (a hook that denies everything is
# worse than a degraded guard). The harnesses fail loudly on this warning.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "block-unsafe-kill: jq unavailable, guard degraded" >&2
  exit 0
fi

cmd="$(printf '%s' "$payload" | jq -r '
  [ .tool_input.command, .tool_input.cmd, .tool_input.command_line,
    .input.command, .arguments.command, .args.command, .command ]
  | map(select(type == "string")) | first // empty' 2>/dev/null)"
jq_rc="$?"
# jq can exit non-zero AND still have extracted a command: a trailing-garbage
# payload (`{"…valid json…"} TRAIL`) parses the object, prints the command,
# then errors. A non-empty extraction must be scanned, never waved through.
# Only an empty result with a failing jq is the documented degraded mode:
# jq is present here (checked above), the input itself would not parse.
if [ -z "$cmd" ] && [ "$jq_rc" -ne 0 ]; then
  printf '%s\n' "block-unsafe-kill: unparseable hook input, guard skipped" >&2
  exit 0
fi

# Same scope as the TS mirror: only shell/executor tool input is ours. The
# name must be matched loosely — this hook serves several harnesses whose
# shell tools are named differently (opencode `bash`, Claude/ZCode/Kimi
# `Bash`, Grok `run_terminal_command`) — while `Edit`/`read_file`/`grep`
# inputs are ignored even when they carry a `command` field. A missing
# tool_name stays in scope: an unknown tool is scanned rather than waved
# through.
tool="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty' 2>/dev/null)"
tool_lc="$(printf '%s' "$tool" | tr '[:upper:]' '[:lower:]')"
case "$tool_lc" in
  ""|bash|sh|zsh|dash|ksh|*bash*|*shell*|*terminal*|*command*|*exec*|*eval*|*console*|*script*|*repl*|*runner*|*run*) : ;;
  *) exit 0 ;;
esac

[ -n "$cmd" ] || exit 0

PRE="$(cat <<'EOF'
(^|[[:space:];|&()"'`$/])
EOF
)"
KILL="${PRE}(kill|killall)([[:space:];|-]|$)"
PSRE="${PRE}ps[[:space:]]"
PIPE_GREP='\|[[:space:]]*grep'
GREP_FROM_FILE='grep[^|;&]*[[:space:]](-[^[:space:]]*f|--file)'
READONLY=" grep rg ag ack fgrep egrep jq cat head tail less more nl wc sed awk echo printf true sort uniq "
# A quoted argument to one of these is OPERATOR text (it will be executed),
# not data: keep it live. `bash|sh|zsh|dash -c` payloads, `timeout … bash -c`
# (the -c rule sees through the prefix), `eval`, and `ssh` remote commands.
# env doubles as an interpreter via --split-string/-S (the split text runs as a
# command line), so it is tracked with the interpreter set; its -S payload is
# recognized by the `s` payload letter below.
CODE_SHELLS=" bash sh zsh dash ksh python python3 python2 pypy pypy3 env "
PY_WORDS=" python python3 python2 pypy pypy3 "
CODE_E=" perl ruby node deno lua "
PAYLOAD_CMDS=" eval ssh "
# Wrappers that only schedule the real command (sudo nice -n 5 pkill …): a
# kill-family word after one of these is still an invocation. Prefix executors
# (taskset/nsenter/setpriv/strace/…) exec their argv unchanged, so they are
# wrappers too. busybox provides kill-family applets (`busybox pkill -f x`).
WRAPPER_WORDS=" sudo doas env nice nohup time timeout stdbuf setsid command builtin exec xargs busybox nsenter setpriv unshare taskset ionice chrt prlimit numactl strace ltrace setarch watch systemd-run "
# Words whose identity matters to the guard even when quoted: a quoted
# `"pkill"` still EXECUTES pkill, so the mask must keep these visible (the
# basename is what lands in argv[0]: "/usr/bin/pkill" counts too).
GUARD_WORDS=" kill killall pkill pgrep cgroup_cleanup git$CODE_SHELLS$CODE_E$PAYLOAD_CMDS$WRAPPER_WORDS"
HEREDOC_RE="^-?[[:space:]]*(['\"]?)([A-Za-z0-9_]+)"
# `… | bash` (bare shell reading stdin) EXECUTES the upstream text, so any
# kill-family word upstream is a live operator, not data: `echo pkill -f x |
# bash`, `printf '%s\n' 'pkill -f x' | bash`, `cat <<'EOF' | bash` bodies.
# The shell still reads stdin behind flags that do not name a payload
# (`| bash -s`, `| bash --`, `| bash --norc`) and behind /dev/stdin as the
# "script". `-c` is excluded from the flag class on purpose: `| bash -c '…'`
# runs its argument, not stdin, and the payload is judged by the masking
# stage; `| bash -c` with no argument is a getopt error, not an execution.
STDIN_SHELL='(^|[|;&])[[:space:]]*((sudo|doas|env|nice|nohup|time|timeout|stdbuf|setsid|command|builtin|exec|xargs|busybox|nsenter|setpriv|unshare|taskset|ionice|chrt|prlimit|numactl|strace|ltrace|setarch|watch|systemd-run)[[:space:]]+)*((ba|z|da|k)?sh)([[:space:]]+(-[abd-zA-Z0-9]*|--[a-z-]*))*([[:space:]]+(/dev/stdin|/dev/fd/[0-9]+))?[[:space:]]*($|[;&])'
# `xargs -d/-i/-I … sh -c` (payload arriving as an xargs ARGUMENT): plain
# `xargs bash -c` only hands the first whitespace-split word to -c, but -d/-i/-I
# preserve whole lines, so `echo 'pkill -f x' | xargs -d '\n' bash -c` executes
# it. The payload word is absent (end) or the -I placeholder {}.
XARGS_SH_C='(^|[|;&])[[:space:]]*((sudo|doas|env|nice|nohup|time|timeout|stdbuf|setsid|command|builtin|exec)[[:space:]]+)*xargs([[:space:]]+[^[:space:]]+)*[[:space:]]+-[diI][^[:space:]]*(([[:space:]]+[^[:space:]]+)*[[:space:]]+)((ba|z|da|k)?sh)([[:space:]]+-[^[:space:]]+)*[[:space:]]+-c([[:space:]]+\{\})?[[:space:]]*($|[;&])'
# Text executed through a pipe is decoded by printf/$''-style escapes first:
# `printf '\x70kill -f x\n' | bash` contains no literal kill word yet runs it.
# When a stdin-shell (or xargs -c) shape is present, any hex/unicode/octal
# escape upstream is unverifiable — deny. \n, \t, \\ and sed-style \1 stay
# allowed (they cannot spell a command letter). In ERE a literal backslash is
# \\ — a single `\x` would degrade to matching the bare letter x.
ESCAPED_RE='\\(x[0-9A-Fa-f]|u[0-9A-Fa-f]|U[0-9A-Fa-f]|0[0-7]|[1-7][0-7][0-7])'
KILLWORD='(^|[^[:alnum:]_])(kill|killall|pkill|pgrep|cgroup_cleanup)([^[:alnum:]_]|$)'

# ---- masking stage 1: heredoc bodies are stdin data, not operators ----
# `cat > /tmp/x.sh <<'EOF' …body… EOF` is the guard's own documented approach
# #6 (write the script to disk, run the file). Mask every body line up to its
# terminator so patterns inside the body are never scanned as operator text.
# A QUOTED delimiter (<<'EOF' / <<"EOF") makes the body pure data: mask it
# whole. An UNQUOTED delimiter keeps one live channel — `$(…)`/backticks
# expand when the heredoc is read — so mask that body like a double-quoted
# span: literals die to <heredoc-body>, substitutions stay as operator text.
# `cat <<EOF` + `$(pkill -f x)` therefore blocks.
M_HEREDOC=""
mask_heredocs() {
  local text="$1" out="" line rest pre aft probe
  local -a delims=() strips=() literals=()
  local strip delim quote
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "${#delims[@]}" -gt 0 ]; then
      probe="$line"
      if [ "${strips[0]}" = 1 ]; then
        while [ "${probe#$'\t'}" != "$probe" ]; do probe="${probe#$'\t'}"; done
      fi
      if [ "$probe" = "${delims[0]}" ]; then
        delims=("${delims[@]:1}")
        strips=("${strips[@]:1}")
        literals=("${literals[@]:1}")
        out+="$line"$'\n'
      else
        if [ "${literals[0]}" = 1 ]; then
          out+='<heredoc-body>'$'\n'
        else
          mask_data_span "$line" '<heredoc-body>'
          out+="$M_SPAN_OUT"$'\n'
        fi
      fi
      continue
    fi
    rest="$line"
    local line_out=""
    while [[ "$rest" == *"<<"* ]]; do
      pre="${rest%%<<*}"
      aft="${rest#*<<}"
      line_out+="$pre<<"
      rest="$aft"
      case "$aft" in
        '<'*) continue ;;   # here-string (<<<), not a heredoc
      esac
      if [[ "$aft" =~ $HEREDOC_RE ]]; then
        strip=0
        # Save the captures BEFORE the next =~ test: a failed test unsets
        # BASH_REMATCH and `set -u` would kill the hook mid-run.
        quote="${BASH_REMATCH[1]}"
        delim="${BASH_REMATCH[2]}"
        [[ "$aft" =~ ^- ]] && strip=1
        delims+=("$delim")
        strips+=("$strip")
        case "$quote" in
          \'|\") literals+=(1) ;;
          *) literals+=(0) ;;
        esac
      fi
    done
    out+="$line_out$rest"$'\n'
  done <<< "$text"
  M_HEREDOC="$out"
}

# ---- variable resolution (dataflow-lite) ----
# The guard tracks simple `NAME=value` assignments it has seen in the current
# substitution frame, because the real shell expands them too:
# `F=-f; pkill $F x` assembles a real `-f`. Values that were quoted and masked
# (or contain substitutions) are recorded as the opaque marker `<v>`: the guard
# knows the variable exists but not its content. Subshell frames (`$(…)`)
# inherit bindings and discard their own on exit, like the real shell.
declare -A VARS=()
M_VEND=-1 M_VNAME="" M_VOP="" M_VDEF="" M_VAR_SET=0 M_VAR_OUT=""

# Parse a $NAME / ${NAME} / ${NAME:-def} / ${NAME:=def} reference at $2 in $1.
# On success: M_VNAME/M_VOP/M_VDEF set, M_VEND = index one past the reference.
parse_var_ref() {
  local text="$1" i="$2" n=${#text} j name="" op="" def="" br rest
  M_VEND=-1
  if [ "${text:i+1:1}" = '{' ]; then
    j=$((i+2))
    br=""
    while [ "$j" -lt "$n" ] && [ "${text:j:1}" != '}' ]; do br+="${text:j:1}"; j=$((j+1)); done
    [ "$j" -lt "$n" ] || return 1
    case "$br" in
      *:*)
        name="${br%%:*}"
        rest="${br#*:}"
        case "$rest" in
          -*|=*) op=":${rest:0:1}"; def="${rest:1}" ;;
          *) return 1 ;;   # ${N:?msg}, ${N:+alt}, …: not resolved
        esac
        ;;
      *) name="$br" ;;
    esac
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
    M_VNAME="$name" M_VOP="$op" M_VDEF="$def" M_VEND=$((j+1))
    return 0
  fi
  j=$((i+1))
  while [ "$j" -lt "$n" ]; do
    case "${text:j:1}" in
      [A-Za-z0-9_]) j=$((j+1)) ;;
      *) break ;;
    esac
  done
  name="${text:i+1:j-i-1}"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  M_VNAME="$name" M_VOP="" M_VDEF="" M_VEND="$j"
  return 0
}

# Resolve $1 (name) with operator $2 ('' | :- | :=) and default $3 against
# VARS. `:-` and `:=` fire on unset OR empty, like the real shell.
var_value() {
  M_VAR_SET=0 M_VAR_OUT=""
  if [ "${VARS[$1]+isset}" = "isset" ]; then
    M_VAR_SET=1
    M_VAR_OUT="${VARS[$1]}"
    if [ -z "$M_VAR_OUT" ] && [ -n "$2" ]; then M_VAR_OUT="$3"; fi
    return 0
  fi
  if [ -n "$2" ]; then M_VAR_SET=1; M_VAR_OUT="$3"; fi
  return 0
}

# Data span whose substitutions still run (double-quoted text, unquoted
# heredoc bodies): literal chunks collapse to $2, `$(…)`/backticks are
# rescanned as live operator text and spliced back in. A variable reference to
# a KNOWN literal binding splices the value (the real shell expands it too,
# e.g. `F=-f; pkill "$F" x`); unknown references stay masked (a quoted
# `$unknown` is one argv word, never a flag). Result in M_SPAN_OUT.
mask_data_span() {
  local text="$1" mask="$2"
  local out="" lit="" i=0 n=${#text} c j end
  while [ "$i" -lt "$n" ]; do
    c="${text:i:1}"
    if [ "$c" = '\' ]; then
      lit+="$c"
      i=$((i+1))
      [ "$i" -lt "$n" ] && lit+="${text:i:1}"
      i=$((i+1))
      continue
    fi
    if [ "$c" = '$' ] && [ "${text:i+1:1}" != '(' ]; then
      if parse_var_ref "$text" "$i"; then
        var_value "$M_VNAME" "$M_VOP" "$M_VDEF"
        if [ "$M_VAR_SET" = 1 ]; then
          [ -n "$lit" ] && { out+="$mask"; lit=""; }
          out+="$M_VAR_OUT"
          i="$M_VEND"
          continue
        fi
      fi
    fi
    if [ "${text:i:2}" = '$(' ] || [ "$c" = '`' ]; then
      [ -n "$lit" ] && { out+="$mask"; lit=""; }
      if [ "$c" = '`' ]; then
        j=$((i+1))
        while [ "$j" -lt "$n" ] && [ "${text:j:1}" != '`' ]; do
          [ "${text:j:1}" = '\' ] && j=$((j+1))
          j=$((j+1))
        done
        scan_text "${text:i+1:j-i-1}"
        out+="\`${M_SCAN_OUT}\`"
        i=$((j+1))
        continue
      fi
      match_paren "$text" "$((i+2))"
      end="$M_END"
      scan_text "${text:i+2:end-i-2}"
      out+="\$(${M_SCAN_OUT})"
      i=$((end+1))
      continue
    fi
    lit+="$c"
    i=$((i+1))
  done
  [ -n "$lit" ] && out+="$mask"
  M_SPAN_OUT="$out"
}

# ---- masking stage 2: quotes, -m/--message arguments, substitutions ----
# Quoted tokens are DATA (commit messages, inspector arguments). Executed
# text is not: a quote that is the payload of an interpreter -c/-e/-m, of
# eval, or of ssh stays live and raw. Command substitutions are always live.
M_OUT="" M_PENDING="" M_SEGFIRST="" M_LASTTOK="" M_PREVTOK="" M_MASKNEXT=0
# git commit: after -m everything (message + pathspecs) is data.
M_MASKREST=0
# Interpreter context for the current pipeline segment: the last
# interpreter-class token seen (bash/python/perl/…), and whether a
# positional argument (script name, `extglob` after -O, host for ssh…)
# already followed it. `-c` is a payload flag only BEFORE the first
# positional: `bash --norc -c "…"` and `bash -O extglob -c "…"` are
# payloads, `bash script.sh -c "…"` passes -c to the script.
M_SEGINTERP="" M_SAWPOS=0 M_OPTARGNEXT=0
M_SCAN_OUT="" M_END=0 M_SPAN_OUT=""
# Which payload kind m_is_payload found: "" (not a payload), "raw" (splice
# verbatim), or "split" (env -S/--split-string: splice space-separated, because
# env word-splits the string into a fresh command line).
M_PAYLOAD_KIND=""

m_flush() {
  local tok="$M_PENDING"
  [ -n "$tok" ] || return 0
  M_PENDING=""
  if [ "$M_MASKNEXT" = 1 ] || [ "$M_MASKREST" = 1 ]; then
    M_OUT+="<q>"
    M_MASKNEXT=0
    M_PREVTOK="$M_LASTTOK"
    M_LASTTOK="<q>"
    return 0
  fi
  # A whole-token variable reference resolves through assignments seen in this
  # frame: `F=-f; pkill $F x` is a real `-f`. Unknown variables become the
  # opaque marker <v> (an unquoted `$X` word-splits at runtime, so it CAN be a
  # flag): scan_flag_stmt denies <v> in kill-family invocations.
  if [[ "$tok" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$ ]]; then
    var_value "${BASH_REMATCH[1]}" "" ""
    tok="$M_VAR_OUT"
    [ "$M_VAR_SET" = 1 ] || tok='<v>'
  elif [[ "$tok" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|:=)(.*)\}$ ]]; then
    var_value "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    tok="$M_VAR_OUT"
  fi
  # An empty substitution result vanishes like the shell's word removal —
  # crucially it must not count as a positional or token for -c detection.
  [ -n "$tok" ] || return 0
  # Remember plain literal assignments so later $NAME references resolve.
  # Runs after the mask check on purpose: a masked token is data, not code.
  if [[ "$tok" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    VARS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  fi
  case "$tok" in
    --message=*)
      if [ "${#tok}" -gt 10 ]; then
        M_OUT+="<msg-masked>"
        [ "$M_SEGFIRST" = git ] && M_MASKREST=1
        M_PREVTOK="$M_LASTTOK"
        M_LASTTOK="<msg-masked>"
        return 0
      fi
      M_OUT+="--message="
      M_MASKNEXT=1
      M_PREVTOK="$M_LASTTOK"
      M_LASTTOK="$tok"
      return 0
      ;;
  esac
  M_OUT+="$tok"
  case "$tok" in
    -m|--message|-[A-Za-z0-9]*m)
      # Bundled short-option cluster carrying -m (`-qm`, `-am`, `-1m`, ...):
      # the next token is the commit message (data), not operators. Scoped to
      # git: an arbitrary tool's -m is an ordinary flag (`unshare -m pkill -f
      # x` must keep pkill visible). `python -m module` executes the module
      # (a live operator), so python is exempt either way.
      case "$PY_WORDS" in
        *" $M_LASTTOK "*) : ;;
        *)
          if [ "$M_SEGFIRST" = git ]; then
            M_MASKNEXT=1
            M_MASKREST=1
          fi
          ;;
      esac
      ;;
  esac
  track_word "$tok"
  M_PREVTOK="$M_LASTTOK"
  M_LASTTOK="$tok"
  [ -n "$M_SEGFIRST" ] || M_SEGFIRST="$tok"
}

# Interpreter/positional bookkeeping for one visible word (unquoted token or
# kept-visible quote content — `"bash" -c` executes exactly like bash -c).
track_word() {
  local tok="$1" tokbase=""
  # Interpreter identity is the argv[0] BASENAME: `/bin/bash -c …` executes
  # exactly like `bash -c …`. Assignments are never interpreter words
  # (`F=bash` must not turn a later -c into a payload flag).
  case "$tok" in
    [A-Za-z_]*=*) : ;;
    *) tokbase="${tok##*/}" ;;
  esac
  case "$CODE_SHELLS $CODE_E" in
    *" $tokbase "*)
      M_SEGINTERP="$tokbase"
      M_SAWPOS=0
      M_OPTARGNEXT=0
      ;;
    *)
      if [ "$M_OPTARGNEXT" = 1 ]; then
        M_OPTARGNEXT=0   # argument of -O/-o (`extglob`), not a positional
      else
        case "$tok" in
          -?*)
            # any option, long or short (`--norc`, `-O`, `-c`, `--`): not a
            # positional, so a later -c still addresses the interpreter
            case "$tok" in -O|-o) M_OPTARGNEXT=1 ;; esac
            ;;
          [A-Za-z_]*=*) : ;;   # VAR=value prefix
          \<v\>) : ;;          # opaque variable content: unknown, not a positional
          *) [ -n "$tok" ] && M_SAWPOS=1 ;;   # script name / host / filename
        esac
      fi
      ;;
  esac
}

# Is a quoted span exactly one option FRAGMENT (`-f`, `--full`, `-9f`, but
# also bare `-` or a bare letter)? The shell strips the quotes and GLUES
# adjacent fragments into one argv word, so `pkill "-"f x` is a real `-f` and
# the mask must keep every fragment visible or has_flag goes blind. Anything
# else (`=`, `|`, `;`, `&`, `$`, backticks, whitespace, non-ASCII) is unmasked
# operator text and would leak into the statement scanner as a phantom
# `pkill -f`. The accepted charset (an optional leading `-` plus a run of
# [A-Za-z0-9._+-], empty included) is wider than what getopt accepts (`-+f`
# errors out in pkill) — fail-safe on purpose, and mirrored exactly by
# isOptionToken in the TS plugin.
m_opt_token() {
  [[ "$1" =~ ^-?[A-Za-z0-9._+-]*$ ]]
}

# Is a quoted span exactly one command word the guard tracks (a kill-family
# name, interpreter, wrapper, git), or a path whose basename is one? Quoting
# argv[0] does not protect it: `"pkill" -f x` and `"/usr/bin/pkill" -f x` both
# exec pkill with -f, so the mask keeps these visible.
m_guard_word() {
  case "$1" in
    *[!A-Za-z0-9._/+-]*|"") return 1 ;;
  esac
  case "$GUARD_WORDS" in
    *" ${1##*/} "*) return 0 ;;
  esac
  return 1
}

# Emit one quoted span into M_OUT after classification. $1 = span content
# (already decoded for $'…'), $2 = single|double. Updates M_LASTTOK/M_PREVTOK
# and records F='…' bindings: a visible value binds literally, a masked value
# binds the opaque marker <v>.
quote_span() {
  local inner="$1" mode="$2" tok="<q>"
  if m_is_payload; then
    case "$M_PAYLOAD_KIND" in
      split) M_OUT+=" $inner" ;;
      *) M_OUT+="$inner" ;;
    esac
  elif m_guard_word "$inner" || m_opt_token "$inner"; then
    M_OUT+="$inner"
    tok="$inner"
    # A kept-visible word behaves like an unquoted one for interpreter
    # context: `"bash" -c '…'` is a payload, `bash 'script.sh' -c '…'` is not.
    track_word "$inner"
    [ -n "$M_SEGFIRST" ] || M_SEGFIRST="$inner"
    case "$M_LASTTOK" in
      [A-Za-z_]*=) VARS["${M_LASTTOK%=}"]="$inner" ;;
    esac
  else
    case "$mode" in
      double) mask_double "$inner" ;;
      *) M_OUT+="<q>" ;;
    esac
    case "$M_LASTTOK" in
      [A-Za-z_]*=) VARS["${M_LASTTOK%=}"]='<v>' ;;
    esac
  fi
  M_MASKNEXT=0
  M_PREVTOK="$M_LASTTOK"
  M_LASTTOK="$tok"
}

# ANSI-C quoting decode ($'…'): escapes expand before the word reaches argv,
# so classification must see the decoded text (`pkill -$'\146' x` is a real
# `-f`). Faithful to bash: unknown escapes keep their backslash, NUL vanishes,
# surrogate/out-of-range codepoints collapse to 0x1A. Bytes ≥ 0x80 decode as
# the codepoint's UTF-8 (bash yields the raw byte); the difference is invisible
# to every rule, which only reads ASCII. Result in M_DECODE_OUT.
decode_ansi_c() {
  local s="$1" out="" i=0 c e digits cp max
  local n=${#s}
  while [ "$i" -lt "$n" ]; do
    c="${s:i:1}"
    if [ "$c" != '\' ]; then out+="$c"; i=$((i+1)); continue; fi
    i=$((i+1))
    if [ "$i" -ge "$n" ]; then out+='\'; break; fi
    e="${s:i:1}"
    i=$((i+1))
    case "$e" in
      a) out+=$'\a' ;; b) out+=$'\b' ;; e|E) out+=$'\e' ;;
      f) out+=$'\f' ;; n) out+=$'\n' ;; r) out+=$'\r' ;;
      t) out+=$'\t' ;; v) out+=$'\v' ;;
      '\'|"'"|'"'|'?') out+="$e" ;;
      x|u|U)
        max=2
        case "$e" in u) max=4 ;; U) max=8 ;; esac
        digits=""
        while [ "$i" -lt "$n" ] && [ "${#digits}" -lt "$max" ]; do
          case "${s:i:1}" in
            [0-9A-Fa-f]) digits+="${s:i:1}"; i=$((i+1)) ;;
            *) break ;;
          esac
        done
        if [ -z "$digits" ]; then out+="\\$e"; continue; fi
        cp=$((16#$digits))
        if [ "$cp" -eq 0 ]; then
          :
        elif [ "$cp" -gt 1114111 ] || { [ "$cp" -ge 55296 ] && [ "$cp" -le 57343 ]; }; then
          out+=$'\x1a'
        elif [ "$cp" -lt 128 ]; then
          printf -v c '%b' "\\$(printf '%03o' "$cp")"
          out+="$c"
        else
          printf -v c '%b' "\\U$(printf '%08x' "$cp")"
          out+="$c"
        fi
        ;;
      [0-7])
        digits="$e"
        while [ "$i" -lt "$n" ] && [ "${#digits}" -lt 3 ]; do
          case "${s:i:1}" in
            [0-7]) digits+="${s:i:1}"; i=$((i+1)) ;;
            *) break ;;
          esac
        done
        cp=$((8#$digits))
        if [ "$cp" -ne 0 ]; then
          printf -v c '%b' "\\$(printf '%03o' "$cp")"
          out+="$c"
        fi
        ;;
      c)
        if [ "$i" -lt "$n" ]; then
          e="${s:i:1}"
          i=$((i+1))
          printf -v cp '%d' "'$e"
          cp=$((cp & 31))
          if [ "$cp" -ne 0 ]; then
            printf -v c '%b' "\\$(printf '%03o' "$cp")"
            out+="$c"
          fi
        else
          out+='\c'
        fi
        ;;
      *) out+="\\$e" ;;
    esac
  done
  M_DECODE_OUT="$out"
}

m_is_payload() {
  M_PAYLOAD_KIND=""
  case "$PAYLOAD_CMDS" in *" $M_SEGFIRST "*) return 0 ;; esac
  # Short flags bundle (`bash -ec '…'`, `perl -ne '…'`): getopt still takes
  # the next word as the payload, so a cluster carrying the payload letter
  # behaves like the bare flag. The letter may sit anywhere in the cluster:
  # when it is not last, getopt gives it the rest of the cluster as its own
  # argument and the next word is $0 — but deciding that per-interpreter is
  # getopt simulation, so the guard blocks instead (`bash -ce`, `python -cm`).
  # `n` is no-exec syntax checking in every CODE_SHELLS member, so
  # `bash -nc '…'` runs nothing. Long options never bundle.
  # The `s` letter is env's -S/--split-string: env word-splits the string and
  # EXECUTES the result, so the quote is a payload (spliced space-separated —
  # env's own splitting means the content is a fresh command line, and keeping
  # its spaces visible lets the statement rules see it).
  local flag=""
  case "$M_LASTTOK" in
    -c) flag=c ;;
    -m) flag=m ;;
    -e) flag=e ;;
    -S|--split-string|--split-string=) flag=s ;;
    -[!-]?*)
      case "$M_LASTTOK" in
        *c*) case "$M_LASTTOK" in *n*) : ;; *) flag=c ;; esac ;;
        *m*) flag=m ;;
        *e*) flag=e ;;
        *S*) flag=s ;;
      esac
      ;;
  esac
  case "$flag" in
    c)
      case "$CODE_SHELLS" in *" $M_PREVTOK "*) return 0 ;; esac
      case "$M_SEGINTERP" in
        '')
          ;;
        *)
          if [ "$M_SAWPOS" = 0 ]; then
            case "$CODE_SHELLS" in *" $M_SEGINTERP "*) return 0 ;; esac
          fi
          ;;
      esac
      ;;
    m) case "$PY_WORDS" in *" $M_PREVTOK "*) return 0 ;; esac ;;
    e) case "$CODE_E" in *" $M_PREVTOK "*) return 0 ;; esac ;;
    s)
      if [ "$M_SAWPOS" = 0 ] && [ "$M_SEGINTERP" = env ]; then
        M_PAYLOAD_KIND=split
        return 0
      fi
      ;;
  esac
  return 1
}

# Index of the ")" closing the "$(" that starts at $2; result in M_END.
match_paren() {
  local text="$1" i="$2" n=${#text} depth=1 c j
  while [ "$i" -lt "$n" ]; do
    c="${text:i:1}"
    case "$c" in
      "'"|'"'|'`')
        j=$((i+1))
        while [ "$j" -lt "$n" ] && [ "${text:j:1}" != "$c" ]; do
          [ "${text:j:1}" = '\' ] && j=$((j+1))
          j=$((j+1))
        done
        i=$((j+1))
        ;;
      '\')
        i=$((i+2))
        ;;
      '(')
        depth=$((depth+1))
        i=$((i+1))
        ;;
      ')')
        depth=$((depth-1))
        if [ "$depth" -eq 0 ]; then M_END="$i"; return 0; fi
        i=$((i+1))
        ;;
      *)
        i=$((i+1))
        ;;
    esac
  done
  M_END="$n"
}

# A double-quoted span is data, but substitutions inside it still run.
mask_double() {
  mask_data_span "$1" '<q>'
  M_OUT+="$M_SPAN_OUT"
}

scan_text() { # $1 = text -> M_SCAN_OUT (recursion-safe: state saved per frame)
  local text="$1"
  local s_out="$M_OUT" s_pending="$M_PENDING" s_segfirst="$M_SEGFIRST" \
        s_lasttok="$M_LASTTOK" s_prevtok="$M_PREVTOK" s_masknext="$M_MASKNEXT" \
        s_maskrest="$M_MASKREST" s_seginterp="$M_SEGINTERP" \
        s_sawpos="$M_SAWPOS" s_optargnext="$M_OPTARGNEXT"
  # Substitutions run in a subshell: the frame inherits the variable bindings
  # but its own assignments must not leak out.
  local -A s_vars=()
  local k
  for k in "${!VARS[@]}"; do s_vars["$k"]="${VARS[$k]}"; done
  M_OUT="" M_PENDING="" M_SEGFIRST="" M_LASTTOK="" M_PREVTOK="" M_MASKNEXT=0
  M_MASKREST=0 M_SEGINTERP="" M_SAWPOS=0 M_OPTARGNEXT=0
  local i=0 n=${#text} c j end inner bdepth=0
  while [ "$i" -lt "$n" ]; do
    c="${text:i:1}"
    case "$c" in
      ' '|$'\t'|$'\r')
        m_flush
        M_OUT+="$c"
        i=$((i+1))
        ;;
      ';'|'|'|'&'|$'\n')
        m_flush
        M_MASKNEXT=0
        M_MASKREST=0
        M_SEGFIRST=""
        M_SEGINTERP=""
        M_SAWPOS=0
        M_OPTARGNEXT=0
        M_LASTTOK=""
        M_PREVTOK=""
        M_OUT+="$c"
        i=$((i+1))
        ;;
      '{')
        # A brace STARTS a command group only as a free-standing word
        # (`{ pkill -f x; }` executes pkill): pending `$` means ${…} expansion,
        # any other pending text makes it a literal (foo{bar}).
        if [ -n "$M_PENDING" ] && [ "${M_PENDING: -1}" = '$' ]; then
          M_PENDING+="$c"
          bdepth=$((bdepth+1))
          i=$((i+1))
        elif [ "$bdepth" -gt 0 ] || [ -n "$M_PENDING" ]; then
          M_PENDING+="$c"
          i=$((i+1))
        else
          m_flush
          M_MASKNEXT=0
          M_MASKREST=0
          M_SEGFIRST=""
          M_SEGINTERP=""
          M_SAWPOS=0
          M_OPTARGNEXT=0
          M_LASTTOK=""
          M_PREVTOK=""
          M_OUT+="$c"
          i=$((i+1))
        fi
        ;;
      '}')
        if [ "$bdepth" -gt 0 ]; then
          M_PENDING+="$c"
          bdepth=$((bdepth-1))
          i=$((i+1))
        elif [ -n "$M_PENDING" ]; then
          M_PENDING+="$c"
          i=$((i+1))
        else
          m_flush
          M_MASKNEXT=0
          M_MASKREST=0
          M_SEGFIRST=""
          M_SEGINTERP=""
          M_SAWPOS=0
          M_OPTARGNEXT=0
          M_LASTTOK=""
          M_PREVTOK=""
          M_OUT+="$c"
          i=$((i+1))
        fi
        ;;
      "'")
        m_flush
        j=$((i+1))
        while [ "$j" -lt "$n" ] && [ "${text:j:1}" != "$c" ]; do
          [ "${text:j:1}" = '\' ] && j=$((j+1))
          j=$((j+1))
        done
        # single quotes are literal data unless they are executed text
        quote_span "${text:i+1:j-i-1}" single
        i=$((j+1))
        ;;
      '"'|'`')
        m_flush
        j=$((i+1))
        while [ "$j" -lt "$n" ] && [ "${text:j:1}" != "$c" ]; do
          [ "${text:j:1}" = '\' ] && j=$((j+1))
          j=$((j+1))
        done
        inner="${text:i+1:j-i-1}"
        case "$c" in
          '"')
            quote_span "$inner" double
            ;;
          '`')
            scan_text "$inner"
            M_OUT+="\`${M_SCAN_OUT}\`"
            M_MASKNEXT=0
            M_PREVTOK="$M_LASTTOK"
            M_LASTTOK="<sub>"
            ;;
        esac
        i=$((j+1))
        ;;
      '<'|'>')
        if [ "${text:i+1:1}" = '(' ]; then
          # Process substitution EXECUTES its body: `<(pkill -f x)` runs
          # pkill even in a read-only-looking pipeline. Scan it like $(…).
          m_flush
          match_paren "$text" "$((i+2))"
          end="$M_END"
          scan_text "${text:i+2:end-i-2}"
          M_OUT+="$c(${M_SCAN_OUT})"
          M_MASKNEXT=0
          M_PREVTOK="$M_LASTTOK"
          M_LASTTOK="<sub>"
          i=$((end+1))
        else
          M_PENDING+="$c"
          i=$((i+1))
        fi
        ;;
      '$')
        if [ "${text:i:2}" = '$(' ]; then
          m_flush
          match_paren "$text" "$((i+2))"
          end="$M_END"
          scan_text "${text:i+2:end-i-2}"
          M_OUT+="\$(${M_SCAN_OUT})"
          M_MASKNEXT=0
          M_PREVTOK="$M_LASTTOK"
          M_LASTTOK="<sub>"
          i=$((end+1))
        elif [ "${text:i+1:1}" = "'" ]; then
          # ANSI-C quoting: the `$` belongs to the quote (keep interpreter
          # context), and the escapes decode BEFORE argv — classify the
          # decoded text or `$'\146'` hides a real `f`.
          m_flush
          M_OUT+='$'
          j=$((i+2))
          while [ "$j" -lt "$n" ] && [ "${text:j:1}" != "'" ]; do
            [ "${text:j:1}" = '\' ] && j=$((j+1))
            j=$((j+1))
          done
          decode_ansi_c "${text:i+2:j-i-2}"
          quote_span "$M_DECODE_OUT" single
          i=$((j+1))
        elif [ "${text:i+1:1}" = '"' ]; then
          # Locale quoting (`$"…"`): plain double-quote semantics; the `$`
          # belongs to the quote, not to the previous token.
          m_flush
          M_OUT+='$'
          i=$((i+1))
        else
          M_PENDING+="$c"
          i=$((i+1))
        fi
        ;;
      *)
        M_PENDING+="$c"
        i=$((i+1))
        ;;
    esac
  done
  m_flush
  M_SCAN_OUT="$M_OUT"
  M_OUT="$s_out" M_PENDING="$s_pending" M_SEGFIRST="$s_segfirst" \
    M_LASTTOK="$s_lasttok" M_PREVTOK="$s_prevtok" M_MASKNEXT="$s_masknext" \
    M_MASKREST="$s_maskrest" M_SEGINTERP="$s_seginterp" \
    M_SAWPOS="$s_sawpos" M_OPTARGNEXT="$s_optargnext"
  VARS=()
  for k in "${!s_vars[@]}"; do VARS["$k"]="${s_vars[$k]}"; done
}

# ---- rule evaluation, per statement ----
# A compound command is denied only if at least one statement is denied.
# Statements split on `;`, `&`, `||`, `{`, `}` (command groups) and newlines;
# `|` separates pipeline segments inside a statement. The `&` in `2>&1` is a
# redirect, not a statement boundary. Braces inside ${…} expansions were
# consumed by the masker; any brace left in the masked text is a bare word.
statements() { # $1 = masked text -> statements one per line
  printf '%s' "$1" | sed -E 's/([<>])&/\1/g; s/\|\|/;/g' | tr ';&\n{}' '\n\n\n\n\n'
}

is_data_segment() {
  local first
  first="$(printf '%s' "$1" | awk '{print $1; exit}')"
  case "$READONLY" in *" $first "*) ;; *) return 1 ;; esac
  # A substitution of any kind ($(), backticks, process substitution) can hide
  # an executed kill inside an inspector-looking pipeline.
  case "$1" in *'$('* | *'`'* | *'<('* | *">("*) return 1 ;; esac
  printf '%s' "$1" | grep -qE "$KILL" && return 1
  return 0
}

# A pipeline is only dangerous when it reaches a kill-family sink (or a
# substitution). Inspector-to-inspector pipes (ps | grep | awk | wc …) are
# read-only; `pgrep -f foo | awk '{print $1}'` therefore passes, while
# `pgrep -f foo | awk '{print $1}' | xargs -r kill` does not.
has_kill_sink() {
  local seg first
  while IFS= read -r seg || [ -n "$seg" ]; do
    [ -n "$seg" ] || continue
    printf '%s' "$seg" | grep -qE "$KILL" || continue
    first="$(printf '%s' "$seg" | awk '{print $1; exit}')"
    case "$READONLY" in
      *" $first "*)
        case "$seg" in *'$('* | *'`'* | *'<('* | *">("*) return 0 ;; *) continue ;; esac
        ;;
    esac
    return 0
  done < <(printf '%s' "$1" | tr '|' '\n')
  return 1
}

# Does any *token* of this segment carry the flag? Catches `-f`, `-9f`, `-fx`,
# `--full` in any position, so `pkill -9 -f x` and `pkill --signal TERM -f x`
# cannot slip past by inserting flags before it. $3 may end in `*` to match a
# getopt_long unique-prefix family (`re*` = `--re`, `--rege`, `--regex`,
# `--regexp`); a quoted case pattern would match that literally, so the long
# side uses [[ == ]] pattern matching. `--opt=value` never counts: these
# options take no argument, so that form is a getopt_long error and the
# invocation does nothing (`--full=v` dies with "option doesn't allow an
# argument").
has_flag() {
  local w
  for w in $1; do
    # A flag survives quoting and escaping on its way to getopt (`pkill "-f"`,
    # `pkill \-f`, `pkill $'-f'`, `pkill \"-f\"`). Normalize the token before
    # classifying it or the guard goes blind on every one of those shapes.
    w="${w//\\/}"
    w="${w#\$}"
    case "$w" in
      \"*\") w="${w#\"}"; w="${w%\"}" ;;
      \'*\') w="${w#\'}"; w="${w%\'}" ;;
    esac
    case "$w" in
      --*=*) continue ;;
      --*)
        [[ "$w" == --$3 ]] && return 0
        ;;
      -*)
        case "$w" in *"$2"*) return 0 ;; esac
        ;;
    esac
  done
  return 1
}

# Words of a segment with substitution/quote boundaries marked: the first
# word after `$(`, a backtick, or a quote opener starts a fresh command
# context (`git commit -m $(pkill -f x)` runs pkill despite `commit` before).
# Fills W_WORDS / W_FRESH (1 = fresh command context).
W_WORDS=() W_FRESH=()
words_of() {
  W_WORDS=(); W_FRESH=()
  local seg="$1" cur="" fresh=1 i=0 n=${#seg} c
  while [ "$i" -lt "$n" ]; do
    c="${seg:i:1}"
    case "$c" in
      ' '|$'\t'|$'\r')
        if [ -n "$cur" ]; then W_WORDS+=("$cur"); W_FRESH+=("$fresh"); fresh=0; cur=""; fi
        ;;
      '('|')'|'`'|'$'|'"'|"'")
        if [ -n "$cur" ]; then W_WORDS+=("$cur"); W_FRESH+=("$fresh"); fresh=0; cur=""; fi
        fresh=1
        ;;
      *)
        cur+="$c"
        ;;
    esac
    i=$((i+1))
  done
  if [ -n "$cur" ]; then W_WORDS+=("$cur"); W_FRESH+=("$fresh"); fi
  return 0
}

# Is W_WORDS[i] an INVOCATION of the program, or just an argument? Walk back
# over flags, flag arguments (`-O extglob`, `nice -n 5`, `timeout 30`) and
# `VAR=value` prefixes: if the trail ends at a wrapper (`xargs`, `sudo`, …)
# or an interpreter shell (`bash -c …`), the word runs. A real positional
# before it (`git commit -m fix pkill …`, `grep killall .`) makes it data.
# Shell block keywords are transparent: `then pkill -f x` executes pkill.
SHELL_KEYWORDS=" if then else elif do while until for select ! "
at_command_position() {
  local i="$1" j t prev tb
  if [ "${W_FRESH[i]}" = 1 ]; then return 0; fi   # $(pkill …), backtick, quote payload
  for ((j=i-1; j>=0; j--)); do
    t="${W_WORDS[j]}"
    # Wrapper/interpreter identity is the argv[0] basename: a path-qualified
    # `/usr/bin/sudo pkill -f x` still execs pkill through sudo.
    tb="${t##*/}"
    case "$WRAPPER_WORDS $CODE_SHELLS $PAYLOAD_CMDS" in *" $tb "*) return 0 ;; esac
    case "$SHELL_KEYWORDS" in *" $t "*) return 0 ;; esac
    case "$t" in
      -*) continue ;;                            # any flag
      [A-Za-z_][A-Za-z0-9_]*=*) continue ;;      # VAR=value prefix
    esac
    if [[ "$t" =~ ^[0-9]+[a-z%]?$ ]]; then continue; fi   # timeout 30, dd bs=4k
    # flag argument (`-O extglob`, `-m fix`, `-n 5`) or ssh's hostname slot
    if [ "$j" -gt 0 ]; then
      prev="${W_WORDS[j-1]}"
      if [ "${#prev}" -gt 1 ]; then
        case "$prev" in
          -*) continue ;;
        esac
      fi
      case "$PAYLOAD_CMDS" in *" $prev "*) continue ;; esac
    fi
    return 1
  done
  return 0
}

# Segments of this statement that invoke $1 as a command word (quoted
# occurrences count too: `bash -c "pkill -f x"` ends up in a real argv).
segs_with_stmt() {
  printf '%s' "$1" | tr '|' '\n' | grep -E "${PRE}$2"'([[:space:]]|$)' || true
}

# Word test for the program's own name or a path-qualified form
# (`/usr/bin/pkill`); used through at_command_position so a bare mention as
# an argument (`grep killall .`, `git commit -m fix pkill …`) is data.
seg_invokes() { # $1 = segment, $2 = program basename
  words_of "$1"
  local i t
  for ((i=0; i<${#W_WORDS[@]}; i++)); do
    t="${W_WORDS[i]}"
    case "$t" in
      "$2"|*/"$2")
        at_command_position "$i" && return 0
        ;;
    esac
  done
  return 1
}

# The segment's argv is partly computed at runtime: a substitution, a process
# substitution, an unresolved/opaquely-assigned variable (<v>), or a raw
# `$name` fragment the guard never saw assigned. Flags arriving from any of
# those are invisible to has_flag (`pkill $(cat /tmp/flags)`, `pkill $FLAGS`).
computed_argv() {
  case "$1" in
    *'`'* | *'<('* | *">("* | *'<v>'*) return 0 ;;
  esac
  # `$((…))` is arithmetic — it yields a number, never a flag — so only a
  # `$(` NOT followed by another paren marks computed argv.
  printf '%s' "$1" | grep -qE '\$\([^()]|\$[A-Za-z_{]'
}

# xargs feeding a kill-family command from a file (`xargs -a flags pkill`,
# `xargs pkill < flags`): the flags arrive as data the guard never sees.
# Pipeline-fed `… | xargs -r kill` is approach #3 and stays allowed — this
# fires only when xargs and the kill-family word share one segment AND a file
# feed flag (-a/--arg-file) or an input redirect is present. Redirect words
# are recognized as `<`-led words that are not one of the guard's masks.
xargs_feeds() { # $1 = segment
  seg_invokes "$1" xargs || return 1
  local w i
  words_of "$1"
  for ((i=0; i<${#W_WORDS[@]}; i++)); do
    w="${W_WORDS[i]}"
    case "$w" in
      -a|-a?*|--arg-file|--arg-file=*) return 0 ;;
      \<|\<[!a-z]*) return 0 ;;
    esac
  done
  return 1
}

SF_REASON=""
scan_flag_stmt() { # $1=statement $2=program $3=short letter $4=long name
  local seg
  SF_REASON=""
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    is_data_segment "$seg" && continue
    seg_invokes "$seg" "$2" || continue
    if has_flag "$seg" "$3" "$4"; then return 0; fi
    if computed_argv "$seg"; then
      SF_REASON="$2 invoked with flags computed by a substitution or a variable the guard cannot resolve — the resulting argv is invisible to it."
      return 0
    fi
    if xargs_feeds "$seg"; then
      SF_REASON="xargs feeding $2: the flags arrive from a data file the guard cannot see."
      return 0
    fi
  done < <(segs_with_stmt "$1" "$2")
  return 1
}

# The command word itself is a substitution: `"$(which pkill)" -f x` execs
# whatever the substitution prints, with flags the guard cannot attribute to a
# program. Deny when such a segment carries a kill-style flag family.
subst_led_flag() {
  local seg t
  while IFS= read -r seg || [ -n "$seg" ]; do
    [ -n "$seg" ] || continue
    t="${seg#"${seg%%[![:space:]]*}"}"
    case "$t" in
      '$(('*) : ;;   # arithmetic expansion: yields a number, never a flag
      '$('*|'`'*|'<('*|">("*)
        if has_flag "$seg" f 'f*' || has_flag "$seg" r 're*'; then return 0; fi
        ;;
    esac
  done < <(printf '%s' "$1" | tr '|' '\n')
  return 1
}

# gateway.cgroup_cleanup (hermes) SIGKILLs every PID in the caller's own
# cgroup — it was the gateway unit's ExecStopPost, never a shell command.
# The hermes-gateway-penetrate unit was retired 2026-09-28; the module must
# never be run manually and this rule stays as defense-in-depth.
# From an agent shell the caller's cgroup IS the agent's process tree
# (2026-09-19: three opencode TUI deaths, "Process Exited from Signal 9").
# Match it as an INVOCATION token only, not as a bare substring: interpreter
# form (`python -m gateway.cgroup_cleanup`, `python3 /opt/gateway/cgroup_cleanup.py`)
# or direct command word (`cgroup_cleanup`, `/usr/lib/gateway/cgroup_cleanup`,
# `xargs cgroup_cleanup`, `bash -c "cgroup_cleanup"`). A bare mention in a
# filename stays data: `vim cgroup_cleanup.md` must pass (the token is
# `cgroup_cleanup.md`, not `cgroup_cleanup`). Commit messages mentioning it
# are masked above, so only live use is caught.
CG_TOKEN='(^|/)([[:alnum:]_.]*\.)?cgroup_cleanup$'
reaps_own_cgroup() {
  local seg i t
  while IFS= read -r seg || [ -n "$seg" ]; do
    [ -n "$seg" ] || continue
    is_data_segment "$seg" && continue
    words_of "$seg"
    for ((i=0; i<${#W_WORDS[@]}; i++)); do
      t="${W_WORDS[i]}"
      if printf '%s' "$t" | grep -qE "$CG_TOKEN"; then
        at_command_position "$i" && return 0
      fi
    done
  done < <(printf '%s' "$1" | tr '|' '\n')
  return 1
}

# `… | bash` (bare shell reading stdin) EXECUTES the upstream text, so any
# kill-family word upstream is a live operator, not data: `echo pkill -f x |
# bash`, `printf '%s\n' 'pkill -f x' | bash`, `cat <<'EOF' | bash` bodies.
# Also the xargs-arg-fed form: `echo 'pkill -f x' | xargs -d '\n' bash -c`.
pipes_to_stdin_shell() {
  printf '%s' "$1" | grep -qE "$STDIN_SHELL" && return 0
  printf '%s' "$1" | grep -qE "$XARGS_SH_C" && return 0
  return 1
}

# Any kill/killall INVOCATION in this statement (path-qualified forms count).
# Used for the cross-statement rule: after an earlier `pgrep -f pat`, the
# shell's own argv contains pat, so pgrep matched the shell — killing anything
# it listed (via a file, a substitution, xargs, …) kills the session.
stmt_kill_invocation() {
  local seg
  while IFS= read -r seg || [ -n "$seg" ]; do
    [ -n "$seg" ] || continue
    seg_invokes "$seg" kill && return 0
    seg_invokes "$seg" killall && return 0
  done < <(printf '%s' "$1" | tr '|' '\n')
  return 1
}

STMT_REASON=""
stmt_denied() {
  local stmt="$1"
  if reaps_own_cgroup "$stmt"; then
    STMT_REASON="gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup — from an agent shell that is the agent's own process tree. The hermes-gateway unit it served as ExecStopPost was retired 2026-09-28; the module must never be run manually. This rule stays as defense-in-depth."
    return 0
  fi
  # getopt_long runs any unique prefix of a long option: `--f` IS `--full`
  # (pkill/pgrep have no other --f* option). `--full=v` is not: it is an
  # argument to a no-argument option and dies in getopt_long (see has_flag).
  if scan_flag_stmt "$stmt" pkill f 'f*'; then
    STMT_REASON="$SF_REASON"
    [ -n "$STMT_REASON" ] || STMT_REASON="pkill -f matches the full cmdline of every process, including the shell running this very command."
    return 0
  fi
  if scan_flag_stmt "$stmt" pgrep f 'f*' && has_kill_sink "$stmt"; then
    STMT_REASON="$SF_REASON"
    [ -n "$STMT_REASON" ] || STMT_REASON="pgrep -f combined with kill on the same command line: the pattern still sits in the killing shell's argv."
    return 0
  fi
  # psmisc killall's long option is --regexp, and getopt_long accepts any
  # unique prefix (--re, --rege, --regex, --regexp all run): match the whole
  # --re* family, not a single spelling.
  if scan_flag_stmt "$stmt" killall r 're*'; then
    STMT_REASON="$SF_REASON"
    [ -n "$STMT_REASON" ] || STMT_REASON="killall -r/--regexp matches by regex from inside a cmdline that contains the same text."
    return 0
  fi
  if subst_led_flag "$stmt"; then
    STMT_REASON="the command word is a substitution: its result executes with flags the guard cannot attribute to a program (\$(…) -f x could be pkill)."
    return 0
  fi
  if printf '%s' "$stmt" | grep -qE "$PSRE" && printf '%s' "$stmt" | grep -qE "$PIPE_GREP" \
    && has_kill_sink "$stmt" && ! printf '%s' "$stmt" | grep -qE "$GREP_FROM_FILE"; then
    STMT_REASON="ps | grep <literal> | kill: grep matches itself and the wrapping shell's argv."
    return 0
  fi
  return 1
}

reason=""

# Cheap reject-first: no kill-family word, no ANSI-C/hex escape channel and no
# pipe-into-shell shape means no rule can fire — skip the (quadratic) masking
# stage for it. Without this a 150KB log-pasting command took 193s in the
# masker, blowing straight past the 10s harness hook timeout (a degraded
# guard waves the command through). The escape/pipe triggers stay because
# printf-style decoding and `| bash` can produce kill words at runtime that
# the raw text does not contain.
case "$cmd" in
  *kill*|*pgrep*|*cgroup_cleanup*|*"\$'"*|*'\x'*|*'\0'*) : ;;
  *)
    pipes_to_stdin_shell "$cmd" || exit 0
    ;;
esac

if pipes_to_stdin_shell "$cmd"; then
  if printf '%s' "$cmd" | grep -qE "$KILLWORD"; then
    reason="piping text into a shell runs it: the kill pattern inside that text would execute in the very shell being piped to."
  elif printf '%s' "$cmd" | grep -qE "$ESCAPED_RE"; then
    reason="piping text into a shell runs it, and the text carries hex/octal/unicode escapes that only decode at runtime (printf, \$'…') — the guard cannot verify what command they spell."
  fi
fi
if [ -z "$reason" ]; then
  mask_heredocs "$cmd"
  # Size gate AFTER heredoc masking: documented approach #6 (write the script
  # to a file) collapses to <heredoc-body> lines and stays scannable, while a
  # giant one-liner is denied rather than scanned for minutes.
  if [ "${#M_HEREDOC}" -gt 16384 ]; then
    reason="command is too large for the kill-guard's masking stage (>16384 bytes after heredoc masking; the scan is quadratic). Write the script to a file and run the file (approach #6), or split the command."
  else
    scan_text "$M_HEREDOC"
    pgrepf_seen=0
    while IFS= read -r stmt || [ -n "$stmt" ]; do
      [ -n "$stmt" ] || continue
      # Cross-statement: an earlier pgrep -f already matched THIS shell (its
      # argv holds the whole compound text), so a later kill of those results
      # kills the session — `pgrep -f foo > f; kill $(cat f)`.
      if [ "$pgrepf_seen" = 1 ] && stmt_kill_invocation "$stmt"; then
        reason="an earlier pgrep -f in this compound command matched the shell itself (its argv contains the pattern); killing anything it listed kills the session."
        break
      fi
      if stmt_denied "$stmt"; then
        reason="$STMT_REASON"
        break
      fi
      scan_flag_stmt "$stmt" pgrep f 'f*' && pgrepf_seen=1
    done < <(statements "$M_SCAN_OUT")
  fi
fi
[ -n "$reason" ] || exit 0

fix="$(cat <<'EOF'
Do NOT retry the same shape. Use one of:
  1) two separate calls: `ps -eo pid=,ppid=,comm=,args=` then `kill -TERM <numeric PID>` (exclude $$ and $PPID)
  2) PID file from startup: `setsid ./prog > /tmp/run.log 2>&1 & echo $! > /tmp/run.pid` then `kill -- -"$(ps -o pgid= -p "$(cat /tmp/run.pid)")"`
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
