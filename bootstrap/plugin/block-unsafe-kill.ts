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
// env doubles as an interpreter via --split-string/-S (the split text runs as a
// command line), so it is tracked with the interpreter set; its -S payload is
// recognized by the `s` payload letter below.
const CODE_SHELLS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "python", "python3", "python2", "pypy", "pypy3",
  "env",
])
const PYTHONS = new Set(["python", "python3", "python2", "pypy", "pypy3"])
const CODE_E = new Set(["perl", "ruby", "node", "deno", "lua"])
const PAYLOAD_CMDS = new Set(["eval", "ssh"])
// Bare shell interpreters: anything that reads COMMANDS from a pipe/stdin.
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"])
// Wrappers that only schedule the real command (sudo nice -n 5 pkill …): a
// kill-family word after one of these is still an invocation. Prefix executors
// (taskset/nsenter/setpriv/strace/…) exec their argv unchanged, so they are
// wrappers too. busybox provides kill-family applets (`busybox pkill -f x`).
const WRAPPERS = new Set([
  "sudo", "doas", "env", "nice", "nohup", "time", "timeout", "stdbuf",
  "setsid", "command", "builtin", "exec", "xargs", "busybox", "nsenter",
  "setpriv", "unshare", "taskset", "ionice", "chrt", "prlimit", "numactl",
  "strace", "ltrace", "setarch", "watch", "systemd-run",
])
// Words whose identity matters to the guard even when quoted: a quoted
// `"pkill"` still EXECUTES pkill, so the mask must keep these visible (the
// basename is what lands in argv[0]: "/usr/bin/pkill" counts too).
const GUARD_WORDS = new Set([
  "kill", "killall", "pkill", "pgrep", "cgroup_cleanup", "git",
  ...CODE_SHELLS, ...CODE_E, ...PAYLOAD_CMDS, ...WRAPPERS,
])
// Shell block keywords are transparent: `then pkill -f x` executes pkill.
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "for", "select", "!"])

const FIX = `Do NOT retry the same shape. Use one of:
  1) two separate calls: ps -eo pid=,ppid=,comm=,args= then kill -TERM <numeric PID> (exclude $$ and $PPID)
  2) PID file from startup: setsid ./prog > /tmp/run.log 2>&1 & echo $! > /tmp/run.pid then kill -- -"$(ps -o pgid= -p "$(cat /tmp/run.pid)")"
  3) pattern from a file: ps -eo pid=,args= | grep -F -f /tmp/kill.pat | awk '{print $1}' | xargs -r kill
  4) change the axis: fuser -k PORT/tcp, systemctl kill UNIT, docker compose down
Full rules: ~/.config/opencode/AGENTS.md`

// ---- variable resolution (dataflow-lite) — f197 port ----
// The guard tracks simple `NAME=value` assignments it has seen in the current
// substitution frame, because the real shell expands them too:
// `F=-f; pkill $F x` assembles a real `-f`. Values that were quoted and masked
// (or contain substitutions) are recorded as the opaque marker `<v>`: the
// guard knows the variable exists but not its content. Subshell frames (`$(…)`)
// inherit bindings and discard their own on exit, like the real shell.
// PORTABILITY: this table is deliberately duplicated in the bash hook
// (agent-hooks/block-unsafe-kill.sh) — the plugin is self-contained and must
// not import from agent-hooks. Keep both copies semantically identical.
let vars = new Map<string, string>()

// Parse a $NAME / ${NAME} / ${NAME:-def} / ${NAME:=def} reference at `i`.
// Returns null for anything not resolvable (${N:?msg}, ${N:+alt}, …).
function parseVarRef(
  text: string,
  i: number,
): { name: string; op: string; def: string; end: number } | null {
  if (text[i + 1] === "{") {
    let j = i + 2
    let br = ""
    while (j < text.length && text[j] !== "}") {
      br += text[j]
      j++
    }
    if (j >= text.length) return null
    let name = br
    let op = ""
    let def = ""
    const colon = br.indexOf(":")
    if (colon >= 0) {
      name = br.slice(0, colon)
      const rest = br.slice(colon + 1)
      if (rest.startsWith("-") || rest.startsWith("=")) {
        op = rest[0]
        def = rest.slice(1)
      } else return null
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
    return { name, op, def, end: j + 1 }
  }
  let j = i + 1
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++
  const name = text.slice(i + 1, j)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
  return { name, op: "", def: "", end: j }
}

// Resolve `name` with operator `op` ('' | '-' | '=') and default `def` against
// vars. `:-` and `:=` fire on unset OR empty, like the real shell.
function varValue(name: string, op: string, def: string): { set: boolean; out: string } {
  if (vars.has(name)) {
    let out = vars.get(name) as string
    if (out === "" && op !== "") out = def
    return { set: true, out }
  }
  if (op !== "") return { set: true, out: def }
  return { set: false, out: "" }
}

// ANSI-C quoting decode ($'…'): escapes expand before the word reaches argv,
// so classification must see the decoded text (`pkill -$'\146' x` is a real
// `-f`). Faithful to bash: unknown escapes keep their backslash, NUL vanishes,
// surrogate/out-of-range codepoints collapse to 0x1A.
function decodeAnsiC(s: string): string {
  let out = ""
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== "\\") {
      out += c
      i++
      continue
    }
    i++
    if (i >= s.length) {
      out += "\\"
      break
    }
    let e = s[i]
    i++
    if ("abefnrtv".includes(e) && e.length === 1) {
      const map: Record<string, string> = {
        a: "\x07", b: "\x08", e: "\x1b", f: "\x0c", n: "\n", r: "\r", t: "\t", v: "\v",
      }
      out += map[e] ?? ""
      continue
    }
    if (e === "E") {
      out += "\x1b"
      continue
    }
    if ("\\" === e || e === "'" || e === '"' || e === "?") {
      out += e
      continue
    }
    if (e === "x" || e === "u" || e === "U") {
      const max = e === "u" ? 4 : e === "U" ? 8 : 2
      let digits = ""
      while (i < s.length && digits.length < max && /[0-9A-Fa-f]/.test(s[i])) {
        digits += s[i]
        i++
      }
      if (digits === "") {
        out += "\\" + e
        continue
      }
      const cp = parseInt(digits, 16)
      if (cp === 0) {
        // NUL vanishes
      } else if (cp > 1114111 || (cp >= 55296 && cp <= 57343)) {
        out += "\x1a"
      } else {
        out += String.fromCodePoint(cp)
      }
      continue
    }
    if (/[0-7]/.test(e)) {
      let digits = e
      while (i < s.length && digits.length < 3 && /[0-7]/.test(s[i])) {
        digits += s[i]
        i++
      }
      const cp = parseInt(digits, 8)
      if (cp !== 0) out += String.fromCharCode(cp)
      continue
    }
    if (e === "c") {
      if (i < s.length) {
        e = s[i]
        i++
        const cp = e.codePointAt(0) ?? 0
        const ctl = cp & 31
        if (ctl !== 0) out += String.fromCharCode(ctl)
      } else {
        out += "\\c"
      }
      continue
    }
    out += "\\" + e
  }
  return out
}

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
// rescanned as live operator text and spliced back in. A variable reference to
// a KNOWN literal binding splices the value (the real shell expands it too,
// e.g. `F=-f; pkill "$F" x`); unknown references stay masked (a quoted
// `$unknown` is one argv word, never a flag). Definitions live here
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
    if (inner[i] === "$" && !inner.startsWith("$(", i)) {
      const ref = parseVarRef(inner, i)
      if (ref) {
        const v = varValue(ref.name, ref.op, ref.def)
        if (v.set) {
          if (literal) {
            out += mask
            literal = ""
          }
          out += v.out
          i = ref.end
          continue
        }
      }
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

  // Interpreter/positional bookkeeping for one visible word (unquoted token or
  // kept-visible quote content — `"bash" -c` executes exactly like bash -c).
  const trackWord = (tok: string) => {
    // Interpreter identity is the argv[0] BASENAME: `/bin/bash -c …` executes
    // exactly like `bash -c …`. Assignments are never interpreter words
    // (`F=bash` must not turn a later -c into a payload flag).
    const tokbase = /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) ? "" : tok.replace(/^.*\//, "")
    if (CODE_SHELLS.has(tokbase) || CODE_E.has(tokbase)) {
      segInterp = tokbase
      sawPositional = false
      optArgNext = false
      return
    }
    if (optArgNext) {
      optArgNext = false // argument of -O/-o (`extglob`), not a positional
      return
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // any option, long or short (`--norc`, `-O`, `-c`, `--`): not a
      // positional, so a later -c still addresses the interpreter
      if (tok === "-O" || tok === "-o") optArgNext = true
      return
    }
    if (tok === "<v>") return // opaque variable content: unknown, not a positional
    if (tok !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      sawPositional = true // script name / host / filename
    }
  }

  const flush = () => {
    if (!pending) return
    let tok = pending
    pending = ""
    if (maskNext || maskRest) {
      out += "<q>"
      maskNext = false
      prevTok = lastTok
      lastTok = "<q>"
      return
    }
    // A whole-token variable reference resolves through assignments seen in
    // this frame: `F=-f; pkill $F x` is a real `-f`. Unknown variables become
    // the opaque marker <v> (an unquoted `$X` word-splits at runtime, so it
    // CAN be a flag): computedArgv denies <v> in kill-family invocations.
    const whole = tok.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
    const defaulted = tok.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|:=)(.*)\}$/)
    if (whole) {
      const v = varValue(whole[1], "", "")
      tok = v.set ? v.out : "<v>"
    } else if (defaulted) {
      const v = varValue(defaulted[1], defaulted[2], defaulted[3])
      tok = v.out
    }
    // An empty substitution result vanishes like the shell's word removal —
    // crucially it must not count as a positional or token for -c detection.
    if (tok === "") return
    // Remember plain literal assignments so later $NAME references resolve.
    // Runs after the mask check on purpose: a masked token is data, not code.
    const assign = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (assign) vars.set(assign[1], assign[2])
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
      // the next token is the commit message (data), not operators. Scoped to
      // git: an arbitrary tool's -m is an ordinary flag (`unshare -m pkill -f
      // x` must keep pkill visible). `python -m module` executes the module
      // (a live operator), so python is exempt either way.
      if (!PYTHONS.has(lastTok) && segFirst === "git") {
        maskNext = true
        maskRest = true
      }
    }
    trackWord(tok)
    prevTok = lastTok
    lastTok = tok
    if (!segFirst) segFirst = tok
  }

  // Short flags bundle (`bash -ec '…'`, `perl -ne '…'`): getopt still takes
  // the next word as the payload, so a cluster carrying the payload letter
  // behaves like the bare flag. The letter may sit anywhere in the cluster:
  // when it is not last, getopt gives it the rest of the cluster as its own
  // argument and the next word is $0 — but deciding that per-interpreter is
  // getopt simulation, so the guard blocks instead (`bash -ce`, `python -cm`).
  // `n` is no-exec syntax checking in every CODE_SHELLS member, so
  // `bash -nc '…'` runs nothing. Long options never bundle. Read at call
  // time: the tokenizer keeps advancing while quotes are masked.
  // The `s` letter is env's -S/--split-string: env word-splits the string and
  // EXECUTES the result, so the quote is a payload (spliced space-separated —
  // env's own splitting means the content is a fresh command line, and keeping
  // its spaces visible lets the statement rules see it).
  const payloadLetter = (): string => {
    if (lastTok === "-c") return "c"
    if (lastTok === "-m") return "m"
    if (lastTok === "-e") return "e"
    if (lastTok === "-S" || lastTok === "--split-string" || lastTok === "--split-string=") return "s"
    if (/^-[^-].+/.test(lastTok)) {
      if (lastTok.includes("c")) return lastTok.includes("n") ? "" : "c"
      if (lastTok.includes("m")) return "m"
      if (lastTok.includes("e")) return "e"
      if (lastTok.includes("S")) return "s"
    }
    return ""
  }

  // Which payload kind isPayload finds: "" (not a payload), "raw" (splice
  // verbatim), or "split" (env -S/--split-string: splice space-separated).
  const isPayload = (): "" | "raw" | "split" => {
    const flag = payloadLetter()
    if (PAYLOAD_CMDS.has(segFirst)) return "raw"
    if (
      flag === "c" &&
      (CODE_SHELLS.has(prevTok) || (CODE_SHELLS.has(segInterp) && !sawPositional))
    )
      return "raw"
    if (flag === "m" && PYTHONS.has(prevTok)) return "raw"
    if (flag === "e" && CODE_E.has(prevTok)) return "raw"
    if (flag === "s" && !sawPositional && segInterp === "env") return "split"
    return ""
  }

  // A double-quoted span is data, but substitutions inside it still run.
  const maskDouble = (inner: string) => {
    out += maskDataSpan(inner)
  }

  // Emit one quoted span into out after classification (quote_span in the
  // bash hook): payload text stays live and raw, a guarded command word or an
  // option FRAGMENT stays visible (`"pkill" -f x`, `pkill "-"f x`), anything
  // else is data. A kept-visible word behaves like an unquoted one for
  // interpreter context and for bindings: `F='-f'` records the literal, a
  // masked `F='…'` records the opaque marker <v>.
  const classifyQuote = (inner: string, mode: "single" | "double") => {
    let tok = "<q>"
    const payload = isPayload()
    if (payload === "split") {
      out += " " + inner
    } else if (payload) {
      out += inner
    } else if (isGuardWord(inner) || isOptionToken(inner)) {
      out += inner
      tok = inner
      trackWord(inner)
      if (!segFirst) segFirst = inner
      const bind = lastTok.match(/^([A-Za-z_][A-Za-z0-9_]*)=$/)
      if (bind) vars.set(bind[1], inner)
    } else {
      if (mode === "double") maskDouble(inner)
      else out += "<q>"
      const bind = lastTok.match(/^([A-Za-z_][A-Za-z0-9_]*)=$/)
      if (bind) vars.set(bind[1], "<v>")
    }
    maskNext = false
    prevTok = lastTok
    lastTok = tok
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
    // ANSI-C quoting (`$'…'`): the `$` belongs to the quote (keep interpreter
    // context), and the escapes decode BEFORE argv — classify the decoded text
    // or `$'\146'` hides a real `f`. Locale quoting (`$"…"`) is a plain
    // double-quote span; the `$` is emitted so the quote branch sees the word.
    if (c === "$" && text[i + 1] === "'") {
      flush()
      out += "$"
      let j = i + 2
      while (j < text.length && text[j] !== "'") {
        if (text[j] === "\\") j++
        j++
      }
      classifyQuote(decodeAnsiC(text.slice(i + 2, j)), "single")
      i = j + 1
      continue
    }
    if (c === "$" && text[i + 1] === '"') {
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
      if (c === "`") {
        out += "`" + scanText(inner) + "`"
        maskNext = false
        prevTok = lastTok
        lastTok = "<sub>"
      } else {
        classifyQuote(inner, c === "'" ? "single" : "double")
      }
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
    if (c === "<" || c === ">") {
      if (text[i + 1] === "(") {
        // Process substitution EXECUTES its body: `<(pkill -f x)` runs
        // pkill even in a read-only-looking pipeline. Scan it like $(…).
        flush()
        const end = matchParen(text, i + 2)
        out += c + "(" + scanText(text.slice(i + 2, end)) + ")"
        maskNext = false
        prevTok = lastTok
        lastTok = "<sub>"
        i = end + 1
        continue
      }
      pending += c
      i++
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
// Statements split on `;`, `&`, `||`, `{`, `}` (command groups) and newlines;
// `|` separates pipeline segments inside a statement. The `&` in `2>&1` is a
// redirect, not a statement boundary. Braces inside ${…} expansions were
// consumed by the masker; any brace left in the masked text is a bare word.
function statementsOf(masked: string): string[] {
  return masked.replace(/([<>])&/g, "$1").replace(/\|\|/g, ";").split(/[;&\n{}]/)
}

function firstToken(seg: string): string {
  const m = seg.trim().match(/^\S+/)
  return m ? m[0] : ""
}

// A substitution of any kind ($(), backticks, process substitution) can hide
// an executed kill inside an inspector-looking pipeline.
function hidesSubstitution(seg: string): boolean {
  return seg.includes("$(") || seg.includes("`") || seg.includes("<(") || seg.includes(">(")
}

// A segment led by a read-only inspector carries the pattern as data, not as
// an operator. Command substitution or a kill inside it voids the exemption.
function isDataSegment(seg: string): boolean {
  if (!READONLY.has(firstToken(seg))) return false
  if (hidesSubstitution(seg)) return false
  return !KILL.test(seg)
}

// A pipeline is only dangerous when it reaches a kill-family sink (or a
// substitution). Inspector-to-inspector pipes (ps | grep | awk | wc …) are
// read-only; `pgrep -f foo | awk '{print $1}'` therefore passes, while
// `pgrep -f foo | awk '{print $1}' | xargs -r kill` does not.
function hasKillSink(stmt: string): boolean {
  return stmt.split("|").some((seg) => {
    if (!KILL.test(seg)) return false
    if (READONLY.has(firstToken(seg)) && !hidesSubstitution(seg)) return false
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
    const w = normalizeFlagWord(raw)
    if (w.startsWith("--")) {
      if (w.includes("=")) continue
      if (prefix !== null ? w.startsWith(`--${prefix}`) : w === `--${longName}`) return true
      continue
    }
    if (w.length > 1 && w.startsWith("-") && w.includes(letter)) return true
  }
  return false
}

// A flag survives quoting and escaping on its way to getopt (`pkill "-f"`,
// `pkill \-f`, `pkill $'-f'`, `pkill \"-f\"`). Normalize the token before
// classifying it or the guard goes blind on every one of those shapes.
function normalizeFlagWord(word: string): string {
  let w = word.replace(/\\/g, "")
  if (w.startsWith("$")) w = w.slice(1)
  if (w.length >= 2) {
    const q = w[0]
    if ((q === '"' || q === "'") && w[w.length - 1] === q) w = w.slice(1, -1)
  }
  return w
}

// Is a quoted span exactly one option FRAGMENT (`-f`, `--full`, `-9f`, but
// also bare `-` or a bare letter)? The shell strips the quotes and GLUES
// adjacent fragments into one argv word, so `pkill "-"f x` is a real `-f` and
// the mask must keep every fragment visible or hasFlag goes blind. Anything
// else (`=`, `|`, `;`, `&`, `$`, backticks, whitespace, non-ASCII) is unmasked
// operator text and would leak into the statement scanner as a phantom
// `pkill -f`. The accepted charset (an optional leading `-` plus a run of
// [A-Za-z0-9._+-], empty included) is wider than what getopt accepts (`-+f`
// errors out in pkill) — fail-safe on purpose, and mirrored exactly by
// m_opt_token in the bash hook.
function isOptionToken(inner: string): boolean {
  return /^-?[A-Za-z0-9._+-]*$/.test(inner)
}

// Is a quoted span exactly one command word the guard tracks (a kill-family
// name, interpreter, wrapper, git), or a path whose basename is one? Quoting
// argv[0] does not protect it: `"pkill" -f x` and `"/usr/bin/pkill" -f x` both
// exec pkill with -f, so the mask keeps these visible.
function isGuardWord(inner: string): boolean {
  if (!/^[A-Za-z0-9._/+-]+$/.test(inner)) return false
  return GUARD_WORDS.has(inner.replace(/^.*\//, ""))
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
// Shell block keywords are transparent: `then pkill -f x` executes pkill.
function atCommandPosition(words: Word[], i: number): boolean {
  if (words[i].fresh) return true // `$(pkill …)`, backtick, quote payload start
  for (let j = i - 1; j >= 0; j--) {
    const t = words[j].t
    // Wrapper/interpreter identity is the argv[0] basename: a path-qualified
    // `/usr/bin/sudo pkill -f x` still execs pkill through sudo.
    const tb = t.replace(/^.*\//, "")
    if (WRAPPERS.has(tb) || CODE_SHELLS.has(tb) || PAYLOAD_CMDS.has(tb)) return true
    if (SHELL_KEYWORDS.has(t)) return true
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

// The segment's argv is partly computed at runtime: a substitution, a process
// substitution, an unresolved/opaquely-assigned variable (<v>), or a raw
// `$name` fragment the guard never saw assigned. Flags arriving from any of
// those are invisible to hasFlag (`pkill $(cat /tmp/flags)`, `pkill $FLAGS`).
function computedArgv(seg: string): boolean {
  if (seg.includes("`") || seg.includes("<(") || seg.includes(">(") || seg.includes("<v>")) return true
  // `$((…))` is arithmetic — it yields a number, never a flag — so only a
  // `$(` NOT followed by another paren marks computed argv.
  return /\$\([^()]|\$[A-Za-z_{]/.test(seg)
}

// xargs feeding a kill-family command from a file (`xargs -a flags pkill`,
// `xargs pkill < flags`): the flags arrive as data the guard never sees.
// Pipeline-fed `… | xargs -r kill` is approach #3 and stays allowed — this
// fires only when xargs and the kill-family word share one segment AND a file
// feed flag (-a/--arg-file) or an input redirect is present.
function xargsFeeds(seg: string): boolean {
  if (!segHasInvocation(seg, (t) => t === "xargs" || t.endsWith("/xargs"))) return false
  return wordsOf(seg).some((w) => {
    const t = w.t
    if (t === "-a" || /^-a.+/.test(t) || t === "--arg-file" || /^--arg-file=/.test(t)) return true
    // `<`-led words that are not one of the guard's masks (`<q>`, `<v>`,
    // `<sub>`, `<msg-masked>`, `<heredoc-body>`, including glued forms like
    // `<q>f` from fragment masking) are input redirects.
    return t.startsWith("<") && !/^<(q>|v>|sub>|msg-masked>|heredoc-body>)/.test(t)
  })
}

// The command word itself is a substitution: `"$(which pkill)" -f x` execs
// whatever the substitution prints, with flags the guard cannot attribute to a
// program. Deny when such a segment carries a kill-style flag family.
function substLedFlag(stmt: string): boolean {
  return stmt.split("|").some((seg) => {
    const t = seg.replace(/^\s+/, "")
    if (t.startsWith("$((")) return false // arithmetic: yields a number, never a flag
    if (!(t.startsWith("$(") || t.startsWith("`") || t.startsWith("<(") || t.startsWith(">(")))
      return false
    return hasFlag(seg, "f", "f*") || hasFlag(seg, "r", "re*")
  })
}

// Any kill/killall INVOCATION in this statement (path-qualified forms count).
// Used for the cross-statement rule: after an earlier `pgrep -f pat`, the
// shell's own argv contains pat, so pgrep matched the shell — killing anything
// it listed (via a file, a substitution, xargs, …) kills the session.
function stmtKillInvocation(stmt: string): boolean {
  return stmt.split("|").some((s) =>
    segHasInvocation(s, (t) => {
      const tb = t.replace(/^.*\//, "")
      return tb === "kill" || tb === "killall"
    }),
  )
}

// scanFlag denies when the program runs with the flag — or with flags the
// guard cannot see (computed argv, xargs file feed), in which case the
// returned reason says so (SF_REASON in the bash hook). `undefined` = clear.
function scanFlag(
  stmt: string,
  prog: string,
  letter: string,
  longName: string,
): { reason?: string } | undefined {
  const wordTest = (t: string) => t === prog || t.endsWith(`/${prog}`)
  for (const s of segsWith(stmt, prog)) {
    if (isDataSegment(s)) continue
    if (!segHasInvocation(s, wordTest)) continue
    if (hasFlag(s, letter, longName)) return {}
    if (computedArgv(s))
      return {
        reason: `${prog} invoked with flags computed by a substitution or a variable the guard cannot resolve — the resulting argv is invisible to it.`,
      }
    if (xargsFeeds(s))
      return { reason: `xargs feeding ${prog}: the flags arrive from a data file the guard cannot see.` }
  }
  return undefined
}

// gateway.cgroup_cleanup (hermes) SIGKILLs every PID in the caller's own
// cgroup — it was designed to run only as ExecStopPost inside the gateway
// unit. The hermes-gateway-penetrate unit was retired 2026-09-28; the module
// must never be run manually and this rule stays as defense-in-depth.
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
// The shell still reads stdin behind flags that do not name a payload
// (`| bash -s`, `| bash --`, `| bash --norc`) and behind /dev/stdin as the
// "script". `-c` is excluded from the flag class on purpose: `| bash -c '…'`
// runs its argument, not stdin, and the payload is judged by the masking
// stage; `| bash -c` with no argument is a getopt error, not an execution.
const WRAPPER_ALT =
  "(sudo|doas|env|nice|nohup|time|timeout|stdbuf|setsid|command|builtin|exec|xargs|busybox|nsenter|setpriv|unshare|taskset|ionice|chrt|prlimit|numactl|strace|ltrace|setarch|watch|systemd-run)"
const STDIN_SHELL = new RegExp(
  "(^|[|;&\\n])\\s*(" +
    WRAPPER_ALT +
    "\\s+)*((ba|z|da|k)?sh)(\\s+(-[abd-zA-Z0-9]*|--[a-z-]*))*(\\s+(/dev/stdin|/dev/fd/[0-9]+))?\\s*($|[;&\\n])",
)
// `xargs -d/-i/-I … sh -c` (payload arriving as an xargs ARGUMENT): plain
// `xargs bash -c` only hands the first whitespace-split word to -c, but
// -d/-i/-I preserve whole lines, so `echo 'pkill -f x' | xargs -d '\n' bash -c`
// executes it. The payload word is absent (end) or the -I placeholder {}.
const XARGS_SH_C = new RegExp(
  "(^|[|;&\\n])\\s*((sudo|doas|env|nice|nohup|time|timeout|stdbuf|setsid|command|builtin|exec)\\s+)*xargs(\\s+[^\\s]+)*\\s+-[diI][^\\s]*((\\s+[^\\s]+)*\\s+)((ba|z|da|k)?sh)(\\s+-[^\\s]+)*\\s+-c(\\s+\\{\\})?\\s*($|[;&\\n])",
)
// Text executed through a pipe is decoded by printf/$''-style escapes first:
// `printf '\x70kill -f x\n' | bash` contains no literal kill word yet runs it.
// When a stdin-shell (or xargs -c) shape is present, any hex/unicode/octal
// escape upstream is unverifiable — deny. \n, \t, \\ and sed-style \1 stay
// allowed (they cannot spell a command letter).
const ESCAPED_RE = /\\(x[0-9A-Fa-f]|u[0-9A-Fa-f]|U[0-9A-Fa-f]|0[0-7]|[1-7][0-7][0-7])/
const KILLWORD = /(^|[^A-Za-z0-9_])(kill|killall|pkill|pgrep|cgroup_cleanup)([^A-Za-z0-9_]|$)/

function pipesToStdinShell(cmd: string): boolean {
  return STDIN_SHELL.test(cmd) || XARGS_SH_C.test(cmd)
}

// A compound statement's own denial (stmt_denied in the bash hook).
function stmtDenied(stmt: string): string | undefined {
  if (reapsOwnCgroup(stmt)) {
    return "gateway.cgroup_cleanup SIGKILLs every PID in the caller's own cgroup — from an agent shell that is the agent's own process tree. The hermes-gateway unit it served as ExecStopPost was retired 2026-09-28; the module must never be run manually. This rule stays as defense-in-depth."
  }
  // getopt_long runs any unique prefix of a long option: `--f` IS `--full`
  // (pkill/pgrep have no other --f* option). `--full=v` is not: it is an
  // argument to a no-argument option and dies in getopt_long (see hasFlag).
  const pkillHit = scanFlag(stmt, "pkill", "f", "f*")
  if (pkillHit)
    return (
      pkillHit.reason ??
      "pkill -f matches the full cmdline of every process, including the shell running this very command."
    )
  const pgrepHit = scanFlag(stmt, "pgrep", "f", "f*")
  if (pgrepHit && hasKillSink(stmt))
    return (
      pgrepHit.reason ??
      "pgrep -f combined with kill on the same command line: the pattern still sits in the killing shell's argv."
    )
  // psmisc killall's long option is --regexp, and getopt_long accepts any
  // unique prefix (--re, --rege, --regex, --regexp all run): match the
  // whole --re* family, not a single spelling.
  const killallHit = scanFlag(stmt, "killall", "r", "re*")
  if (killallHit)
    return (
      killallHit.reason ??
      "killall -r/--regexp matches by regex from inside a cmdline that contains the same text."
    )
  if (substLedFlag(stmt)) {
    return "the command word is a substitution: its result executes with flags the guard cannot attribute to a program ($(…) -f x could be pkill)."
  }
  if (PS.test(stmt) && PIPE_GREP.test(stmt) && hasKillSink(stmt) && !GREP_FROM_FILE.test(stmt)) {
    return "ps | grep <literal> | kill: grep matches itself and the wrapping shell's argv."
  }
  return undefined
}

function inspect(cmd: string): string | undefined {
  vars = new Map()
  // Cheap reject-first: no kill-family word, no ANSI-C/hex escape channel and
  // no pipe-into-shell shape means no rule can fire — skip the (quadratic)
  // masking stage for it. The escape/pipe triggers stay because printf-style
  // decoding and `| bash` can produce kill words at runtime that the raw text
  // does not contain.
  if (!/kill|pgrep|cgroup_cleanup|\$'|\\x|\\0/.test(cmd) && !pipesToStdinShell(cmd)) return undefined
  if (pipesToStdinShell(cmd)) {
    if (KILLWORD.test(cmd)) {
      return "piping text into a shell runs it: the kill pattern inside that text would execute in the very shell being piped to."
    }
    if (ESCAPED_RE.test(cmd)) {
      return "piping text into a shell runs it, and the text carries hex/octal/unicode escapes that only decode at runtime (printf, $'…') — the guard cannot verify what command they spell."
    }
  }
  const masked = scanText(maskHeredocs(cmd))
  // Size gate AFTER heredoc masking: documented approach #6 (write the script
  // to a file) collapses to <heredoc-body> lines and stays scannable, while a
  // giant one-liner is denied rather than scanned for minutes.
  if (masked.length > 16384) {
    return "command is too large for the kill-guard's masking stage (>16384 bytes after heredoc masking; the scan is quadratic). Write the script to a file and run the file (approach #6), or split the command."
  }
  let pgrepfSeen = false
  for (const stmt of statementsOf(masked)) {
    if (stmt.trim() === "") continue
    // Cross-statement: an earlier pgrep -f already matched THIS shell (its
    // argv holds the whole compound text), so a later kill of those results
    // kills the session — `pgrep -f foo > f; kill $(cat f)`.
    if (pgrepfSeen && stmtKillInvocation(stmt)) {
      return "an earlier pgrep -f in this compound command matched the shell itself (its argv contains the pattern); killing anything it listed kills the session."
    }
    const denied = stmtDenied(stmt)
    if (denied) return denied
    if (scanFlag(stmt, "pgrep", "f", "f*")) pgrepfSeen = true
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
