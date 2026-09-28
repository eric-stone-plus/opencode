#!/usr/bin/env bash
# Regression battery for block-unsafe-kill.sh. Run after every edit of the guard:
#   ~/.config/agent-hooks/run-cases.sh
set -uo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
pass=0 fail=0
while IFS= read -r c; do
  label=$(jq -r '.label' <<<"$c")
  cmd=$(jq -r '.cmd' <<<"$c")
  exp=$(jq -r '.expect' <<<"$c")
  if [ "$(jq -r '.raw // false' <<<"$c")" = "true" ]; then
    printf '%s' "$cmd" | "$dir/block-unsafe-kill.sh" >/dev/null 2>&1
  else
    jq -cn --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' | "$dir/block-unsafe-kill.sh" >/dev/null 2>&1
  fi
  rc=$?; got=allow; [ "$rc" -eq 2 ] && got=block
  if [ "$got" = "$exp" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); printf 'FAIL want=%s got=%s  %s\n' "$exp" "$got" "$label"
  fi
done < <(jq -c '.[]' "$dir/cases.json")
printf 'cases: %d, pass: %d, fail: %d\n' "$((pass+fail))" "$pass" "$fail"
[ "$fail" -eq 0 ]
