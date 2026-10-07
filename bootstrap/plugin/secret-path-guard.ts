import type { Plugin } from "@opencode-ai/plugin"

// Secret-path guard (2026-10-06): the keys stay in $HOME by operator decision,
// so the mechanical closure is "agent file tools never touch credential
// stores". Permission rules alone cannot express this: `read` matches the
// worktree-relative path, but `glob`/`grep` permission resources are the
// QUERY string, not the search path — a path-aware hook is the only layer
// that sees every file tool's paths. Bash-mediated reads (cat, less, …) are
// out of reach of any arg matcher; AGENTS.md's key-hygiene rule covers those
// by instruction, and this guard is the enforcement for the file tools.
//
// Accident-shaped, like block-unsafe-kill: a deliberate `bash cat` bypass is
// the same class the kill-guard declares out of scope.

const DENY: Array<[RegExp, string]> = [
  [/(^|\/)agent-secrets(\/|$)/, "credential store (agent-secrets/)"],
  [/\.claude\/\.api-token$/, "Claude API token"],
  [/\.claude\/\.credentials/, "Claude credentials store"],
  [/(^|\/)auth\.json$/, "provider auth store (auth.json)"],
  [/(^|\/)\.npmrc$/, "npm auth token (.npmrc)"],
  [/\.smbcredentials/, "SMB credentials"],
  [/(^|\/)\.jwt_tool(\/|$)/, "jwt_tool private keys"],
  [/(^|\/)\.grok(\/|$)/, "grok credentials dir"],
  [/(^|\/)\.grokbot(\/|$)/, "grokbot daemon credentials dir"],
  [/(^|\/)Grok Bot(\/|$)/, "Grok Bot secrets dir"],
  [/LarkShell\/(logout_token|sdk_storage(\/|$))/, "LarkShell tokens / client state"],
  [/causeway\/secrets(\/|$)/, "causeway secrets"],
  [/firecrawl-cli\/credentials\.json$/, "firecrawl credentials"],
  [/\.config\/opencode\/env$/, "provider API key env"],
  [/\.config\/claude-env$/, "Anthropic auth token env"],
  [/(^|\/)\.ssh(\/|$)/, "SSH key material"],
  [/(^|\/)\.gnupg(\/|$)/, "GPG private material"],
  [/\.aws\/(credentials|config)$/, "AWS credentials"],
  [/\.docker\/config\.json$/, "registry auth tokens"],
  [/(^|\/)\.git-credentials$/, "git credentials"],
  [/(^|\/)\.netrc$/, "netrc credentials"],
  [/\.config\/gcloud(\/|$)/, "gcloud application-default credentials"],
  [/\.pem$/, "PEM key material"],
  [/(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, "SSH private key"],
  [/(^|\/)agent-secrets\.env$/, "credential env file"],
]

// Args whose values are paths or path-shaped queries (glob `pattern`, grep
// `include`). Query-shaped values only match the deny list when they look
// like the artifact itself (e.g. `*.pem`, `**/auth.json`), never for content
// regexes like `API[_-]?KEY`.
const PATH_ARGS = new Set(["filePath", "filepath", "file_path", "path", "dir", "directory", "pattern", "include"])

function denied(value: string): string | undefined {
  // Normalize to slash form so both `home/eric/...` (slash-less absolute) and
  // real absolute paths hit the same patterns; strip trailing slashes.
  const flat = value.replace(/\\/g, "/").replace(/\/+$/, "")
  for (const [re, why] of DENY) if (re.test(flat)) return why
  return undefined
}

function inspect(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!PATH_ARGS.has(key)) continue
    if (typeof value === "string" && value.length > 0) {
      const why = denied(value)
      if (why) return `refusing to use ${key} inside ${why}. Read credential files by field-targeted filters only when the task truly needs a non-secret field, and never print values.`
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const why = denied(item)
          if (why)
            return `refusing to use ${key} inside ${why}. Read credential files by field-targeted filters only when the task truly needs a non-secret field, and never print values.`
        }
      }
    }
  }
  return undefined
}

export default (async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const reason = inspect(output.args)
      if (reason) throw new Error(`Blocked: ${reason}`)
    },
  }
}) satisfies Plugin
