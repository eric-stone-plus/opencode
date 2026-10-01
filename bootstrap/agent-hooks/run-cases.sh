#!/usr/bin/env bash
# Legacy bash-only regression battery for block-unsafe-kill.sh. The full
# battery is run-cases.ts (bash hook + TS plugin); this one exists for
# environments without bun. Fails LOUDLY (red output + nonzero exit) when
# cases.json is missing, jq is missing, or a case run crashes — the battery
# must never go green while the guard is degraded.
#   ~/.config/agent-hooks/run-cases.sh
set -uo pipefail
RED=$'\033[31m' RESET=$'\033[0m'
die() { printf '%sHARNESS FAIL: %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

dir="${0%/*}"
[ "$dir" = "$0" ] && dir=.
command -v jq >/dev/null 2>&1 || die "jq missing — the guard is degraded (it warns and passes without jq)"
[ -f "$dir/cases.json" ] || die "cases.json missing at $dir/cases.json"
[ -x "$dir/block-unsafe-kill.sh" ] || die "block-unsafe-kill.sh missing or not executable at $dir"

pass=0 fail=0 total=0
while IFS= read -r c; do
  [ -n "$c" ] || continue
  total=$((total+1))
  label=$(jq -r '.label' <<<"$c") || die "jq failed to parse a case line"
  cmd=$(jq -r '.cmd' <<<"$c") || die "jq failed to parse a case line"
  exp=$(jq -r '.expect' <<<"$c") || die "jq failed to parse a case line"
  if [ "$(jq -r '.raw // false' <<<"$c")" = "true" ]; then
    printf '%s' "$cmd" | "$dir/block-unsafe-kill.sh" >/dev/null 2>&1
  else
    jq -cn --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' | "$dir/block-unsafe-kill.sh" >/dev/null 2>&1
  fi
  rc=$?
  case "$rc" in
    0) got=allow ;;
    2) got=block ;;
    *) fail=$((fail+1)); printf '%sFAIL crash (exit %d)  %s%s\n' "$RED" "$rc" "$label" "$RESET"; continue ;;
  esac
  if [ "$got" = "$exp" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); printf '%sFAIL want=%s got=%s  %s%s\n' "$RED" "$exp" "$got" "$label" "$RESET"
  fi
done < <(jq -c '.[]' "$dir/cases.json")
[ "$total" -gt 0 ] || die "cases.json has no cases"
printf 'cases: %d, pass: %d, fail: %d\n' "$total" "$pass" "$fail"
[ "$fail" -eq 0 ]
