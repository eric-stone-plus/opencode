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
# Only an empty result with a failing jq is the documented degraded mode.
if [ -z "$cmd" ] && [ "$jq_rc" -ne 0 ]; then
  printf '%s\n' "block-unsafe-kill: jq unavailable, guard degraded" >&2
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
CODE_SHELLS=" bash sh zsh dash ksh python python3 python2 pypy pypy3 "
PY_WORDS=" python python3 python2 pypy pypy3 "
CODE_E=" perl ruby node deno lua "
PAYLOAD_CMDS=" eval ssh "
# Wrappers that only schedule the real command (sudo nice -n 5 pkill …): a
# kill-family word after one of these is still an invocation.
WRAPPER_WORDS=" sudo doas env nice nohup time timeout stdbuf setsid command builtin exec xargs "
HEREDOC_RE="^-?[[:space:]]*(['\"]?)([A-Za-z0-9_]+)"
# `… | bash` (bare shell reading stdin) EXECUTES the upstream text, so any
# kill-family word upstream is a live operator, not data: `echo pkill -f x |
# bash`, `printf '%s\n' 'pkill -f x' | bash`, `cat <<'EOF' | bash` bodies.
STDIN_SHELL='(^|[|;&])[[:space:]]*((sudo|doas|env|nice|nohup|time|timeout|stdbuf|setsid|command|builtin|exec|xargs)[[:space:]]+)*((ba|z|da|k)?sh)[[:space:]]*($|[;&])'
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

# Data span whose substitutions still run (double-quoted text, unquoted
# heredoc bodies): literal chunks collapse to $2, `$(…)`/backticks are
# rescanned as live operator text and spliced back in. Result in M_SPAN_OUT.
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
      # the next token is the commit message (data), not operators.
      # `python -m module` executes the module (a live operator, e.g.
      # `python -m gateway.cgroup_cleanup`); any other -m takes a message.
      case "$PY_WORDS" in
        *" $M_LASTTOK "*) : ;;
        *)
          M_MASKNEXT=1
          [ "$M_SEGFIRST" = git ] && M_MASKREST=1
          ;;
      esac
      ;;
  esac
  case "$CODE_SHELLS $CODE_E" in
    *" $tok "*)
      M_SEGINTERP="$tok"
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
          *) [ -n "$tok" ] && M_SAWPOS=1 ;;   # script name / host / filename
        esac
      fi
      ;;
  esac
  M_PREVTOK="$M_LASTTOK"
  M_LASTTOK="$tok"
  [ -n "$M_SEGFIRST" ] || M_SEGFIRST="$tok"
}

# Is a quoted span exactly one option NAME (`-f`, `--full`, `-9f`)? The shell
# strips the quotes before getopt sees the word, so a quoted flag is still a
# flag — the mask must keep it visible or has_flag goes blind. Only a plain
# option name qualifies: anything else (`=`, `|`, `;`, `&`, `$`, backticks,
# whitespace, non-ASCII) is unmasked operator text and would leak into the
# statement scanner as a phantom `pkill -f`.
m_opt_token() {
  case "$1" in
    -*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    -|"--") return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._+-]*) return 1 ;;
  esac
  return 0
}

m_is_payload() {
  case "$PAYLOAD_CMDS" in *" $M_SEGFIRST "*) return 0 ;; esac
  # Short flags bundle (`bash -ec '…'`, `perl -ne '…'`): getopt still takes
  # the next word as the payload, so a cluster carrying the payload letter
  # behaves like the bare flag. The letter may sit anywhere in the cluster:
  # when it is not last, getopt gives it the rest of the cluster as its own
  # argument and the next word is $0 — but deciding that per-interpreter is
  # getopt simulation, so the guard blocks instead (`bash -ce`, `python -cm`).
  # `n` is no-exec syntax checking in every CODE_SHELLS member, so
  # `bash -nc '…'` runs nothing. Long options never bundle.
  local flag=""
  case "$M_LASTTOK" in
    -c) flag=c ;;
    -m) flag=m ;;
    -e) flag=e ;;
    -[!-]?*)
      case "$M_LASTTOK" in
        *c*) case "$M_LASTTOK" in *n*) : ;; *) flag=c ;; esac ;;
        *m*) flag=m ;;
        *e*) flag=e ;;
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
  M_OUT="" M_PENDING="" M_SEGFIRST="" M_LASTTOK="" M_PREVTOK="" M_MASKNEXT=0
  M_MASKREST=0 M_SEGINTERP="" M_SAWPOS=0 M_OPTARGNEXT=0
  local i=0 n=${#text} c j end inner
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
      "'")
        m_flush
        j=$((i+1))
        while [ "$j" -lt "$n" ] && [ "${text:j:1}" != "$c" ]; do
          [ "${text:j:1}" = '\' ] && j=$((j+1))
          j=$((j+1))
        done
        inner="${text:i+1:j-i-1}"
        # single quotes are literal data unless they are executed text
        if m_is_payload; then
          M_OUT+="$inner"
          tok="<q>"
        elif m_opt_token "$inner"; then
          M_OUT+="$inner"
          tok="$inner"
        else
          M_OUT+="<q>"
          tok="<q>"
        fi
        M_MASKNEXT=0
        M_PREVTOK="$M_LASTTOK"
        M_LASTTOK="$tok"
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
            if m_is_payload; then
              M_OUT+="$inner"
              tok="<q>"
            elif m_opt_token "$inner"; then
              M_OUT+="$inner"
              tok="$inner"
            else
              mask_double "$inner"
              tok="<q>"
            fi
            ;;
          '`')
            scan_text "$inner"
            M_OUT+="\`${M_SCAN_OUT}\`"
            tok="<sub>"
            ;;
        esac
        M_MASKNEXT=0
        M_PREVTOK="$M_LASTTOK"
        M_LASTTOK="$tok"
        i=$((j+1))
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
        elif [ "${text:i+1:1}" = "'" ] || [ "${text:i+1:1}" = '"' ]; then
          # ANSI-C quoting (`$'…'`) and locale quoting (`$"…"`): the `$`
          # belongs to the quote, not to the previous token — keep the
          # interpreter context (`bash -c $'pkill -f x'` must still see -c as
          # the payload flag). The quote itself is handled next iteration.
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
}

# ---- rule evaluation, per statement ----
# A compound command is denied only if at least one statement is denied.
# Statements split on `;`, `&`, `||` and newlines; `|` separates pipeline
# segments inside a statement. The `&` in `2>&1` is a redirect, not a
# statement boundary.
statements() { # $1 = masked text -> statements one per line
  printf '%s' "$1" | sed -E 's/([<>])&/\1/g; s/\|\|/;/g' | tr ';&\n' '\n\n\n'
}

is_data_segment() {
  local first
  first="$(printf '%s' "$1" | awk '{print $1; exit}')"
  case "$READONLY" in *" $first "*) ;; *) return 1 ;; esac
  case "$1" in *'$('* | *'`'*) return 1 ;; esac
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
        case "$seg" in *'$('* | *'`'*) return 0 ;; *) continue ;; esac
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
at_command_position() {
  local i="$1" j t prev
  if [ "${W_FRESH[i]}" = 1 ]; then return 0; fi   # $(pkill …), backtick, quote payload
  for ((j=i-1; j>=0; j--)); do
    t="${W_WORDS[j]}"
    case "$WRAPPER_WORDS $CODE_SHELLS $PAYLOAD_CMDS" in *" $t "*) return 0 ;; esac
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

scan_flag_stmt() { # $1=statement $2=program $3=short letter $4=long name
  local seg
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    is_data_segment "$seg" && continue
    seg_invokes "$seg" "$2" || continue
    has_flag "$seg" "$3" "$4" && return 0
  done < <(segs_with_stmt "$1" "$2")
  return 1
}

# gateway.cgroup_cleanup (hermes) SIGKILLs every PID in the caller's own
# cgroup — it is the gateway unit's ExecStopPost, never a shell command.
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
pipes_to_stdin_shell() {
  printf '%s' "$1" | grep -qE "$STDIN_SHELL"
}

STMT_REASON=""
stmt_denied() {
  local stmt="$1"
  if reaps_own_cgroup "$stmt"; then
    STMT_REASON="gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup — from an agent shell that is the agent's own process tree. It is the hermes-gateway unit's ExecStopPost; run it only via systemctl --user stop/restart hermes-gateway-penetrate."
    return 0
  fi
  # getopt_long runs any unique prefix of a long option: `--f` IS `--full`
  # (pkill/pgrep have no other --f* option). `--full=v` is not: it is an
  # argument to a no-argument option and dies in getopt_long (see has_flag).
  if scan_flag_stmt "$stmt" pkill f 'f*'; then
    STMT_REASON="pkill -f matches the full cmdline of every process, including the shell running this very command."
    return 0
  fi
  if scan_flag_stmt "$stmt" pgrep f 'f*' && has_kill_sink "$stmt"; then
    STMT_REASON="pgrep -f combined with kill on the same command line: the pattern still sits in the killing shell's argv."
    return 0
  fi
  # psmisc killall's long option is --regexp, and getopt_long accepts any
  # unique prefix (--re, --rege, --regex, --regexp all run): match the whole
  # --re* family, not a single spelling.
  if scan_flag_stmt "$stmt" killall r 're*'; then
    STMT_REASON="killall -r/--regexp matches by regex from inside a cmdline that contains the same text."
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
if pipes_to_stdin_shell "$cmd" && printf '%s' "$cmd" | grep -qE "$KILLWORD"; then
  reason="piping text into a shell runs it: the kill pattern inside that text would execute in the very shell being piped to."
else
  mask_heredocs "$cmd"
  scan_text "$M_HEREDOC"
  while IFS= read -r stmt || [ -n "$stmt" ]; do
    [ -n "$stmt" ] || continue
    if stmt_denied "$stmt"; then
      reason="$STMT_REASON"
      break
    fi
  done < <(statements "$M_SCAN_OUT")
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
