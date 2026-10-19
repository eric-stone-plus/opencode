import type { Plugin } from "@opencode/plugin"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"

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
// `opencode service get password`, `opencode session ...` and `opencode run --session/--continue`
// (session isolation). Mentions are data: ls, stat, du, sha256sum, git commit -m,
// echo, a heredoc written by cat, and a script FILE run by an interpreter are untouched.
// Not covered: a script written to disk and run later, a path assembled from variables or
// `$(...)`, ANSI-C escapes ($'\x2e'), symlinks and renamed copies, `cd` into the data directory
// followed by a custom database name, a custom OPENCODE_DB name outside `.../share/opencode/`,
// and tar/rsync of the whole data directory. Any file named opencode.db or opencode-<x>.db is
// denied wherever it lives, test fixtures included: inspect those from a script file or the API.
//
// Runtime imports: node:os/node:path/node:fs only (data-dir resolution, path
// normalization, symlinked-workdir resolution). The file also loads standalone
// in script/secret-path-guard.test.ts.

type Where = "files" | "both" | "shell"
type Rule = { readonly re: RegExp; readonly why: string; readonly hint?: string; readonly where?: Where }

// The data directory is `${XDG_DATA_HOME:-~/.local/share}/opencode` (see
// packages/util/src/global-roots.ts). Resolve the actual value at load so a
// relocated store is still protected, not only the default Linux path.
const DATA_HOME = resolve(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local/share"))
const DATA_ROOT = join(DATA_HOME, "opencode")
const DEFAULT_DATA_ROOT = join(homedir(), ".local/share", "opencode")
// The state dir holds the service registration (API password); the config dir
// holds the provider env file. A recursive search rooted at an ancestor of
// either reads them even when no operand spells the path.
const STATE_HOME = resolve(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local/state"))
const STATE_ROOT = join(STATE_HOME, "opencode")
const DEFAULT_STATE_ROOT = join(homedir(), ".local/state", "opencode")
const CONFIG_HOME = resolve(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"))
// The host resolves the config dir as OPENCODE_CONFIG_DIR ?? (XDG_CONFIG_HOME
// ?? ~/.config)/opencode; a relocated dir must not hide the env file.
const CONFIG_ROOT = resolve(process.env.OPENCODE_CONFIG_DIR?.trim() || join(CONFIG_HOME, "opencode"))
const DEFAULT_CONFIG_ROOT = join(homedir(), ".config", "opencode")
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32"
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const FIELD_HINT =
  "Read credential files by field-targeted filters only when the task truly needs a non-secret field, and never print values."
const DATABASE_HINT =
  "Never read the database file: use `opencode auth list` or `opencode stats` for aggregate metadata; ask the operator for anything else."
const SERVICE_HINT = "Check the service with `opencode service status`; never print its password."

const dataDirRule: Rule | undefined =
  DATA_ROOT === DEFAULT_DATA_ROOT
    ? undefined
    : {
        // Strip the leading slash before embedding: `(^|/)` already supplies a
        // separator, and with the absolute root kept the relative spelling
        // (`../../tmp/x/opencode`) and the slash-less absolute (`tmp/x/opencode`)
        // never matched.
        re: new RegExp(`(^|/)${escapeRegExp(DATA_ROOT.replace(/\\/g, "/").replace(/^\/+/, ""))}(/|$)`),
        why: "OpenCode data directory (session transcripts, logs, goals, tool output)",
        hint: "Use the operator's terminal; do not read OpenCode data files from the agent.",
        where: "both",
      }

const stateDirRule: Rule | undefined =
  STATE_ROOT === DEFAULT_STATE_ROOT
    ? undefined
    : {
        re: new RegExp(`(^|/)${escapeRegExp(STATE_ROOT.replace(/\\/g, "/").replace(/^\/+/, ""))}$`),
        why: "OpenCode state directory (service registration/API password)",
        hint: SERVICE_HINT,
        where: "shell",
      }

const configDirRule: Rule | undefined =
  CONFIG_ROOT === DEFAULT_CONFIG_ROOT
    ? undefined
    : {
        re: new RegExp(`(^|/)${escapeRegExp(CONFIG_ROOT.replace(/\\/g, "/").replace(/^\/+/, ""))}$`),
        why: "OpenCode config directory (provider env)",
        hint: FIELD_HINT,
        where: "shell",
      }

// The default env rule is anchored to `~/.config/opencode/env`; a relocated
// XDG_CONFIG_HOME puts the same provider keys at `<CONFIG_ROOT>/env`. The
// directory rule above is shell-only and matches the directory itself, so
// without this rule the file tools would reach the relocated env file. Like
// the default env rule this stays file-only: the shell may use a
// field-targeted filter (`cat … | cut -d= -f1`), and `where: "both"` here
// would make the relocated store stricter than the default one.
const configEnvRule: Rule | undefined =
  CONFIG_ROOT === DEFAULT_CONFIG_ROOT
    ? undefined
    : {
        re: new RegExp(`(^|/)${escapeRegExp(CONFIG_ROOT.replace(/\\/g, "/").replace(/^\/+/, ""))}/env$`),
        why: "provider API key env",
        hint: FIELD_HINT,
      }

const DENY: readonly Rule[] = [
  ...(dataDirRule === undefined ? [] : [dataDirRule]),
  ...(stateDirRule === undefined ? [] : [stateDirRule]),
  ...(configDirRule === undefined ? [] : [configDirRule]),
  ...(configEnvRule === undefined ? [] : [configEnvRule]),
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
  // A kubeconfig is a cluster credential; both the file tools and the shell
  // must not read it (unlike `.ssh`, which the shell may need for git/ssh).
  { re: /(^|\/)\.kube(\/|$)/, why: "Kubernetes credentials", hint: FIELD_HINT, where: "both" },
  { re: /\.aws\/(credentials|config)$/, why: "AWS credentials" },
  { re: /\.docker\/config\.json$/, why: "registry auth tokens" },
  { re: /(^|\/)\.git-credentials$/, why: "git credentials" },
  // A hook or config write persists code execution/fsmonitor settings that
  // never appear in the reviewed diff; the automatic gate also stops on such
  // edits, and this is the independent second layer.
  {
    re: /(^|\/)\.git\/(config|hooks)(\/|$)/,
    why: "git metadata (hooks/config can execute code)",
    hint: "Ask the operator to change git hooks or config.",
    where: "both",
  },
  // A bare `.git` file is a linked-worktree/submodule gitdir pointer; a shell
  // write redirects the probe to another repository's metadata.
  {
    re: /(^|\/)\.git$/,
    why: "git metadata (gitdir pointer)",
    hint: "Ask the operator to change git metadata.",
    where: "both",
  },
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
  // The data directory is the session store: the database, logs, goals, tool
  // output and session diffs all live here. The database and service rules
  // above keep their specific hints; this broad rule catches the rest so an
  // agent cannot read another session through a log, goal, or tool-output file.
  // Anchored to the default store: a project path like `src/share/opencode/...`
  // is not the data directory, and a relocated XDG root has its own rule above.
  {
    re: /(^|\/)\.local\/share\/opencode(\/|$)/,
    why: "OpenCode data directory (session transcripts, logs, goals, tool output)",
    hint: "Use the operator's terminal; do not read OpenCode data files from the agent.",
    where: "both",
  },
  // The state dir holds the service registration (API password); the config
  // dir holds the provider env file. A recursive shell search rooted at either
  // (or at an ancestor) reads them even when no operand spells the file, so
  // deny the directories to the shell. The file tools may still read the
  // non-secret seat files; the env and service files have their own file rules.
  {
    re: /(^|\/)\.local\/state\/opencode$/,
    why: "OpenCode state directory (service registration/API password)",
    hint: SERVICE_HINT,
    where: "shell",
  },
  {
    re: /(^|\/)\.config\/opencode$/,
    why: "OpenCode config directory (provider env)",
    hint: FIELD_HINT,
    where: "shell",
  },
  // GET /api/credential lists every credential including its secret value.
  {
    re: /(^|\/)api\/credential\/?(\?.*)?$/,
    why: "the credential listing endpoint (returns every secret value)",
    hint: DATABASE_HINT,
    where: "shell",
  },
]

// On macOS/Windows a path spelled `.SSH`/`.LOCAL` opens the same file as the
// lowercase form; a case-sensitive rule would miss it. Fold every rule: a
// differently-cased credential directory on Linux is denied too, which is the
// conservative direction for an accident-shaped guard.
const DENY_FOLDED: readonly Rule[] = DENY.map((rule) =>
  rule.re.flags.includes("i") ? rule : { ...rule, re: new RegExp(rule.re.source, `${rule.re.flags}i`) },
)
const FILE_RULES = DENY_FOLDED.filter((rule) => rule.where !== "shell")
const SHELL_RULES = DENY_FOLDED.filter((rule) => rule.where === "both" || rule.where === "shell")
// The rule a glob that can expand into the store is denied under.
const DATA_RULE = DENY_FOLDED.find((rule) => rule.why.startsWith("OpenCode data directory"))
const STATE_RULE = DENY_FOLDED.find((rule) => rule.why.startsWith("OpenCode state directory"))
const CONFIG_RULE = DENY_FOLDED.find((rule) => rule.why.startsWith("OpenCode config directory"))

// Credential directories that a recursive file read (git diff --no-index,
// grep -r) must not reach through an ancestor operand.
const PROTECTED_DIRS = [
  join(homedir(), ".ssh"),
  join(homedir(), ".gnupg"),
  join(homedir(), ".aws"),
  join(homedir(), ".docker"),
  join(homedir(), ".kube"),
  join(homedir(), ".config", "gcloud"),
  // Credential stores whose DENY rules are file-only, so they are absent from
  // SHELL_RULES; a recursive read or a workdir rooted here still reaches them.
  join(homedir(), ".claude"),
  join(homedir(), ".jwt_tool"),
  join(homedir(), ".grok"),
  join(homedir(), ".grokbot"),
  join(homedir(), ".config", "environment.d"),
]

// The rule for a credential directory, for checks that only have the path (a
// workdir, a recursive search root, a `--no-index` operand).
function credentialDirRule(dir: string): Rule {
  return denied(dir, DENY_FOLDED) ?? { re: /^$/, why: "credential directory", hint: FIELD_HINT, where: "both" }
}

// Every store root with the rule it is denied under. Checked for both the
// runtime and default locations: a relocated XDG root must not hide the
// default one, and a glob/recursive read must not skip the state/config dirs.
const STORE_ROOTS: ReadonlyArray<readonly [string, Rule | undefined]> = [
  [DATA_ROOT, DATA_RULE],
  [DEFAULT_DATA_ROOT, DATA_RULE],
  [STATE_ROOT, STATE_RULE],
  [DEFAULT_STATE_ROOT, STATE_RULE],
  [CONFIG_ROOT, CONFIG_RULE],
  [DEFAULT_CONFIG_ROOT, CONFIG_RULE],
]

// Arguments whose values are paths or path-shaped queries (glob `pattern`, grep `include`).
// Query-shaped values only match the deny list when they look like the artifact itself (e.g.
// `*.pem`, `**/auth.json`). A grep `pattern` is searched TEXT, never a path: V1 denied a content
// search for the string "auth.json", which is a legitimate question about the code.
const PATH_KEYS = new Set(["filePath", "filepath", "file_path", "path", "dir", "directory", "pattern", "include", "repo", "backgroundFile"])
const TEXT_KEYS: Record<string, string> = { grep: "pattern" }

// `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` name every path a patch
// touches; the unified-diff form (`--- a/`, `+++ b/`) covers apply_patch/patch text too. The host
// patch parser trims each hunk header, so a leading space or tab must not hide it.
const PATCH_PATH =
  /^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): *(.+?)\s*$|^(?:\+\+\+ b\/|--- a\/)(.+?)\r?$/gm

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
const SEARCH_TOOLS = new Set(["grep", "glob"])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPER_ARG = /^(-|\d+$|\{\}$)/
// Git config section and variable names are case-insensitive; these keys
// persist code execution or redirect includes, so a write must be denied.
const DANGEROUS_GIT_CONFIG =
  /core\.(?:hooksPath|fsmonitor|pager|sshCommand|askpass|editor|attributesFile|gitProxy|alternateRefsCommand|worktree)|^filter\.|^diff\.external$|^diff\..*\.(?:command|textconv)$|^credential\..*helper$|^sequence\.editor$|^gpg\.(?:.*\.)?program$|^include(?:If)?\.|^alias\.|^submodule\..*\.update|^pager\.|^interactive\.diffFilter$|^merge\..*\.driver$|^protocol\.ext\.allow$/i

// `git config --get key` and `git config key` are reads; only a write changes
// metadata. Values of value-taking options are not the key, so a read
// `git config --type bool core.hooksPath` stays a read.
function configWrites(args: string[]): boolean {
  if (args.some((word) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(word))) return false
  const valueOptions = new Set(["--file", "-f", "--comment", "--type", "--default", "--blob"])
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ""
    if (valueOptions.has(word)) {
      index += 1
      continue
    }
    if (word.startsWith("-")) continue
    positional.push(word)
  }
  const writeFlag = args.some(
    (word) =>
      word.startsWith("--unset") ||
      word.startsWith("--rename-section=") ||
      word.startsWith("--remove-section=") ||
      ["--add", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"].includes(word),
  )
  return positional.length >= 2 || writeFlag
}
// Words are split further on these before they are matched against a store path, so a path
// inside `file:...?mode=ro`, `if=...`, `"$(echo path)"` or SQL text is still found.
const SPLIT = /[\s'"`()=,:;<>|&{}[\]@]+/
const SHELL_HINT = new RegExp(
  [
    "opencode",
    "service",
    "credential",
    "local/share",
    "local/state",
    "config/opencode",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "hooksPath",
    "fsmonitor",
    "git-dir",
    // Credential directories whose DENY rules run in the shell: the hint must
    // fire even when no store root or `~` appears (`cat /home/u/.kube/config`).
    "\\.kube(?:/|$)",
    "\\.gnupg(?:/|$)",
    "\\.aws(?:/|$)",
    "\\.docker(?:/|$)",
    "\\.config/gcloud(?:/|$)",
    "\\.claude(?:/|$)",
    "\\.jwt_tool(?:/|$)",
    "\\.grok(?:/|$)",
    "\\.grokbot(?:/|$)",
    "environment\\.d(?:/|$)",
    // Any git invocation may write config/metadata; the subcommand parser below
    // decides whether it is a read or a write. Without this a `git -C x config`
    // carries no literal from the list and would never be parsed.
    "\\bgit\\b",
    "diff\\.external",
    "diff\\.[^.]+\\.(?:command|textconv)",
    "filter\\.",
    // Recursive readers are parsed even when no store literal appears: their
    // operand may be an ancestor of a store (`grep -r KEY ~`).
    "\\b(?:grep|egrep|fgrep|rgrep|zgrep|rg|ag|ack)\\b",
    // A fully percent-encoded store path (`file:%2e%6c%6f%63%61%6c...`) has
    // none of the literals above; the parser must run so decodePercent sees it.
    "%",
    escapeRegExp(DATA_HOME.replace(/\\/g, "/")),
    // A relocated root under $HOME can be spelled `~/.store`/`$HOME/.store`;
    // a glob can also hide the `opencode` component (`cat ~/.store/*/*.db`).
    // Parse those spellings so the relocated rules can run.
    "~",
    "\\$(?:\\{HOME\\}|HOME)",
    // A relocated XDG state root or OPENCODE_CONFIG_DIR may not contain the
    // `local/state` / `config/opencode` literals; name the resolved roots.
    escapeRegExp(STATE_ROOT.replace(/\\/g, "/")),
    escapeRegExp(CONFIG_ROOT.replace(/\\/g, "/")),
    // A direct `.git/config` or `.git/hooks` read/write names no store path;
    // without this the guard would skip parsing it and the git-metadata rule
    // would never run.
    "\\.git",
  ]
    .filter((part) => part !== "")
    .join("|"),
  "i",
)
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
const base = (word: string) => word.replace(/^.*[\\/]/, "")
// Windows shells resolve `git.exe` / `opencode.cmd`; compare the stem so the
// name-based branches still run.
const commandName = (word: string) => base(word).replace(/\.(?:exe|cmd|bat)$/i, "")

/** Decode one level of percent-encoding so `%2e`/`%73` cannot hide a store path. */
function decodePercent(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** Expand the shell spellings of the home and data directories. */
function expandHome(value: string): string {
  return value
    .replace(/^~(?=\/|$)/, () => homedir())
    .replace(/^\$(?:\{HOME\}|HOME)(?=\/|$)/, () => homedir())
    .replace(/^\$(?:\{XDG_DATA_HOME\}|XDG_DATA_HOME)(?=\/|$)/, () => DATA_HOME)
    .replace(/^\$(?:\{XDG_STATE_HOME\}|XDG_STATE_HOME)(?=\/|$)/, () => STATE_HOME)
    .replace(/^\$(?:\{XDG_CONFIG_HOME\}|XDG_CONFIG_HOME)(?=\/|$)/, () => CONFIG_HOME)
    // The config dir can be relocated explicitly; `$OPENCODE_CONFIG_DIR/env`
    // must resolve to the same root as the literal path.
    .replace(/^\$(?:\{OPENCODE_CONFIG_DIR\}|OPENCODE_CONFIG_DIR)(?=\/|$)/, () => CONFIG_ROOT)
}

function denied(value: string, rules: readonly Rule[]) {
  // Normalize to slash form so both `home/eric/...` (slash-less absolute) and
  // real absolute paths hit the same patterns; strip trailing slashes. Decode
  // percent escapes first so `%2e`/`%73` cannot spell a denied path, then
  // collapse repeated separators and resolve `.`/`..` so those spellings match.
  const decoded = decodePercent(value).replace(/^file:(?:\/\/)?/i, "")
  const flat = posix.normalize(expandHome(decoded).replace(/\\/g, "/")).replace(/\/+$/, "")
  return rules.find((rule) => rule.re.test(flat))
}

/** A path's real location, or its lexical form when it does not exist. */
function realOrSelf(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

/** Whether `target` is `root` itself or lives inside it. */
function containsPath(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The current session's goal file is the agent's own state, not another session's. */
function ownGoal(value: string, sessionID: string | undefined, base?: string): boolean {
  if (sessionID === undefined || sessionID === "") return false
  // `session import` preserves an arbitrary payload ID (upstream checks only
  // the `ses` prefix); a path separator in the ID would escape goals/ and
  // exempt an arbitrary path. Other characters (`.`, `:`) are legitimate in
  // a session ID, so reject separators rather than restricting the alphabet.
  if (!/^ses[^/\\]*$/.test(sessionID)) return false
  const goals = join(DATA_ROOT, "goals")
  const goal = join(goals, `${sessionID}.md`)
  // The host resolves a relative file path against the session directory;
  // resolve the value the same way so a relative `goals/<id>.md` is recognized.
  const resolved = resolve(base !== undefined && base !== "" ? base : process.cwd(), expandHome(value))
  return resolved === goal
}

// The session's own goal file is host-managed but deliberately writable by
// this agent (operator policy: "The goal file is ordinary disk state ... you
// *can* write the next goal yourself. That is an entrance, not a hole, and it
// is protocol-bound."). The exemption is exact-path and current-session-only;
// every other session's goal stays denied by the data-directory rule. Closing
// this entrance would be an operator policy change, not a guard fix.

function fileDenial(tool: string, input: Record<string, unknown>, sessionID?: string, base?: string) {
  const values = Object.entries(input)
    .filter(([key]) => PATH_KEYS.has(key) && TEXT_KEYS[tool] !== key)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).filter(isString).map((item) => [key, item] as const),
    )
  // The host's patch tool is `apply_patch`; the V1 name is `patch`. Both carry
  // the patch text, and a patch can add or update a denied file.
  const patchTexts =
    tool === "patch" || tool === "apply_patch"
      ? ["patchText", "patch", "diff", "input"]
          .map((key) => input[key])
          .filter(isString)
      : []
  const patched = patchTexts.flatMap((text) =>
    [...text.matchAll(PATCH_PATH)].map((match) => ["patchText", match[1] ?? match[2] ?? ""] as const),
  )
  const workspace = base !== undefined && base !== "" ? base : process.cwd()
  // The host resolves a relative `path` against the session directory, and a
  // relative grep `include` / glob `pattern` against that `path`; a glob is
  // only judged correctly when the same base is applied.
  const pathValue = isString(input.path) ? input.path : isString(input.filePath) ? input.filePath : undefined
  const pathBase =
    pathValue !== undefined && pathValue !== "" ? resolve(workspace, expandHome(pathValue)) : workspace
  if (SEARCH_TOOLS.has(tool)) {
    // A recursive search rooted at an ancestor of a store reads it even when
    // no operand spells the path (`grep -r KEY ~`, or a grep with no `path` in
    // a session whose workspace is `$HOME`). Reject the root; a narrower
    // directory stays available.
    const root = realOrSelf(pathValue !== undefined && pathValue !== "" ? pathBase : workspace)
    const stores: Array<[string, Rule | undefined]> = [
      [DATA_ROOT, DATA_RULE],
      [DEFAULT_DATA_ROOT, DATA_RULE],
      [STATE_ROOT, STATE_RULE],
      [DEFAULT_STATE_ROOT, STATE_RULE],
      [CONFIG_ROOT, CONFIG_RULE],
      [DEFAULT_CONFIG_ROOT, CONFIG_RULE],
    ]
    for (const [store, rule] of stores) {
      if (rule !== undefined && containsPath(root, realOrSelf(store))) return { key: "path", rule }
    }
    for (const dir of PROTECTED_DIRS) {
      if (containsPath(root, realOrSelf(dir))) return { key: "path", rule: credentialDirRule(dir) }
    }
  }
  return [...values, ...patched].flatMap(([key, value]) => {
    if (ownGoal(value, sessionID, workspace)) return []
    // A relative value is resolved by the host against the workspace; a raw
    // match alone lets `path: "opencode/log/x"` from a workspace at the
    // store's parent reach the store without spelling it.
    const resolved = value.length > 0 ? resolve(workspace, expandHome(value)) : undefined
    const rule =
      value.length > 0
        ? (denied(value, FILE_RULES) ?? (resolved === undefined ? undefined : denied(resolved, FILE_RULES)))
        : undefined
    // File tools accept globs (`glob` pattern/path, `grep` include); a wildcard
    // that can expand into the store is denied like the same shell glob.
    const globBase =
      (tool === "grep" || tool === "glob") && (key === "include" || key === "pattern") ? pathBase : workspace
    const hit = rule ?? (value.length > 0 ? globHit(value, globBase) : undefined)
    return hit ? [{ key, rule: hit }] : []
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
  // `${IFS}`/`$IFS` expands to whitespace in the shell; without this
  // `git${IFS}config` is one word and the git branch never runs. A quoted
  // literal is rare, and reading it as whitespace is the conservative direction.
  command = command.replace(/\$\{IFS\}|\$IFS/g, " ")
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
    const word = unquote(raw ?? "", state.current.nested)
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
// Options that take a separate value, per wrapper (`sudo -u root bash`,
// `nice -n 5 git`, `xargs -I {} git`). Without this, the value would be taken
// for the command and the real command's checks would never run.
const WRAPPER_VALUES: Record<string, ReadonlySet<string>> = {
  sudo: new Set([
    "-u",
    "-g",
    "-p",
    "-C",
    "-D",
    "-h",
    "-r",
    "-t",
    "-U",
    "-T",
    "-R",
    "-a",
    "-c",
    "--user",
    "--group",
    "--prompt",
    "--close-from",
    "--chdir",
    "--host",
    "--role",
    "--type",
    "--other-user",
    "--login-class",
    "--chroot",
    "--command-timeout",
    "--auth-type",
  ]),
  doas: new Set(["-u"]),
  exec: new Set(["-a"]),
  env: new Set(["-u", "-S", "--unset", "--split-string", "-C", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p"]),
  taskset: new Set(["-c", "-p"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-a", "-E", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  watch: new Set(["-n", "--interval"]),
}

// The directory a wrapper chain runs its command in (`env -C`, `sudo -D`,
// `sudo -R`). Git and relative operands resolve against this, not the shell's
// workdir: `env -C <store> cat log/x` reads the store.
function resolveCwd(value: string | undefined, base: string | undefined): string | undefined {
  if (value === undefined || value === "") return base
  const expanded = expandHome(value)
  if (isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded))
    return posix.normalize(expanded.replace(/\\/g, "/"))
  if (base === undefined || base === "") return expanded
  return posix.normalize(`${base.replace(/\\/g, "/")}/${expanded.replace(/\\/g, "/")}`)
}

function wrapperCwd(words: string[], at: number, baseCwd: string | undefined): string | undefined {
  let cwd = baseCwd
  let index = 0
  while (index < at) {
    const word = words[index] ?? ""
    if (ASSIGNMENT.test(word)) {
      index += 1
      continue
    }
    const wrapper = base(word)
    if (!WRAPPERS.has(wrapper)) {
      index += 1
      continue
    }
    const values = WRAPPER_VALUES[wrapper]
    const cwdFlags =
      wrapper === "env"
        ? new Set(["-C", "--chdir"])
        : wrapper === "sudo"
          ? new Set(["-D", "--chdir", "-R", "--chroot"])
          : undefined
    index += 1
    while (index < at) {
      const item = words[index] ?? ""
      if (ASSIGNMENT.test(item)) {
        index += 1
        continue
      }
      if (!item.startsWith("-")) break
      const option = item.split("=")[0] ?? item
      if (cwdFlags?.has(option)) {
        const value = item.includes("=") ? item.slice(item.indexOf("=") + 1) : words[index + 1]
        cwd = resolveCwd(value, cwd)
        index += item.includes("=") ? 1 : 2
        continue
      }
      index += 1
      if (values?.has(option) && !item.includes("=")) index += 1
    }
  }
  return cwd
}

function commandIndex(words: string[], from = 0): number {
  const word = words[from]
  if (word === undefined) return -1
  if (ASSIGNMENT.test(word)) return commandIndex(words, from + 1)
  const wrapper = base(word)
  if (!WRAPPERS.has(wrapper)) return from
  const values = WRAPPER_VALUES[wrapper]
  let index = from + 1
  while (index < words.length) {
    const item = words[index] ?? ""
    if (ASSIGNMENT.test(item)) {
      index += 1
      continue
    }
    if (item.startsWith("-")) {
      const option = item.split("=")[0] ?? item
      index += 1
      if (values?.has(option) && !item.includes("=")) index += 1
      continue
    }
    // `timeout 10 git ...`: the first bare duration precedes the command.
    if (wrapper === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(item)) {
      index += 1
      continue
    }
    // `busybox sh -c ...` / `builtin cd`: the next word is the command itself.
    if (wrapper === "busybox" || wrapper === "builtin") return index
    if (WRAPPER_ARG.test(item)) {
      index += 1
      continue
    }
    return index
  }
  return -1
}

// `args` minus the pattern or script operand of grep/sed/awk/jq-style readers.
// Flags that take a separate value must be consumed with it; otherwise
// `grep -r -C 3 KEY` would drop `3` and take `KEY` for a path operand.
function dropPattern(args: string[]) {
  const valueFlags = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-A",
    "-B",
    "-C",
    "-m",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--include",
    "--exclude",
  ])
  const patternFlags = new Set(["-e", "--regexp", "-f", "--file"])
  let patternSeen = false
  const out: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ""
    if (valueFlags.has(word)) {
      if (patternFlags.has(word)) patternSeen = true
      index += 1
      continue
    }
    // Attached/`=` forms (`-eKEY`, `--regexp=KEY`, `-fscript`, `--file=script`)
    // already carry their value; without this the following path operand would
    // be mistaken for the pattern and dropped.
    if (/^-(?:e|f)(.+)$/.test(word) || /^--(?:regexp|file)=(.+)$/.test(word)) {
      patternSeen = true
      continue
    }
    if (word.startsWith("-")) {
      out.push(word)
      continue
    }
    if (!patternSeen) {
      patternSeen = true
      continue
    }
    out.push(word)
  }
  return out
}

// A single glob component matched against one path component. `*` stays inside
// the component, `?` is one character, and `[...]`/`[!...]` classes pass through.
function globComponentPattern(component: string): RegExp {
  let out = "^"
  for (let index = 0; index < component.length; index += 1) {
    const char = component[index] ?? ""
    if (char === "*") {
      out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else if (char === "[") {
      const end = component.indexOf("]", index + 1)
      if (end === -1) {
        out += "\\["
      } else {
        let body = component.slice(index + 1, end)
        if (body.startsWith("!")) body = `^${body.slice(1)}`
        out += `[${body.replace(/\\/g, "\\\\")}]`
        index = end
      }
    } else {
      out += escapeRegExp(char)
    }
  }
  try {
    return new RegExp(`${out}$`, CASE_INSENSITIVE_FS ? "i" : "")
  } catch {
    // A malformed class (`[z-a]`) throws; fall back to a literal match so a
    // hostile grep `include`/glob `pattern` cannot break the guard hook.
    return new RegExp(`^${escapeRegExp(component)}$`, CASE_INSENSITIVE_FS ? "i" : "")
  }
}

// Resolve `.`/`..` lexically while preserving `**` and character classes.
// `posix.normalize` collapses `**/..` and hides the store. A `..` after `**`
// cannot be resolved statically: the wildcard may match zero segments (the
// `..` cancels the preceding component) or one or more (the `..` lands on the
// preceding component). Two readings cover both cases; globHit checks each.
// `wildcard` keeps the `**` (the one-or-more reading); the default drops both
// the `**` and the preceding component (the zero-segment reading).
function resolveGlobParts(parts: string[], wildcard = false): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] === "**") {
        if (!wildcard) {
          out.pop()
          if (out.length > 0) out.pop()
        }
      } else if (out.length > 0) out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

// A glob can expand into the store when its components match the store root's
// components as a prefix. `**` may consume any number of components, so an
// ancestor wildcard (`~/.local/*/opencode/log`, `~/*/.local/share/opencode`)
// is caught even though it never spells the full root.
function globCoversRoot(globParts: string[], rootParts: string[], at = 0, rootAt = 0): boolean {
  if (at === globParts.length) return true
  if (rootAt === rootParts.length) return true
  const part = globParts[at] ?? ""
  if (part === "**") {
    for (let skip = 0; rootAt + skip <= rootParts.length; skip += 1) {
      if (globCoversRoot(globParts, rootParts, at + 1, rootAt + skip)) return true
    }
    return false
  }
  if (part === "..") return globCoversRoot(globParts, rootParts, at + 1, Math.max(0, rootAt - 1))
  return globComponentPattern(part).test(rootParts[rootAt] ?? "") && globCoversRoot(globParts, rootParts, at + 1, rootAt + 1)
}

function globHit(token: string, base?: string): Rule | undefined {
  const expanded = expandHome(token)
  const windows = /^[A-Za-z]:[\\/]/.test(expanded)
  // A relative glob (`**/*.ts`, `.local/*/opencode/...`) is resolved by the
  // shell against its workdir or by the file tool against its `path`; the
  // caller passes that base. Without a base it cannot be resolved, and
  // treating it as anchored at `/` would make `**` consume the home directory
  // and deny ordinary project globs.
  if (!expanded.startsWith("/") && !windows) {
    if (base === undefined || base === "") return undefined
    return globHit(`${base.replace(/\\/g, "/")}/${expanded.replace(/\\/g, "/")}`, undefined)
  }
  const raw = expanded.replace(/\\/g, "/")
  if (!/[*?[]/.test(raw)) return undefined
  const parts = raw.split("/").filter((part) => part !== "")
  // Resolve `.`/`..` lexically while preserving `**` and character classes.
  // Without `**`, `posix.normalize` is exact; with `**`, a component stack is
  // the only spelling that keeps the wildcard and the classes intact.
  const normalized = parts.includes("**")
    ? resolveGlobParts(parts)
    : posix.normalize(raw).split("/").filter((part) => part !== "")
  // A `..` after `**` has two readings; check the second one too, or one
  // expansion can hide the store.
  const variants =
    parts.includes("**") && parts.includes("..")
      ? [normalized, resolveGlobParts(parts, true)]
      : [normalized]
  // Check the runtime and default stores for the data, state, and config
  // roots: a shell glob into any of them must be denied, and a relocated XDG
  // root must not hide the default one.
  for (const variant of variants) {
    for (const [root, rule] of STORE_ROOTS) {
      if (rule === undefined) continue
      const rootParts = root.replace(/\\/g, "/").split("/").filter((part) => part !== "")
      if (rootParts.length > 0 && globCoversRoot(variant, rootParts)) return rule
    }
    // A glob can reach a credential directory without spelling it (`~/.k*/*`
    // expands to `~/.kube/config`); the protected roots are as sensitive as
    // the store roots.
    for (const dir of PROTECTED_DIRS) {
      const rootParts = dir.replace(/\\/g, "/").split("/").filter((part) => part !== "")
      if (rootParts.length > 0 && globCoversRoot(variant, rootParts)) return credentialDirRule(dir)
    }
  }
  return undefined
}

// The repository top for a default worktree (`git add -A`/`git grep` with no
// pathspec act on the whole repository, not the shell's subdirectory). A
// subdirectory cwd inside a repository that contains the store must still be
// recognized as containing it.
function repoTop(start: string): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      try {
        return realpathSync(dir)
      } catch {
        return dir
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

// Bash brace expansion can hide a store path in a token that matches no rule
// (`~/.local/share/{opencode,x}/opencode.db`). Expand bounded alternatives
// before matching; nested braces are expanded recursively.
function braceVariants(word: string, limit = 16): string[] {
  const open = word.indexOf("{")
  if (open === -1) return [word]
  const close = word.indexOf("}", open + 1)
  if (close === -1) return [word]
  const parts = word.slice(open + 1, close).split(",")
  if (parts.length < 2) return [word]
  const out: string[] = []
  for (const part of parts) {
    const next = `${word.slice(0, open)}${part}${word.slice(close + 1)}`
    for (const variant of braceVariants(next, limit)) {
      out.push(variant)
      if (out.length >= limit) return out
    }
  }
  return out
}

function fileOperandDenial(word: string, cwd?: string): Denial | undefined {
  for (const variant of braceVariants(word)) {
    const hit = fileOperandDenialOne(variant, cwd)
    if (hit) return hit
  }
  return undefined
}

function fileOperandDenialOne(word: string, cwd?: string): Denial | undefined {
  // A file read through git (`git diff --no-index A B`) is not a shell operand:
  // it reads the file directly, so the file-tool rules (SSH, GPG, env files)
  // apply, not the store-focused shell rules.
  const expanded = expandHome(word)
  const absolute = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
  const resolved =
    cwd !== undefined && cwd !== "" && !absolute
      ? posix.normalize(`${cwd.replace(/\\/g, "/")}/${word.replace(/\\/g, "/")}`)
      : undefined
  const rule =
    denied(word, FILE_RULES) ??
    denied(expanded, FILE_RULES) ??
    globHit(word, cwd) ??
    (resolved === undefined ? undefined : denied(resolved, FILE_RULES))
  if (rule) return { why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: word }
  // `git diff --no-index`/`grep --no-index` read a directory recursively; an
  // ancestor operand (`~`, `/`, `.` from a home workdir) reaches every store
  // and credential directory below it.
  const rootPath = resolved ?? (absolute ? posix.normalize(expanded.replace(/\\/g, "/")) : undefined)
  if (rootPath !== undefined) {
    const root = realOrSelf(rootPath)
    for (const [store, storeRule] of STORE_ROOTS) {
      if (storeRule !== undefined && containsPath(root, realOrSelf(store)))
        return { why: storeRule.why, hint: storeRule.hint ?? FIELD_HINT, shown: word }
    }
    for (const dir of PROTECTED_DIRS) {
      if (containsPath(root, realOrSelf(dir)))
        return { why: "credential directory", hint: FIELD_HINT, shown: word }
    }
  }
  return undefined
}

function operandDenial(word: string, cwd?: string, sessionID?: string, recursive = false): Denial | undefined {
  // The current session's own goal is deliberately writable (operator policy:
  // "an entrance, not a hole"); every other session's goal is still denied.
  if (ownGoal(word, sessionID, cwd)) return undefined
  const tokens = [word, ...word.split(SPLIT)]
    .flatMap((token) => braceVariants(token))
    .filter((token) => token.length > 0 && !ownGoal(token, sessionID, cwd))
  return tokens.flatMap((token) => {
    const expanded = expandHome(token)
    // A relative operand is resolved against the shell's workdir. Without
    // this, `cd ~/.local/share && cat opencode/log/x` names the store through
    // a workdir the raw token never spells.
    const absolute = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
    const resolved =
      cwd !== undefined && cwd !== "" && !absolute
        ? posix.normalize(`${cwd.replace(/\\/g, "/")}/${token.replace(/\\/g, "/")}`)
        : undefined
    if (recursive) {
      // An absolute operand (`~`, `/home/u`) needs no workdir join; a relative
      // one is resolved against the shell's workdir.
      const rootPath = resolved ?? (absolute ? posix.normalize(expanded.replace(/\\/g, "/")) : undefined)
      if (rootPath !== undefined) {
        // A recursive reader rooted at an ancestor of a store reads it even
        // when the operand never spells the store (`grep -r KEY ~`).
        const root = realOrSelf(rootPath)
        for (const [store, rule] of STORE_ROOTS) {
          if (rule !== undefined && containsPath(root, realOrSelf(store)))
            return [{ why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: token }]
        }
        for (const dir of PROTECTED_DIRS) {
          if (containsPath(root, realOrSelf(dir))) {
            const rule = credentialDirRule(dir)
            return [{ why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: token }]
          }
        }
      }
    }
    const rule =
      denied(token, SHELL_RULES) ??
      // A `~`/`$HOME` operand does not match an absolute credential glob; the
      // expanded spelling does. (`denied` resolves a bare `~` only when the
      // pattern starts with it, not when the operand does.)
      denied(expanded, SHELL_RULES) ??
      (resolved === undefined ? undefined : denied(resolved, SHELL_RULES)) ??
      globHit(token, cwd)
    return rule ? [{ why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: token }] : []
  })[0]
}

// `opencode run -f <path>` / `--file=<path>` attaches a file to the message; the
// file is read and sent to the model. Unlike a shell operand, an attachment is
// always a file read, so the file-only credential rules apply too.
function fileArgDenial(values: string[], cwd?: string): Denial | undefined {
  for (const value of values) {
    const expanded = expandHome(value)
    const resolved = cwd !== undefined && cwd !== "" ? resolve(cwd, expanded) : undefined
    const rule =
      denied(value, DENY_FOLDED) ??
      (resolved === undefined ? undefined : denied(resolved, DENY_FOLDED)) ??
      globHit(value, cwd)
    if (rule) return { why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: value }
  }
  return undefined
}

// `opencode run -f <path>` / `--file=<path>` attaches a file to the message; the
// file is read and sent to the model, so its path must pass the same rules.
function opencodeFileArgs(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ""
    if (word === "-f" || word === "--file" || word === "--attach") {
      const next = args[index + 1]
      if (next !== undefined) values.push(next)
    } else if (word.startsWith("--file=") || word.startsWith("--attach=")) {
      values.push(word.slice(word.indexOf("=") + 1))
    } else if (/^-f[^-]/.test(word)) {
      values.push(word.slice(2))
    }
  }
  return values
}

function hasSessionFlag(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ""
    // After `--`, every word is positional data (a prompt), never a flag.
    if (word === "--") return false
    if (
      word === "-c" ||
      word === "--continue" ||
      word.startsWith("--continue=") ||
      word === "-s" ||
      (word.startsWith("-s") && word.length > 2 && !word.startsWith("--")) ||
      word === "--session" ||
      word.startsWith("--session=") ||
      word === "--fork" ||
      word.startsWith("--fork=") ||
      word === "-cs" ||
      word === "-sc"
    ) {
      return true
    }
    // Skip the value of a value-taking flag: `--prompt -s` passes "-s" as
    // data, not as a session switch.
    if (VALUE_FLAGS.has(word)) index += 1
  }
  return false
}

// Root subcommands that the guard distinguishes. The subcommand is the first
// known command word, skipping global flags (and their values) and the optional
// positional directory: anchoring on plain[0] let `opencode --server URL auth
// export` shift the subcommand out of view.
const SUBCOMMANDS = new Set([
  "acp",
  "api",
  "debug",
  "auth",
  "mcp",
  "plugin",
  "models",
  "stats",
  "mini",
  "run",
  "session",
  "service",
  "reload",
  "pair",
  "serve",
])
const VALUE_FLAGS = new Set([
  "--server",
  "--session",
  "-s",
  "--prompt",
  "--log-level",
  "--completions",
  "-m",
  "--model",
  "--agent",
])

function opencodeSubcommand(args: string[]): { name: string; index: number } {
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? ""
    // `opencode -- auth export` is still the auth subcommand; `--` ends option
    // parsing, not the command. Continue scanning the positional words.
    if (word === "--") continue
    if (word.startsWith("-")) {
      if (VALUE_FLAGS.has(word)) position += 1
      continue
    }
    if (SUBCOMMANDS.has(word)) return { name: word, index: position }
  }
  return { name: "", index: -1 }
}

// opencode subcommands that print secrets. Matched on the subcommand and its
// own operands only: a `run` prompt that merely mentions "session" or
// "auth export" is data and must stay runnable.
function cliDenial(args: string[]): Denial | undefined {
  const { name: sub, index } = opencodeSubcommand(args)
  const decoded =
    index === -1 ? [] : args.slice(index + 1).filter((word) => !word.startsWith("-")).map(decodePercent)
  if (sub === "auth" && decoded[0] === "export")
    return { why: "`opencode auth export` (prints every stored credential value)", hint: "List logins with `opencode auth list`.", shown: "auth export" }
  if (sub === "service" && decoded[0] === "get") {
    // Bare `get` prints the whole service config (including `env`), and any
    // key outside this allowlist may be secret-bearing; `get env` printed every
    // provider key while only `get password` was denied.
    const allowed = new Set(["disabled", "hostname", "port", "cors", "remote"])
    if (decoded[1] === undefined || !allowed.has(decoded[1]))
      return {
        why: "`opencode service get` (prints the service env, including provider keys)",
        hint: SERVICE_HINT,
        shown: decoded[1] === undefined ? "service get" : `service get ${decoded[1]}`,
      }
  }
  if (sub === "api") {
    if (decoded.some((word) => word === "credential.list" || denied(word, SHELL_RULES)))
      return { why: "the credential listing endpoint (returns every secret value)", hint: DATABASE_HINT, shown: "api credential" }
    if (decoded.some((word) => /session|(?:^|\/)event(?:\/|$)|event\.subscribe/i.test(word)))
      return {
        why: "the session API (reads another session's transcript or event stream)",
        hint: "Run it from the operator's terminal, not the agent shell.",
        shown: "api session/event",
      }
  }
  // `run`, `mini`, and a bare root invocation all accept `--session`/`-s`/
  // `--continue`/`-c`/`--fork`; restricting the rule to `run` let the other two
  // continue another session.
  if ((sub === "run" || sub === "mini" || sub === "") && hasSessionFlag(args))
    return {
      why: "`opencode run --session`/`--continue`/`--fork` or a root `--session` (cross-session)",
      hint: "Run it from the operator's terminal, not the agent shell.",
      shown: "run session",
    }
  if (sub === "session" && ["export", "list", "delete", "import"].includes(decoded[0] ?? ""))
    return {
      why: "`opencode session ...` (reads or mutates another session)",
      hint: "Run it from the operator's terminal, not the agent shell.",
      shown: "session ...",
    }
  return undefined
}

// `bash -c '…'`, `bash -lc '…'`, `bash -c'…'`, `sudo bash --norc -c '…'` and `eval …` run their payload as a command line.
function shellPayload(args: string[], name: string) {
  if (name === "eval") return args.join(" ")
  if (!SHELLS.has(name)) return undefined
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ""
    if (word.startsWith("--")) continue
    const match = /^-[A-Za-z]*c(.*)$/.exec(word)
    if (match === null) continue
    // `bash -lcx 'cmd'`: the letters after `c` are further flags and the
    // command string is the next argument. `bash -c'cmd'` puts the command in
    // the suffix. Inspect both so neither spelling hides the payload.
    const attached = (match[1] ?? "").trim()
    const next = (args[index + 1] ?? "").trim()
    const scripts = [attached, next].filter((script) => script !== "")
    return scripts.length > 0 ? scripts.join("\n") : undefined
  }
  return undefined
}

// A balanced scan for `$(...)` and backtick substitutions (they execute even
// inside double quotes and may nest parentheses).
function substitutionScripts(text: string): string[] {
  const scripts: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && text[index + 1] === "(") {
      let depth = 1
      let at = index + 2
      while (at < text.length && depth > 0) {
        if (text[at] === "(") depth += 1
        else if (text[at] === ")") depth -= 1
        at += 1
      }
      if (depth === 0) {
        const script = text.slice(index + 2, at - 1).trim()
        if (script !== "") scripts.push(script)
        index = at - 1
      }
      continue
    }
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1)
      if (end === -1) break
      const script = text.slice(index + 1, end).trim()
      if (script !== "") scripts.push(script)
      index = end
    }
  }
  return scripts
}

// `env -S 'cmd ...'` / `--split-string` takes a whole command line as one word.
function splitStringPayloads(words: string[]): string[] {
  const scripts: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ""
    if (word === "-S" || word === "--split-string") {
      const payload = (words[index + 1] ?? "").trim()
      if (payload !== "") scripts.push(payload)
      index += 1
    } else if (word.startsWith("--split-string=")) {
      const payload = word.slice("--split-string=".length).trim()
      if (payload !== "") scripts.push(payload)
    } else if (/^-S.+/.test(word)) {
      // `env -S'cat …'` concatenates to one word (`-Scat …`).
      const payload = word.slice(2).trim()
      if (payload !== "") scripts.push(payload)
    }
  }
  return scripts
}

// `find . -exec cat ... \;` runs its payload as a command line.
function execPayloads(words: string[]): string[] {
  const scripts: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ""
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(word)) continue
    const payload: string[] = []
    for (let at = index + 1; at < words.length; at += 1) {
      const item = words[at] ?? ""
      if (item === ";" || item === "+") break
      payload.push(item)
    }
    const script = payload.join(" ").trim()
    if (script !== "") scripts.push(script)
  }
  return scripts
}

// `watch 'git stash'` / `xargs git commit` run a command line held in one word.
function watchPayloads(words: string[]): string[] {
  const scripts: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const name = (words[index] ?? "").replace(/\\/g, "/").split("/").pop() ?? ""
    if (name !== "watch" && name !== "xargs") continue
    const args = words.slice(index + 1)
    let at = 0
    while (at < args.length && (args[at] ?? "").startsWith("-")) {
      const flag = args[at] ?? ""
      if (["-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a", "--interval"].includes(flag)) at += 1
      at += 1
    }
    const script = args.slice(at).join(" ").trim()
    if (script !== "") scripts.push(script)
  }
  return scripts
}

function shellDenial(command: string, depth = 0, cwd?: string, sessionID?: string): Denial | undefined {
  if (depth > MAX_DEPTH) return undefined
  // A store-relative command can hide the store behind the workdir
  // (`cat .local/*/*/*.db` from `$HOME`): no hint literal appears, so the
  // operand resolution below must still run. Parse whenever the workdir
  // contains a store root.
  const workdirSensitive =
    cwd !== undefined &&
    cwd !== "" &&
    STORE_ROOTS.some(([root, rule]) => rule !== undefined && containsPath(realOrSelf(cwd), realOrSelf(root)))
  if (!SHELL_HINT.test(command) && !workdirSensitive) return undefined
  // Command substitutions execute even inside double quotes; inspect them as
  // nested command lines (`echo "$(git config core.hooksPath /tmp)"`).
  for (const script of substitutionScripts(command)) {
    const nested = shellDenial(script, depth + 1, cwd, sessionID)
    if (nested !== undefined) return nested
  }
  const first = (words: string[], recursive = false) =>
    words.map((word) => operandDenial(word, cwd, sessionID, recursive)).find((denial) => denial)
  return parse(command)
    .map((statement): Denial | undefined => {
      const at = commandIndex(statement.words)
      const name = at === -1 ? "" : commandName(statement.words[at] ?? "")
      const args = at === -1 ? [] : statement.words.slice(at + 1)
      // The wrapper chain's cwd applies to the command's operands and to a
      // nested shell payload; shell-side redirections and substitutions still
      // run in the shell's own workdir.
      const runCwd = wrapperCwd(statement.words, at, cwd)
      const firstIn = (words: string[], baseCwd: string | undefined, recursive = false) =>
        words.map((word) => operandDenial(word, baseCwd, sessionID, recursive)).find((denial) => denial)
      const redirected = first([...statement.reads, ...statement.writes])
      if (redirected) return redirected
      for (const script of [
        ...splitStringPayloads(statement.words),
        ...execPayloads(statement.words),
        ...watchPayloads(statement.words),
      ]) {
        const nested = shellDenial(script, depth + 1, runCwd, sessionID)
        if (nested) return nested
      }
      // `find` roots are the search roots: `find <store> -exec cat {} +` and
      // `find <store> | xargs cat` read the store even though the payload is
      // just `cat {}`. Leading -H/-L/-P are options; the first word starting
      // with "-" begins the expression.
      if (name === "find") {
        const roots: string[] = []
        let index = 0
        while (index < args.length) {
          const word = args[index] ?? ""
          if (word === "-H" || word === "-L" || word === "-P") {
            index += 1
            continue
          }
          if (word === "-D") {
            index += 2
            continue
          }
          if (word.startsWith("-")) break
          roots.push(word)
          index += 1
        }
        const hit = firstIn(roots.length > 0 ? roots : ["."], runCwd, true)
        if (hit) return hit
      }
      // `xargs -a <file>` reads its input from the file and prints it. xargs
      // is a wrapper, so commandIndex resolves the command past it; scan the
      // statement words instead.
      for (let index = 0; index < statement.words.length; index += 1) {
        if (base(statement.words[index] ?? "") !== "xargs") continue
        const xargsArgs = statement.words.slice(index + 1)
        for (let at2 = 0; at2 < xargsArgs.length; at2 += 1) {
          const word = xargsArgs[at2] ?? ""
          let value: string | undefined
          if (word === "-a" || word === "--arg-file") value = xargsArgs[at2 + 1]
          else if (word.startsWith("--arg-file=")) value = word.slice("--arg-file=".length)
          else if (/^-a.+/.test(word)) value = word.slice(2)
          if (value === undefined) continue
          const hit = fileOperandDenial(value, runCwd) ?? operandDenial(value, runCwd, sessionID)
          if (hit) return hit
        }
      }
      if (name === "opencode") return fileArgDenial(opencodeFileArgs(args), runCwd) ?? cliDenial(args)
      if (name === "git") {
        // Git path variables apply from the environment before the command and
        // are skipped by commandIndex. `GIT_INDEX_FILE=<store>/opencode.db git
        // add -A` writes the index over the database; GIT_DIR/GIT_COMMON_DIR/
        // GIT_OBJECT_DIRECTORY redirect the repository writes into the store.
        const GIT_PATH_ENV = new Set([
          "GIT_DIR",
          "GIT_WORK_TREE",
          "GIT_COMMON_DIR",
          "GIT_INDEX_FILE",
          "GIT_OBJECT_DIRECTORY",
          "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        ])
        for (const word of statement.words.slice(0, at)) {
          if (!word.includes("=")) continue
          const eq = word.indexOf("=")
          const key = word.slice(0, eq)
          if (!GIT_PATH_ENV.has(key)) continue
          const value = word.slice(eq + 1)
          const values = key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ? value.split(":") : [value]
          for (const item of values) {
            const hit = fileOperandDenial(item, runCwd) ?? operandDenial(item, runCwd, sessionID, true)
            if (hit) return hit
          }
        }
        // `git config --file .git/config ...` / `git --git-dir=...` write
        // repository metadata (hooks, fsmonitor, external diff) that can
        // execute code; the gate stops them too, this is the independent layer.
        // Only config operands are checked: a commit message that mentions a
        // store path is data, not a read.
        if (args.some((word) => word === "--git-dir" || word.startsWith("--git-dir=")))
          return {
            why: "git --git-dir (can operate on another repository's metadata)",
            hint: "Ask the operator to change git config or hooks.",
            shown: args.join(" "),
          }
        // The worktree `git -C`/`--work-tree`/`GIT_WORK_TREE` moves to; the
        // `--no-index` readers resolve their operands against it, not the
        // shell's workdir.
        // Global options precede the subcommand. Git applies every `-C` in
        // order (the last wins); `--work-tree`/`GIT_WORK_TREE` change the
        // repository, not the process cwd that `--no-index` operands resolve
        // against, so they are deliberately ignored here. Stop at the
        // subcommand: `git grep -C 3` is context, not a directory.
        const GIT_GLOBAL_VALUES = new Set([
          "-c",
          "--config-env",
          "--git-dir",
          "--work-tree",
          "--namespace",
          "--exec-path",
          "--super-prefix",
        ])
        let gitCwd: string | undefined = runCwd
        let subIndex = -1
        for (let index = at + 1; index < statement.words.length; index += 1) {
          const word = statement.words[index] ?? ""
          if (!word.startsWith("-")) {
            subIndex = index
            break
          }
          if (word === "-C") {
            gitCwd = resolveCwd(statement.words[index + 1], gitCwd)
            index += 1
          } else if (/^-C.+/.test(word)) {
            gitCwd = resolveCwd(word.slice(2), gitCwd)
          } else if (GIT_GLOBAL_VALUES.has(word)) {
            index += 1
          }
        }
        // Git applies every `-C` in order; resolveCwd chains them.
        const gitCwdAbs = gitCwd
        // `git grep` with no pathspec searches the worktree top, which
        // --work-tree/GIT_WORK_TREE can move; explicit pathspecs are relative
        // to the `-C` cwd. (A diff --no-index path is always relative to the
        // cwd, never the worktree.)
        const workTreeEq = statement.words
          .slice(at + 1)
          .find((word) => word.startsWith("--work-tree="))
        const workTreeIndex = statement.words.indexOf("--work-tree", at + 1)
        const envWorkTree = statement.words
          .slice(0, at)
          .filter((word) => word.startsWith("GIT_WORK_TREE="))
          .pop()
        const explicitWorkTree =
          workTreeEq !== undefined || workTreeIndex !== -1 || envWorkTree !== undefined
        const workTreeRaw = workTreeEq
          ? workTreeEq.slice("--work-tree=".length)
          : workTreeIndex !== -1
            ? (statement.words[workTreeIndex + 1] ?? gitCwd)
            : envWorkTree
              ? envWorkTree.slice("GIT_WORK_TREE=".length)
              : undefined
        const gitWorkTreeAbs = explicitWorkTree
          ? workTreeRaw === undefined || workTreeRaw === ""
            ? gitCwdAbs
            : // Git applies `-C` first, so a relative worktree is relative to
              // the effective `-C` directory, not the shell workdir.
              resolveCwd(workTreeRaw, gitCwdAbs)
          : gitCwdAbs === undefined
            ? undefined
            : repoTop(gitCwdAbs)
        // `git -c key=value <cmd>` sets config for one command; a dangerous
        // key (`alias.*`, `diff.external`, `core.hooksPath`) executes code.
        // Only the global options (before the subcommand) are `-c` config;
        // `git diff -c` is a subcommand option.
        const globalArgs = subIndex === -1 ? args : statement.words.slice(at + 1, subIndex)
        for (let index = 0; index < globalArgs.length; index += 1) {
          const word = globalArgs[index] ?? ""
          let value = ""
          if (word === "-c" || word === "--config-env") {
            value = globalArgs[index + 1] ?? ""
            index += 1
          } else if (word.startsWith("--config-env=")) {
            value = word.slice("--config-env=".length)
          } else if (/^-c.+/.test(word)) {
            value = word.slice(2)
          } else {
            continue
          }
          const key = value.split("=")[0] ?? ""
          if (DANGEROUS_GIT_CONFIG.test(key))
            return {
              why: "git -c (dangerous config for one command)",
              hint: "Ask the operator to change git config or hooks.",
              shown: args.join(" "),
            }
        }
        const subName = subIndex === -1 ? "" : (statement.words[subIndex] ?? "")
        const subArgs = subIndex === -1 ? [] : statement.words.slice(subIndex + 1)
        // `--work-tree`/GIT_WORK_TREE can point git at the store. Every
        // subcommand that reads or stages worktree content is a bypass
        // (`git --work-tree=$DATA diff --text`, `add` then `show :file`), so
        // deny the class instead of only grep.
        const WORKTREE_READERS = new Set([
          "add",
          "am",
          "apply",
          "archive",
          "cat-file",
          "checkout",
          "clean",
          "commit",
          "diff",
          "grep",
          "merge",
          "mv",
          "pull",
          "rebase",
          "reset",
          "restore",
          "rm",
          "show",
          "sparse-checkout",
          "stash",
          "submodule",
        ])
        if (gitWorkTreeAbs !== undefined && gitWorkTreeAbs !== "" && WORKTREE_READERS.has(subName)) {
          const worktreeHit = operandDenial(gitWorkTreeAbs, runCwd, sessionID, true)
          if (worktreeHit) return worktreeHit
        }
        if (subName === "config") {
          const configArgs = subArgs
          const direct = firstIn(configArgs, gitCwdAbs ?? runCwd)
          if (direct) return direct
          // `-e`/`--edit` opens the config in an editor that can write any key.
          if (configArgs.some((word) => word === "-e" || word === "--edit"))
            return {
              why: "git config --edit (can write any config key)",
              hint: "Ask the operator to change git config or hooks.",
              shown: args.join(" "),
            }
          // `--rename-section <old> <new>` (or `--rename-section=<old> <new>`)
          // can turn a benign section into `core.hooksPath`; check the
          // destination section too.
          const renameEqIndex = configArgs.findIndex((word) => word.startsWith("--rename-section="))
          const renameIndex = configArgs.indexOf("--rename-section")
          const renameTarget =
            renameEqIndex !== -1
              ? configArgs.slice(renameEqIndex + 1).filter((word) => !word.startsWith("-"))[0]
              : renameIndex === -1
                ? undefined
                : configArgs
                    .slice(renameIndex + 1)
                    .filter((word) => !word.startsWith("-"))[1]
          if (
            configWrites(configArgs) &&
            (configArgs.some((word) => DANGEROUS_GIT_CONFIG.test(word)) ||
              (renameTarget !== undefined &&
                /^(?:core|diff|filter|credential|include(?:If)?|sequence|gpg|alias|pager|submodule|interactive)(?:\.|$)/i.test(
                  renameTarget,
                )))
          )
            return {
              why: "git config (can execute code or change the reviewed tree)",
              hint: "Ask the operator to change git config or hooks.",
              shown: args.join(" "),
            }
        }
        // `git add`/`show`/`diff` read worktree content by operand; a symlinked
        // directory can route a normal-looking path into a credential store
        // (`src -> ~/.ssh`; `git add src/id_rsa`, then `git show :src/id_rsa`).
        const printsContent =
          subName === "blame" ||
          (subName === "log" &&
            subArgs.some(
              (word) => word === "-p" || word === "--patch" || word === "--unified" || /^-U/.test(word),
            ))
        if (subName === "add" || subName === "show" || subName === "diff" || printsContent) {
          const operands = subArgs.filter((word) => !word.startsWith("-") && word !== "--")
          const paths = subName === "add" && operands.length === 0 ? ["."] : operands
          for (const word of paths) {
            const fromIndex = subName === "show" && word.includes(":")
            const operand = fromIndex ? word.slice(word.lastIndexOf(":") + 1) : word
            if (operand === "") continue
            const expanded = expandHome(operand)
            const absolute = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
            // An index path (`:path`, `HEAD:path`) is repository-root-relative;
            // a worktree operand is relative to the `-C` cwd.
            const base = fromIndex ? (gitWorkTreeAbs ?? gitCwdAbs) : (gitCwdAbs ?? runCwd)
            const resolved = absolute ? expanded : base !== undefined && base !== "" ? join(base, expanded) : expanded
            // The raw resolved path catches a deleted store file that is still
            // in the index: realpathSync would fail and skip the rule.
            const direct = denied(resolved, FILE_RULES)
            if (direct) return { why: direct.why, hint: direct.hint ?? FIELD_HINT, shown: word }
            let real: string
            try {
              real = realpathSync(resolved)
            } catch {
              continue
            }
            const recursiveHit = operandDenial(real, undefined, sessionID, true)
            if (recursiveHit) return recursiveHit
            const rule = denied(real, FILE_RULES)
            if (rule) return { why: rule.why, hint: rule.hint ?? FIELD_HINT, shown: word }
          }
        }
        // `git diff --no-index A B` prints arbitrary file content; unlike a
        // repository diff, its operands are plain files, so the file-tool
        // credential rules apply.
        if (subName === "diff" && subArgs.includes("--no-index")) {
          const diffArgs = subArgs.filter((word) => !word.startsWith("-") && word !== "--")
          const hit = diffArgs
            .map((word) => fileOperandDenial(word, gitCwdAbs ?? runCwd))
            .find((denial) => denial)
          if (hit) return hit
        }
        // `git grep --no-index KEY` searches the worktree, not the index; from
        // a home workdir it prints store files. The search root can move via
        // `-C` (separate or attached), `--work-tree` (separate or `=`), or a
        // `GIT_WORK_TREE=` assignment before the command.
        if (subName === "grep") {
          const grepArgs = subArgs.filter((word) => word !== "--no-index")
          const grepOperands = dropPattern(grepArgs)
          const hasOperands = grepOperands.some((word) => !word.startsWith("-"))
          const grepBase = hasOperands ? gitCwdAbs : gitWorkTreeAbs
          const roots = hasOperands
            ? grepOperands
            : grepBase !== undefined && grepBase !== ""
              ? [grepBase]
              : []
          const hit = roots
            .map((word) => operandDenial(word, grepBase, sessionID, true))
            .find((denial) => denial)
          if (hit) return hit
        }
      }
      const inline = args.some((word) => INLINE_FLAGS.has(word))
      const reading = READERS.has(name) ? (SCRIPT_FIRST.has(name) ? dropPattern(args) : args) : []
      const scripted = INTERPRETERS.has(name) && inline ? args : []
      const recursiveReader =
        ["rg", "ag", "ack"].includes(name) ||
        (name === "diff" && args.some((word) => word === "-r" || word === "--recursive")) ||
        (/grep$/.test(name) &&
          args.some(
            (word) =>
              /^-[A-Za-z]*[rR]/.test(word) ||
              word === "--recursive" ||
              word === "--dereference-recursive" ||
              word === "--directories=recurse" ||
              word === "recurse",
          ))
      const operands = [...reading, ...scripted]
      // `grep -r KEY` with no path searches the workdir; check that root too.
      const recursiveRoots =
        recursiveReader && runCwd !== undefined && runCwd !== "" && !operands.some((word) => !word.startsWith("-"))
          ? [runCwd]
          : operands
      const operandHit = firstIn(recursiveRoots, runCwd, recursiveReader)
      if (operandHit) return operandHit
      // A heredoc or here-string fed to a runner is code, SQL or a command line; fed to cat it is just text.
      const runs = SHELLS.has(name)
      const code = runs || INTERPRETERS.has(name) || SQL_CLIENTS.has(name) ? statement.heredocs : []
      const payload = shellPayload(args, name)
      // Substitutions run in the shell's workdir; a shell payload or heredoc
      // fed to the command runs in the wrapper chain's cwd.
      const commandScripts = [...(runs ? code : []), ...(payload ? [payload] : [])]
      return (
        statement.nested
          .map((text) => shellDenial(text, depth + 1, cwd, sessionID))
          .find((denial) => denial) ??
        commandScripts
          .map((text) => shellDenial(text, depth + 1, runCwd, sessionID))
          .find((denial) => denial) ??
        (runs ? undefined : firstIn(code, runCwd))
      )
    })
    .find((denial) => denial)
}

// The shell tool can start inside a store: a relative operand (`goals/ses.md`)
// then names a store file without spelling it. Deny such a workdir outright
// (lexically and through its real path, so a symlink cannot hide it).
function workdirRule(workdir: string): Rule | undefined {
  const expanded = expandHome(workdir)
  const direct = denied(expanded, DENY_FOLDED)
  if (direct) return direct
  try {
    const real = realpathSync(resolve(expanded))
    const rule = denied(real, DENY_FOLDED)
    if (rule) return rule
    for (const dir of PROTECTED_DIRS) {
      // The workdir must be *inside* the credential directory; `$HOME` is an
      // ancestor of `.ssh` and a legitimate workdir, not a credential dir.
      if (containsPath(realOrSelf(dir), realOrSelf(real))) return credentialDirRule(dir)
    }
    return undefined
  } catch {
    return undefined
  }
}

function inspect(tool: string, input: unknown, sessionID?: string, base?: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const args = input as Record<string, unknown>
  const sessionBase = base !== undefined && base !== "" ? base : process.cwd()
  if (tool === "shell" || tool === "bash") {
    const workdir = isString(args.workdir) && args.workdir.trim() !== "" ? args.workdir.trim() : ""
    const workdirBase = workdir !== "" ? resolve(sessionBase, expandHome(workdir)) : sessionBase
    if (workdir !== "") {
      const rule = workdirRule(workdirBase)
      if (rule) return `refusing to run a command with a workdir inside ${rule.why}. ${rule.hint ?? FIELD_HINT}`
    }
    const denial = isString(args.command) ? shellDenial(args.command, 0, workdirBase, sessionID) : undefined
    return denial ? `refusing to run a command that touches ${denial.why} (${denial.shown}). ${denial.hint}` : undefined
  }
  if (
    (tool === "opencode_session_rename" ||
      tool === "opencode_session_move" ||
      tool === "session_rename" ||
      tool === "session_move") &&
    isString(args.sessionID) &&
    args.sessionID !== sessionID
  )
    return "refusing to target another session (session isolation); omit sessionID to target the current session"
  const hit = fileDenial(tool, args, sessionID, sessionBase)
  return hit ? `refusing to use ${hit.key} inside ${hit.rule.why}. ${hit.rule.hint ?? FIELD_HINT}` : undefined
}

export default {
  id: "secret-path-guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      const reason = inspect(event.tool, event.input, event.sessionID, ctx.location?.directory)
      if (reason) throw new Error(`Blocked: ${reason}`)
    })
  },
} satisfies Plugin.Plugin
