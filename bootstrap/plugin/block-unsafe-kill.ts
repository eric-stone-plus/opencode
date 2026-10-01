import type { Plugin } from "@opencode-ai/plugin"

const PRE = "(^|[\\s;|&()\"'`$/])"
const KILL = new RegExp(PRE + "(kill|killall)([\\s;|-]|$)")
const PS = new RegExp(PRE + "ps\\s")
const PIPE_GREP = /\|\s*grep/
const GREP_FROM_FILE = /grep[^|;&]*\s(-[^\s]*f|--file)/

const READONLY = new Set([
  "grep", "rg", "ag", "ack", "fgrep", "egrep", "jq", "cat", "head", "tail",
  "less", "more", "nl", "wc", "sed", "awk", "echo", "printf", "true",
  "sort", "uniq",
])

// A quoted argument to one of these is OPERATOR text (it will be executed),
// not data: keep it live. `bash|sh|zsh|dash -c` payloads, `timeout … bash -c`
// (the -c rule sees through the prefix), `eval`, and `ssh` remote commands.
const CODE_SHELLS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "python", "python3", "python2", "pypy", "pypy3",
])
const PYTHONS = new Set(["python", "python3", "python2", "pypy", "pypy3"])
const CODE_E = new Set(["perl", "ruby", "node", "deno", "lua"])
const PAYLOAD_CMDS = new Set(["eval", "ssh"])
// Bare shell interpreters: anything that reads COMMANDS from a pipe/stdin.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"])
// Wrappers that only schedule the real command (sudo nice -n 5 pkill …): a
// kill-family word after one of these is still an invocation.
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nice", "nohup", "time", "timeout", "stdbuf",
  "setsid", "command", "builtin", "exec", "xargs",
])

const FIX = `Do NOT retry the same shape. Use one of:
  1) two separate calls: ps -eo pid=,ppid=,comm=,args= then kill -TERM <numeric PID> (exclude $$ and $PPID)
  2) PID file from startup: setsid ./prog > run.log 2>&1 & echo $! > run.pid then kill -- -"$(ps -o pgid= -p "$(cat run.pid)")"
  3) pattern from a file: ps -eo pid=,args= | grep -F -f /tmp/kill.pat | awk '{print $1}' | xargs -r kill
  4) change the axis: fuser -k PORT/tcp, systemctl kill UNIT, docker compose down
Full rules: ~/.config/opencode/AGENTS.md`

// ---- masking stage 1: heredoc bodies are stdin data, not operators ----
// `cat > /tmp/x.sh <<'EOF' …body… EOF` is the guard's own documented approach
// #6 (write the script to disk, run the file). Mask every body line up to its
// terminator so patterns inside the body are never scanned as operator text.
// A QUOTED delimiter (<<'EOF' / <<"EOF") makes the body pure data: mask it
// whole. An UNQUOTED delimiter keeps one live channel — `$(…)`/backticks
// expand when the heredoc is read — so mask that body like a double-quoted
// span: literals die, substitutions stay as operator text. `cat <<EOF` +
// `$(pkill -f x)` therefore blocks.
function maskHeredocs(cmd: string): string {
  const out: string[] = []
  const delims: Array<{ word: string; stripTabs: boolean; literal: boolean }> = []
  for (const line of cmd.split("\n")) {
    const d = delims[0]
    if (d !== undefined) {
      const probe = d.stripTabs ? line.replace(/^\t+/, "") : line
      if (probe === d.word) {
        delims.shift()
        out.push(line)
        continue
      }
      out.push(d.literal ? "<heredoc-body>" : maskDataSpan(line, "<heredoc-body>"))
      continue
    }
    let rest = line
    let lineOut = ""
    while (rest.includes("<<")) {
      const at = rest.indexOf("<<")
      lineOut += rest.slice(0, at + 2)
      rest = rest.slice(at + 2)
      if (rest.startsWith("<")) continue // here-string (<<<), not a heredoc
      const m = rest.match(/^-?[ \t]*(['"]?)([A-Za-z0-9_]+)/)
      const word = m?.[2]
      const quote = m?.[1]
      if (word !== undefined)
        delims.push({ word, stripTabs: rest.startsWith("-"), literal: quote === "'" || quote === '"' })
    }
    out.push(lineOut + rest)
  }
  return out.join("\n")
}

// Data span whose substitutions still run (double-quoted text, unquoted
// heredoc bodies): literal chunks collapse to `mask`, `$(…)`/backticks are
// rescanned as live operator text and spliced back in. Definitions live here
// (above scanText) because scanText and the heredoc stage call each other
// through function hoisting.
function maskDataSpan(inner: string, mask = "<q>"): string {
  let out = ""
  let literal = ""
  let i = 0
  while (i < inner.length) {
    if (inner[i] === "\\") {
      literal += inner.slice(i, i + 2)
      i += 2
      continue
    }
    if (inner.startsWith("$(", i) || inner[i] === "`") {
      if (literal) {
        out += mask
        literal = ""
      }
      if (inner[i] === "`") {
        let j = i + 1
        while (j < inner.length && inner[j] !== "`") {
          if (inner[j] === "\\") j++
          j++
        }
        out += "`" + scanText(inner.slice(i + 1, j)) + "`"
        i = j + 1
        continue
      }
      const end = matchParen(inner, i + 2)
      out += "$(" + scanText(inner.slice(i + 2, end)) + ")"
      i = end + 1
      continue
    }
    literal += inner[i]
    i++
  }
  if (literal) out += mask
  return out
}

// Index of the ")" closing the "$(" that starts at `start`.
function matchParen(text: string, start: number): number {
  let depth = 1
  let i = start
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++
        j++
      }
      i = j + 1
      continue
    }
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return text.length
}

// ---- masking stage 2: quotes, -m/--message arguments, substitutions ----
// Quoted tokens are DATA (commit messages, inspector arguments). Executed
// text is not: a quote that is the payload of an interpreter -c/-e/-m, of
// eval, or of ssh stays live and raw. Command substitutions are always live.
function scanText(text: string, keepQuotes = false): string {
  let out = ""
  let pending = ""
  let segFirst = ""
  let lastTok = ""
  let prevTok = ""
  let maskNext = false
  // git commit: after -m everything (message + pathspecs) is data.
  let maskRest = false
  // Interpreter context for the current pipeline segment: the last
  // interpreter-class token seen (bash/python/perl/…), and whether a
  // positional argument (script name, `extglob` after -O, host for ssh…)
  // already followed it. `-c` is a payload flag only BEFORE the first
  // positional: `bash --norc -c "…"` and `bash -O extglob -c "…"` are
  // payloads, `bash script.sh -c "…"` passes -c to the script.
  let segInterp = ""
  let sawPositional = false
  let optArgNext = false

  const flush = () => {
    if (!pending) return
    const tok = pending
    pending = ""
    if (maskNext || maskRest) {
      out += "<q>"
      maskNext = false
      prevTok = lastTok
      lastTok = "<q>"
      return
    }
    if (tok.startsWith("--message=")) {
      if (tok.length > "--message=".length) {
        out += "<msg-masked>"
        if (segFirst === "git") maskRest = true
        prevTok = lastTok
        lastTok = "<msg-masked>"
        return
      }
      out += "--message="
      maskNext = true
      prevTok = lastTok
      lastTok = tok
      return
    }
    out += tok
    if (tok === "-m" || tok === "--message" || /^-[A-Za-z0-9]*m$/.test(tok)) {
      // Bundled short-option cluster carrying -m (`-qm`, `-am`, `-1m`, ...):
      // the next token is the commit message (data), not operators.
      // `python -m module` executes the module (a live operator, e.g.
      // `python -m gateway.cgroup_cleanup`); any other -m takes a message.
      // `git commit -m fix pkill -f x`: the tail is message + pathspec data,
      // so mask to the end of the statement, not just one token.
      if (!PYTHONS.has(lastTok)) {
        maskNext = true
        if (segFirst === "git") maskRest = true
      }
    }
    if (CODE_SHELLS.has(tok) || CODE_E.has(tok)) {
      segInterp = tok
      sawPositional = false
      optArgNext = false
    } else if (optArgNext) {
      optArgNext = false // argument of -O/-o (`extglob`), not a positional
    } else if (tok.startsWith("-") && tok.length > 1) {
      // any option, long or short (`--norc`, `-O`, `-c`, `--`): not a
      // positional, so a later -c still addresses the interpreter
      if (tok === "-O" || tok === "-o") optArgNext = true
    } else if (tok !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      sawPositional = true // script name / host / filename
    }
    prevTok = lastTok
    lastTok = tok
    if (!segFirst) segFirst = tok
  }

  // Short flags bundle (`bash -ec '…'`, `perl -ne '…'`): getopt still takes
  // the next word as the payload, so a cluster carrying the payload letter
  // behaves exactly like the bare flag. Long options never bundle. Read at
  // call time: the tokenizer keeps advancing while quotes are masked.
  const payloadLetter = (): string => {
    if (lastTok === "-c") return "c"
    if (lastTok === "-m") return "m"
    if (lastTok === "-e") return "e"
    if (/^-[^-].+/.test(lastTok)) {
      if (lastTok.includes("c")) return "c"
      if (lastTok.includes("m")) return "m"
      if (lastTok.includes("e")) return "e"
    }
    return ""
  }

  const isPayload = () => {
    const flag = payloadLetter()
    return (
      PAYLOAD_CMDS.has(segFirst) ||
      (flag === "c" &&
        (CODE_SHELLS.has(prevTok) || (CODE_SHELLS.has(segInterp) && !sawPositional))) ||
      (flag === "m" && PYTHONS.has(prevTok)) ||
      (flag === "e" && CODE_E.has(prevTok))
    )
  }

  // A double-quoted span is data, but substitutions inside it still run.
  const maskDouble = (inner: string) => {
    out += maskDataSpan(inner)
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === " " || c === "\t" || c === "\r") {
      flush()
      out += c
      i++
      continue
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      flush()
      maskNext = false
      maskRest = false
      segFirst = ""
      segInterp = ""
      sawPositional = false
      optArgNext = false
      lastTok = ""
      prevTok = ""
      out += c
      i++
      continue
    }
    // ANSI-C quoting (`$'…'`) and locale quoting (`$"…"`): the `$` belongs to
    // the quote, not to the previous token — keep the interpreter context
    // (`bash -c $'pkill -f x'` must still see -c as the payload flag).
    if (c === "$" && (text[i + 1] === "'" || text[i + 1] === '"')) {
      flush()
      out += "$"
      i++
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      flush()
      let j = i + 1
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++
        j++
      }
      const inner = text.slice(i + 1, j)
      let tok = "<q>"
      if (c === "'") {
        // single quotes are pure data (no substitutions inside), unless the
        // span is executed text
        if (isPayload()) out += inner
        else if (isOptionToken(inner)) {
          out += inner
          tok = inner
        } else out += "<q>"
      } else if (c === '"') {
        if (isPayload()) out += inner
        else if (isOptionToken(inner)) {
          out += inner
          tok = inner
        } else maskDouble(inner)
      } else {
        out += "`" + scanText(inner) + "`"
        tok = "<sub>"
      }
      maskNext = false
      prevTok = lastTok
      lastTok = tok
      i = j + 1
      continue
    }
    if (c === "$" && text[i + 1] === "(") {
      flush()
      const end = matchParen(text, i + 2)
      out += "$(" + scanText(text.slice(i + 2, end)) + ")"
      maskNext = false
      prevTok = lastTok
      lastTok = "<sub>"
      i = end + 1
      continue
    }
    pending += c
    i++
  }
  flush()
  return out
}

// ---- rule evaluation, per statement ----
// A compound command is denied only if at least one statement is denied.
// Statements split on `;`, `&`, `||` and newlines; `|` separates pipeline
// segments inside a statement. The `>&` in `2>&1` is a redirect, not a
// statement boundary.
function statementsOf(masked: string): string[] {
  return masked.replace(/([<>])&/g, "$1").split(/[;&\n]|\|\|/)
}

function firstToken(seg: string): string {
  const m = seg.trim().match(/^\S+/)
  return m ? m[0] : ""
}

// A segment led by a read-only inspector carries the pattern as data, not as
// an operator. Command substitution or a kill inside it voids the exemption.
function isDataSegment(seg: string): boolean {
  if (!READONLY.has(firstToken(seg))) return false
  if (seg.includes("$(") || seg.includes("`")) return false
  return !KILL.test(seg)
}

// A pipeline is only dangerous when it reaches a kill-family sink (or a
// substitution). Inspector-to-inspector pipes (ps | grep | awk | wc …) are
// read-only; `pgrep -f foo | awk '{print $1}'` therefore passes, while
// `pgrep -f foo | awk '{print $1}' | xargs -r kill` does not.
function hasKillSink(stmt: string): boolean {
  return stmt.split("|").some((seg) => {
    if (!KILL.test(seg)) return false
    if (READONLY.has(firstToken(seg)) && !seg.includes("$(") && !seg.includes("`")) return false
    return true
  })
}

// Any *token* of the segment carrying the flag: `-f`, `-9f`, `-fx`, `--full`,
// in any position — so inserting flags before it cannot slip past. A long
// name ending in `*` is a prefix family (`re*` matches `--re`, `--rege`,
// `--regex`, `--regexp`: getopt_long runs any unique prefix of the option).
// `--opt=value` never counts: these options take no argument, so that form
// is a getopt_long error and the invocation does nothing (`--full=v` dies
// with "option doesn't allow an argument").
function hasFlag(seg: string, letter: string, longName: string): boolean {
  const prefix = longName.endsWith("*") ? longName.slice(0, -1) : null
  for (const raw of seg.trim().split(/\s+/)) {
    // A quoted flag (`pkill "-f" x`) still hands -f to getopt once the shell
    // strips the quotes; classify the de-quoted token or the guard goes blind.
    const w = dequote(raw)
    if (w.startsWith("--")) {
      if (w.includes("=")) continue
      if (prefix !== null ? w.startsWith(`--${prefix}`) : w === `--${longName}`) return true
      continue
    }
    if (w.length > 1 && w.startsWith("-") && w.includes(letter)) return true
  }
  return false
}

// Strip one layer of matching shell quotes from a word.
function dequote(word: string): string {
  if (word.length >= 2) {
    const q = word[0]
    if ((q === '"' || q === "'") && word[word.length - 1] === q) return word.slice(1, -1)
  }
  return word
}

// Is a quoted span exactly one option token (`-f`, `--full`, `-9f`)? The shell
// strips the quotes before getopt sees the word, so a quoted flag is still a
// flag — the mask must keep it visible or hasFlag goes blind. A span with
// whitespace is prose, not a flag.
function isOptionToken(inner: string): boolean {
  return /^-\S+$/.test(inner)
}

function segsWith(stmt: string, prog: string): string[] {
  const re = new RegExp(PRE + prog + "(\\s|$)")
  return stmt.split("|").filter((s) => re.test(s))
}

// Is toks[i] an INVOCATION of the program, or just an argument? Walk back
// over flags, flag arguments (`-O extglob`, `nice -n 5`, `timeout 30`) and
// `VAR=value` prefixes: if the trail ends at a wrapper (`xargs`, `sudo`, …)
// or an interpreter shell (`bash -c …`), the word runs. A real positional
// before it (`git commit -m fix pkill …`, `grep killall .`) makes it data.
function atCommandPosition(words: Word[], i: number): boolean {
  if (words[i].fresh) return true // `$(pkill …)`, backtick, quote payload start
  for (let j = i - 1; j >= 0; j--) {
    const t = words[j].t
    if (WRAPPERS.has(t) || CODE_SHELLS.has(t) || PAYLOAD_CMDS.has(t)) return true
    if (t.startsWith("-") || /^\d+[a-z%]?$/.test(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue
    // flag argument (`-O extglob`, `-m fix`, `-n 5`) or ssh's hostname slot
    if (j > 0) {
      const prev = words[j - 1].t
      if ((prev.startsWith("-") && prev.length > 1) || PAYLOAD_CMDS.has(prev)) continue
    }
    return false
  }
  return true
}

// Words of a segment with substitution/quote boundaries marked: the first
// word after `$(`, a backtick, or a quote opener starts a fresh command
// context (`git commit -m $(pkill -f x)` runs pkill despite `commit` before).
type Word = { t: string; fresh: boolean }
function wordsOf(seg: string): Word[] {
  const out: Word[] = []
  let cur = ""
  let fresh = true
  const push = () => {
    if (cur !== "") {
      out.push({ t: cur, fresh })
      fresh = false
      cur = ""
    }
  }
  for (const c of seg) {
    if (/\s/.test(c)) {
      push()
    } else if (c === "(" || c === ")" || c === "`" || c === "$" || c === '"' || c === "'") {
      push()
      fresh = true
    } else {
      cur += c
    }
  }
  push()
  return out
}

function segHasInvocation(seg: string, wordTest: (t: string) => boolean): boolean {
  const words = wordsOf(seg)
  return words.some((w, i) => wordTest(w.t) && atCommandPosition(words, i))
}

function scanFlag(stmt: string, prog: string, letter: string, longName: string): boolean {
  const wordTest = (t: string) => t === prog || t.endsWith(`/${prog}`)
  return segsWith(stmt, prog).some(
    (s) => !isDataSegment(s) && segHasInvocation(s, wordTest) && hasFlag(s, letter, longName),
  )
}

// gateway.cgroup_cleanup (hermes) SIGKILLs every PID in the caller's own
// cgroup — designed to run only as ExecStopPost inside the gateway unit.
// From a tool shell the caller's cgroup IS the agent's process tree
// (2026-09-19: three opencode TUI deaths, "Process Exited from Signal 9").
// Match it as an INVOCATION token only, not as a bare substring: interpreter
// form (`python -m gateway.cgroup_cleanup`), direct command word
// (`cgroup_cleanup`, `/usr/lib/gateway/cgroup_cleanup`), or the payload of a
// wrapper (`xargs cgroup_cleanup`, `bash -c "cgroup_cleanup"`). A bare
// mention in a filename stays data: `vim cgroup_cleanup.md` must pass (the
// token is `cgroup_cleanup.md`, not `cgroup_cleanup`). Commit messages
// mentioning it are masked above, so only live use is caught.
const CG_TOKEN = /^([^\s]*\/)?([\w.]*\.)?cgroup_cleanup$/
function reapsOwnCgroup(stmt: string): boolean {
  return stmt.split("|").some((s) => {
    if (isDataSegment(s)) return false
    return segHasInvocation(s, (t) => CG_TOKEN.test(t))
  })
}

// `… | bash` (bare shell reading stdin) EXECUTES the upstream text, so any
// kill-family word upstream is a live operator, not data: `echo pkill -f x |
// bash`, `printf '%s\n' 'pkill -f x' | bash`, `cat <<'EOF' | bash` bodies.
const STDIN_SHELL = /(^|[|;&\n])\s*((sudo|doas|env|nice|nohup|time|timeout|stdbuf|setsid|command|builtin|exec|xargs)\s+)*((ba|z|da|k)?sh)\s*($|[;&\n])/
function pipesToStdinShell(cmd: string): boolean {
  return STDIN_SHELL.test(cmd)
}

function inspect(cmd: string): string | undefined {
  if (pipesToStdinShell(cmd) && /\b(kill|killall|pkill|pgrep|cgroup_cleanup)\b/.test(cmd)) {
    return "piping text into a shell runs it: the kill pattern inside that text would execute in the very shell being piped to."
  }
  const masked = scanText(maskHeredocs(cmd))
  for (const stmt of statementsOf(masked)) {
    if (reapsOwnCgroup(stmt)) {
      return "gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup — from an agent shell that is the agent's own process tree. It is the hermes-gateway unit's ExecStopPost; run it only via systemctl --user stop/restart hermes-gateway-penetrate."
    }
    if (scanFlag(stmt, "pkill", "f", "f*")) {
      return "pkill -f matches the full cmdline of every process, including the shell running this very command."
    }
    if (scanFlag(stmt, "pgrep", "f", "f*") && hasKillSink(stmt)) {
      return "pgrep -f combined with kill on the same command line: the pattern still sits in the killing shell's argv."
    }
    // psmisc killall's long option is --regexp, and getopt_long accepts any
    // unique prefix (--re, --rege, --regex, --regexp all run): match the
    // whole --re* family, not a single spelling.
    if (scanFlag(stmt, "killall", "r", "re*")) {
      return "killall -r/--regexp matches by regex from inside a cmdline that contains the same text."
    }
    if (PS.test(stmt) && PIPE_GREP.test(stmt) && hasKillSink(stmt) && !GREP_FROM_FILE.test(stmt)) {
      return "ps | grep <literal> | kill: grep matches itself and the wrapping shell's argv."
    }
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
