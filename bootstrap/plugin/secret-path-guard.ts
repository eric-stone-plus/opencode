import type { Plugin } from "@opencode/plugin"

// Secret-path guard (2026-10-06, ported to OpenCode V2 2026-10-12): the keys stay in $HOME by
// operator decision, so the mechanical closure is "agent tools never touch credential stores".
// Permission rules alone cannot express this: `read` matches the resolved path, but `glob` and
// `grep` permission resources are the QUERY string, not the search path. A path-aware
// `execute.before` hook is the only layer that sees every tool's arguments.
//
// Accident-shaped, like block-unsafe-kill: a deliberate bypass is the same class the kill-guard
// declares out of scope.
//
// File tools (read, write, edit, patch, glob, grep) are checked against every rule below. The
// shell tool is checked only against the rules marked `both` or `shell`, which cover the V2
// credential store: it keeps credentials in SQLite (`credential` table of opencode-main.db) next
// to every session transcript, and its API password sits in the service registration file.
// The older credential files (auth.json, env files, ssh keys, ...) stay file-tool-only on
// purpose: the global key-hygiene rule allows a field-targeted shell filter for them
// (`cut -d= -f1 env`), and `cp .env.example .env` is everyday project work.
//
// Shell limits. This is a pattern matcher over statements, not a shell. It denies a command only
// when the command word can print or copy file content (cat, strings, sqlite3, cp, curl, grep,
// python -c, ...) and an operand names a store; it also denies `opencode auth export` and
// `opencode service get password`. Mentions are data: ls, stat, du, sha256sum, git commit -m,
// echo, a heredoc written by cat, and a script FILE run by an interpreter are untouched.
// Not covered: a script written to disk and run later, a path assembled from variables or
// `$(...)`, ANSI-C escapes ($'\x2e'), symlinks and renamed copies, `cd` into the data directory
// followed by a custom database name, a custom OPENCODE_DB name outside `.../share/opencode/`,
// and tar/rsync of the whole data directory. Any file named opencode.db or opencode-<x>.db is
// denied wherever it lives, test fixtures included: inspect those from a script file or the API.
//
// Runtime imports: none. The file also loads standalone in script/secret-path-guard.test.ts.

type Where = "files" | "both" | "shell"
type Rule = { readonly re: RegExp; readonly why: string; readonly hint?: string; readonly where?: Where }

const FIELD_HINT =
  "Read credential files by field-targeted filters only when the task truly needs a non-secret field, and never print values."
const DATABASE_HINT =
  "Never read the database file: use `opencode session list`, `opencode stats` or `opencode auth list` instead."
const SERVICE_HINT = "Check the service with `opencode service status`; never print its password."

const DENY: readonly Rule[] = [
  { re: /(^|\/)agent-secrets(\/|$)/, why: "credential store (agent-secrets/)" },
  { re: /\.claude\/\.api-token$/, why: "Claude API token" },
  { re: /\.claude\/\.credentials/, why: "Claude credentials store" },
  { re: /(^|\/)auth\.json$/, why: "provider auth store (auth.json)" },
  { re: /(^|\/)\.npmrc$/, why: "npm auth token (.npmrc)" },
  { re: /\.smbcredentials/, why: "SMB credentials" },
  { re: /(^|\/)\.jwt_tool(\/|$)/, why: "jwt_tool private keys" },
  { re: /(^|\/)\.grok(\/|$)/, why: "grok credentials dir" },
  { re: /(^|\/)\.grokbot(\/|$)/, why: "grokbot daemon credentials dir" },
  { re: /(^|\/)Grok Bot(\/|$)/, why: "Grok Bot secrets dir" },
  { re: /LarkShell\/(logout_token|sdk_storage(\/|$))/, why: "LarkShell tokens / client state" },
  { re: /causeway\/secrets(\/|$)/, why: "causeway secrets" },
  { re: /firecrawl-cli\/credentials\.json$/, why: "firecrawl credentials" },
  { re: /\.config\/opencode\/env$/, why: "provider API key env" },
  { re: /\.config\/claude-env$/, why: "Anthropic auth token env" },
  // environment.d drop-ins carry provider keys as often as not — the seat's own 95-*.conf
  // template shipped mode 0600 for exactly that reason, and motoko-keys.conf holds live keys —
  // while the DB pin and the IME files beside them hold nothing secret. The directory is denied
  // whole (the shape of a key-bearing drop-in is not distinguishable by name, and a grep aimed at
  // the directory would print every one of them), and a legitimate non-secret field is still
  // reachable through a field-targeted shell filter.
  {
    re: /(^|\/)\.config\/environment\.d(\/|$)/,
    why: "environment.d drop-in (may hold provider keys)",
    hint: FIELD_HINT,
  },
  { re: /(^|\/)\.ssh(\/|$)/, why: "SSH key material" },
  { re: /(^|\/)\.gnupg(\/|$)/, why: "GPG private material" },
  { re: /\.aws\/(credentials|config)$/, why: "AWS credentials" },
  { re: /\.docker\/config\.json$/, why: "registry auth tokens" },
  { re: /(^|\/)\.git-credentials$/, why: "git credentials" },
  { re: /(^|\/)\.netrc$/, why: "netrc credentials" },
  { re: /\.config\/gcloud(\/|$)/, why: "gcloud application-default credentials" },
  { re: /(^|\/)credentials\.json$/, why: "credentials store (credentials.json)" },
  { re: /(^|\/)[^/]*\.env$/, why: "env file (may hold secrets)" },
  // `.env.example` is the documented template and stays readable; other
  // `.env.<suffix>` variants (`.env.local`, …) may hold real secrets.
  { re: /(^|\/)(?![^/]*\.env\.example$)[^/]*\.env\.[^/]+$/, why: "env file (may hold secrets)" },
  { re: /\.pem$/, why: "PEM key material" },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, why: "SSH private key" },
  { re: /(^|\/)agent-secrets\.env$/, why: "credential env file" },
  // V2 default database names: opencode.db and opencode-<channel>.db (this fork pins opencode-main.db),
  // with -wal/-shm/-journal sidecars and backup suffixes. The second rule is any database file
  // inside the data directory, whatever OPENCODE_DB called it.
  {
    re: /(^|\/)opencode(-[\w.-]+?)?\.db(?!\w)/,
    why: "OpenCode database (credentials and every session transcript)",
    hint: DATABASE_HINT,
    where: "both",
  },
  {
    re: /(^|\/)share\/opencode\/(?:[^/]+\/)*[^/]+\.db(?!\w)/,
    why: "OpenCode database (credentials and every session transcript)",
    hint: DATABASE_HINT,
    where: "both",
  },
  // The registration (state dir) and service config (config dir) hold the API password, and that
  // API lists every stored credential.
  {
    re: /(^|\/)opencode\/service(?:-[\w.-]+)?\.json(?!\w)/,
    why: "OpenCode service registration (holds the API password)",
    hint: SERVICE_HINT,
    where: "both",
  },
  // GET /api/credential lists every credential including its secret value.
  {
    re: /(^|\/)api\/credential\/?(\?.*)?$/,
    why: "the credential listing endpoint (returns every secret value)",
    hint: DATABASE_HINT,
    where: "shell",
  },
]

const FILE_RULES = DENY.filter((rule) => rule.where !== "shell")
const SHELL_RULES = DENY.filter((rule) => rule.where === "both" || rule.where === "shell")

// Arguments whose values are paths or path-shaped queries (glob `pattern`, grep `include`).
// Query-shaped values only match the deny list when they look like the artifact itself (e.g.
// `*.pem`, `**/auth.json`). A grep `pattern` is searched TEXT, never a path: V1 denied a content
// search for the string "auth.json", which is a legitimate question about the code.
const PATH_KEYS = new Set(["filePath", "filepath", "file_path", "path", "dir", "directory", "pattern", "include"])
const TEXT_KEYS: Record<string, string> = { grep: "pattern" }

// `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` name every path a patch touches.
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): *(.+?)\s*$/gm

// Commands that can print or copy file content, or ship it somewhere. Anything else is left alone.
const READERS = new Set([
  ...["cat", "tac", "head", "tail", "less", "more", "most", "nl", "od", "xxd", "hexdump", "hd", "strings", "file"],
  ...["base64", "base32", "basenc", "bat", "batcat", "view", "vi", "vim", "nvim", "nano", "emacs", "ed", "ex"],
  ...["sed", "awk", "gawk", "mawk", "cut", "paste", "sort", "uniq", "tr", "fold", "fmt", "column", "rev"],
  ...["comm", "diff", "cmp", "sdiff", "grep", "egrep", "fgrep", "rgrep", "zgrep", "rg", "ag", "ack", "jq", "yq", "xq"],
  ...["cp", "install", "ln", "rsync", "scp", "sftp", "dd", "tee", "tar", "zip", "7z", "7za", "gzip", "bzip2", "xz"],
  ...["zstd", "curl", "wget", "nc", "ncat", "socat", "sqlite3", "litecli", "duckdb", "sqlite-utils"],
])
// Their first bare operand is a pattern or script, not a file (`grep opencode-main.db docs/`).
const SCRIPT_FIRST = new Set(
  ["grep", "egrep", "fgrep", "rgrep", "zgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "mawk", "jq", "yq", "xq"],
)
// Run inline code (or stdin) that can open a file by itself. `python script.py db` is a script
// FILE: its arguments are the script's business and stay out of reach of a pattern matcher.
const INTERPRETERS = new Set([
  ...["python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "bun", "deno", "perl", "ruby", "php"],
  ...["lua", "tclsh", "Rscript", "julia"],
])
const INLINE_FLAGS = new Set(["-c", "-e", "-E", "-p", "-r", "-m", "--eval", "--print", "--command"])
const SQL_CLIENTS = new Set(["sqlite3", "litecli", "duckdb", "sqlite-utils"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const WRAPPERS = new Set([
  ...["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "xargs", "command", "exec", "stdbuf", "setsid"],
  ...["ionice", "taskset", "watch", "busybox", "builtin"],
])
const MAX_DEPTH = 3

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPER_ARG = /^(-|\d+$|\{\}$)/
// Words are split further on these before they are matched against a store path, so a path
// inside `file:...?mode=ro`, `if=...`, `"$(echo path)"` or SQL text is still found.
const SPLIT = /[\s'"`()=,:;<>|&{}[\]@]+/
const DATA_DIR = /(^|\/)(?:\.local\/share|\$\{?XDG_DATA_HOME\}?)\/opencode$/
const STORE_NAMES = ["opencode.db", "opencode-main.db", "opencode.db-wal", "opencode-main.db-wal"]
// Only worth tokenizing when a shell-scoped rule or the CLI check could possibly fire.
const SHELL_HINT = /opencode|service|credential/
const FD_TARGET = /^(\d+-?|-)$/

// Tokens: (1) redirections, (2) statement operators, (3) words made of plain characters, escapes and quoted spans.
const TOKEN = new RegExp(
  [
    String.raw`(<<<|<<-?|>>|>\||&>>?|[<>]&?)`,
    String.raw`(\|\||&&|\|&|[;|&\n()` + "`" + String.raw`])`,
    String.raw`((?:\\[\s\S]|\$'(?:\\[\s\S]|[^'\\])*'|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s;|&()<>` +
      "`" +
      String.raw`'"\\])+)`,
  ].join("|"),
  "g",
)
const QUOTED = /\$'((?:\\[\s\S]|[^'\\])*)'|'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/g
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g

type Denial = { readonly why: string; readonly hint: string; readonly shown: string }
type Statement = {
  readonly words: string[]
  readonly reads: string[]
  readonly writes: string[]
  readonly heredocs: string[]
  readonly nested: string[]
}

const isString = (value: unknown): value is string => typeof value === "string"
const base = (word: string) => word.replace(/^.*\//, "")

function denied(value: string, rules: readonly Rule[]) {
  // Normalize to slash form so both `home/eric/...` (slash-less absolute) and
  // real absolute paths hit the same patterns; strip trailing slashes.
  const flat = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return rules.find((rule) => rule.re.test(flat))
}

function fileDenial(tool: string, input: Record<string, unknown>) {
  const values = Object.entries(input)
    .filter(([key]) => PATH_KEYS.has(key) && TEXT_KEYS[tool] !== key)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).filter(isString).map((item) => [key, item] as const),
    )
  const patched =
    tool === "patch" && isString(input.patchText)
      ? [...input.patchText.matchAll(PATCH_PATH)].map((match) => ["patchText", match[1]] as const)
      : []
  return [...values, ...patched].flatMap(([key, value]) => {
    const rule = value.length > 0 ? denied(value, FILE_RULES) : undefined
    return rule ? [{ key, rule }] : []
  })[0]
}

function unquote(raw: string, nested: string[]) {
  return raw.replace(QUOTED, (_, ansi?: string, single?: string, double?: string, escaped?: string) => {
    if (ansi !== undefined) return ansi
    if (single !== undefined) return single
    if (double === undefined) return escaped === "\n" ? "" : (escaped ?? "")
    // A double-quoted span is data, but `$(…)` and backticks inside it still run.
    for (const match of double.matchAll(SUBSTITUTION)) nested.push(match[1] ?? match[2] ?? "")
    return double.replace(/\\([\s\S])/g, "$1")
  })
}

function parse(command: string) {
  const re = new RegExp(TOKEN.source, "g")
  const statements: Statement[] = []
  const open = () => {
    const statement: Statement = { words: [], reads: [], writes: [], heredocs: [], nested: [] }
    statements.push(statement)
    return statement
  }
  const state = {
    current: open(),
    redirect: "",
    pending: [] as Array<{ delimiter: string; strip: boolean; into: string[] }>,
  }
  while (true) {
    const match = re.exec(command)
    if (!match) break
    const [, redirect, operator, raw] = match
    if (redirect) {
      state.redirect = redirect
      continue
    }
    if (operator) {
      state.redirect = ""
      state.current = open()
      if (operator === "\n" && state.pending.length > 0) {
        // Heredoc bodies start on the next line and end at the delimiter line; skip past them.
        const cursor = { at: re.lastIndex }
        for (const doc of state.pending.splice(0)) {
          const lines: string[] = []
          while (cursor.at < command.length) {
            const end = command.indexOf("\n", cursor.at)
            const stop = end === -1 ? command.length : end
            const line = command.slice(cursor.at, stop)
            cursor.at = stop + 1
            if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break
            lines.push(line)
          }
          doc.into.push(lines.join("\n"))
        }
        re.lastIndex = cursor.at
      }
      continue
    }
    const word = unquote(raw, state.current.nested)
    const kind = state.redirect
    state.redirect = ""
    if (kind === "<<" || kind === "<<-")
      state.pending.push({ delimiter: word, strip: kind === "<<-", into: state.current.heredocs })
    else if (kind === "<<<") state.current.heredocs.push(word)
    else if (kind.endsWith("&") && FD_TARGET.test(word)) continue
    else if (kind.startsWith("<")) state.current.reads.push(word)
    else if (kind) state.current.writes.push(word)
    else state.current.words.push(word)
  }
  return statements
}

// Index of the word that names the program: past assignments and wrappers (`sudo`, `timeout 5`, `xargs -n1`).
function commandIndex(words: string[], from = 0): number {
  const word = words[from]
  if (word === undefined) return -1
  if (ASSIGNMENT.test(word)) return commandIndex(words, from + 1)
  if (!WRAPPERS.has(base(word))) return from
  const next = words.findIndex((item, index) => index > from && !WRAPPER_ARG.test(item))
  return next === -1 ? -1 : commandIndex(words, next)
}

// `args` minus the pattern or script operand of grep/sed/awk/jq-style readers.
function dropPattern(args: string[]) {
  const flagged = args.findIndex((word) => ["-e", "--regexp", "-f", "--file"].includes(word))
  const skip = flagged === -1 ? args.findIndex((word) => !word.startsWith("-")) : flagged + 1
  return args.filter((_, index) => index !== skip)
}

// A glob in the data directory (`~/.local/share/opencode/*`) expands to the database.
function globHit(token: string) {
  const slash = token.lastIndexOf("/")
  const name = token.slice(slash + 1)
  if (slash === -1 || !/[*?[]/.test(name) || !DATA_DIR.test(token.slice(0, slash).replace(/\/+$/, ""))) return false
  return STORE_NAMES.some((store) => new Bun.Glob(name).match(store))
}

function operandDenial(word: string): Denial | undefined {
  const tokens = [word, ...word.split(SPLIT)].filter((token) => token.length > 0)
  return tokens.flatMap((token) => {
    const rule = denied(token, SHELL_RULES) ?? (globHit(token) ? SHELL_RULES[0] : undefined)
    return rule ? [{ why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: token }] : []
  })[0]
}

// opencode subcommands that print secrets. Matched on whole words, so a commit message that
// mentions them stays data.
function cliDenial(args: string[]): Denial | undefined {
  const plain = args.filter((word) => !word.startsWith("-"))
  const line = plain.join(" ")
  if (/(^| )auth export( |$)/.test(line))
    return { why: "`opencode auth export` (prints every stored credential value)", hint: "List logins with `opencode auth list`.", shown: "auth export" }
  if (/(^| )service get password( |$)/.test(line))
    return { why: "`opencode service get password`", hint: SERVICE_HINT, shown: "service get password" }
  if (plain.includes("api") && plain.some((word) => word === "credential.list" || denied(word, SHELL_RULES)))
    return { why: "the credential listing endpoint (returns every secret value)", hint: DATABASE_HINT, shown: "api credential" }
  return undefined
}

// `bash -c '…'`, `bash -lc '…'`, `sudo bash --norc -c '…'` and `eval …` run their payload as a command line.
function shellPayload(args: string[], name: string) {
  if (name === "eval") return args.join(" ")
  if (!SHELLS.has(name)) return undefined
  const flag = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
  return flag === -1 ? undefined : args[flag + 1]
}

function shellDenial(command: string, depth = 0): Denial | undefined {
  if (depth > MAX_DEPTH || !SHELL_HINT.test(command)) return undefined
  const first = (words: string[]) => words.map(operandDenial).find((denial) => denial)
  return parse(command)
    .map((statement): Denial | undefined => {
      const at = commandIndex(statement.words)
      const name = at === -1 ? "" : base(statement.words[at])
      const args = at === -1 ? [] : statement.words.slice(at + 1)
      const redirected = first([...statement.reads, ...statement.writes])
      if (redirected) return redirected
      if (name === "opencode") return cliDenial(args)
      const inline = args.some((word) => INLINE_FLAGS.has(word))
      const reading = READERS.has(name) ? (SCRIPT_FIRST.has(name) ? dropPattern(args) : args) : []
      const scripted = INTERPRETERS.has(name) && inline ? args : []
      const operandHit = first([...reading, ...scripted])
      if (operandHit) return operandHit
      // A heredoc or here-string fed to a runner is code, SQL or a command line; fed to cat it is just text.
      const runs = SHELLS.has(name)
      const code = runs || INTERPRETERS.has(name) || SQL_CLIENTS.has(name) ? statement.heredocs : []
      const payload = shellPayload(args, name)
      const nested = [...statement.nested, ...(runs ? code : []), ...(payload ? [payload] : [])]
      return (
        nested.map((text) => shellDenial(text, depth + 1)).find((denial) => denial) ??
        (runs ? undefined : first(code))
      )
    })
    .find((denial) => denial)
}

function inspect(tool: string, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const args = input as Record<string, unknown>
  if (tool === "shell" || tool === "bash") {
    const denial = isString(args.command) ? shellDenial(args.command) : undefined
    return denial ? `refusing to run a command that touches ${denial.why} (${denial.shown}). ${denial.hint}` : undefined
  }
  const hit = fileDenial(tool, args)
  return hit ? `refusing to use ${hit.key} inside ${hit.rule.why}. ${hit.rule.hint ?? FIELD_HINT}` : undefined
}

export default {
  id: "secret-path-guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      const reason = inspect(event.tool, event.input)
      if (reason) throw new Error(`Blocked: ${reason}`)
    })
  },
} satisfies Plugin.Plugin
