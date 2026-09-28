import type { Plugin } from "@opencode-ai/plugin"

const PRE = "(^|[\\s;|&()\"'`$])"
const KILL = new RegExp(PRE + "(kill|killall|xargs)[\\s;|-]")
const PS = new RegExp(PRE + "ps\\s")
const PIPE_GREP = /\|\s*grep/
const GREP_FROM_FILE = /grep[^|;&]*\s(-[^\s]*f|--file)/
const SEG_SPLIT = /[|;&\n]/

const READONLY = new Set([
  "grep", "rg", "ag", "ack", "fgrep", "egrep", "jq", "cat", "head", "tail",
  "less", "more", "nl", "wc", "sed", "awk", "echo", "printf", "true",
])

const FIX = `Do NOT retry the same shape. Use one of:
  1) two separate calls: ps -eo pid=,ppid=,comm=,args= then kill -TERM <numeric PID> (exclude $$ and $PPID)
  2) PID file from startup: setsid ./prog > run.log 2>&1 & echo $! > run.pid then kill -- -"$(ps -o pgid= -p "$(cat run.pid)")"
  3) pattern from a file: ps -eo pid=,args= | grep -F -f /tmp/kill.pat | awk '{print $1}' | xargs -r kill
  4) change the axis: fuser -k PORT/tcp, systemctl kill UNIT, docker compose down
Full rules: ~/.config/opencode/AGENTS.md`

function segments(cmd: string): string[] {
  return cmd.split(SEG_SPLIT)
}

function firstToken(seg: string): string {
  const m = seg.trim().match(/^\S+/)
  return m ? m[0] : ""
}

// A segment led by a read-only inspector carries the pattern as data, not as an
// operator. Command substitution or a kill inside it voids the exemption.
function isDataSegment(seg: string): boolean {
  if (!READONLY.has(firstToken(seg))) return false
  if (seg.includes("$(") || seg.includes("`")) return false
  return !KILL.test(seg)
}

// Any *token* of the segment carrying the flag: `-f`, `-9f`, `-fx`, `--full`,
// in any position — so inserting flags before it cannot slip past.
function hasFlag(seg: string, letter: string, longName: string): boolean {
  for (const w of seg.trim().split(/\s+/)) {
    if (w === `--${longName}`) return true
    if (w.startsWith("--")) continue
    if (w.length > 1 && w.startsWith("-") && w.includes(letter)) return true
  }
  return false
}

function segsWith(cmd: string, prog: string): string[] {
  const re = new RegExp(PRE + prog + "(\\s|$)")
  return segments(cmd).filter((s) => re.test(s))
}

function scanFlag(cmd: string, prog: string, letter: string, longName: string): boolean {
  return segsWith(cmd, prog).some((s) => !isDataSegment(s) && hasFlag(s, letter, longName))
}

// gateway.cgroup_cleanup (hermes) SIGKILLs every PID in the caller's own
// cgroup — designed to run only as ExecStopPost inside the gateway unit.
// From a tool shell the caller's cgroup IS the agent's process tree
// (2026-09-19: three opencode TUI deaths, "Process Exited from Signal 9").
// git commit segments are skipped: a message mentioning it is data.
function reapsOwnCgroup(cmd: string): boolean {
  return segments(cmd).some(
    (s) => s.includes("cgroup_cleanup") && !/^\s*git\b[^]*\bcommit\b/.test(s) && !isDataSegment(s),
  )
}

function inspect(cmd: string): string | undefined {
  if (reapsOwnCgroup(cmd)) {
    return "gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup — from an agent shell that is the agent's own process tree. It is the hermes-gateway unit's ExecStopPost; run it only via systemctl --user stop/restart hermes-gateway-penetrate."
  }
  if (scanFlag(cmd, "pkill", "f", "full")) {
    return "pkill -f matches the full cmdline of every process, including the shell running this very command."
  }
  if (KILL.test(cmd) && scanFlag(cmd, "pgrep", "f", "full")) {
    return "pgrep -f combined with kill on the same command line: the pattern still sits in the killing shell's own argv."
  }
  if (scanFlag(cmd, "killall", "r", "regex")) {
    return "killall -r matches by regex from inside a cmdline that contains the same text."
  }
  if (PS.test(cmd) && PIPE_GREP.test(cmd) && KILL.test(cmd) && !GREP_FROM_FILE.test(cmd)) {
    return "ps | grep <literal> | kill: grep matches itself and the wrapping shell's argv."
  }
  return undefined
}

export default (async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const cmd = String((output.args as { command?: unknown })?.command ?? "")
      if (!cmd) return
      const reason = inspect(cmd)
      if (reason) throw new Error(`Blocked: ${reason} ${FIX}`)
    },
  }
}) satisfies Plugin
