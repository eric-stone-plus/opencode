// NAMES-ONLY contract (ADR 0010): the bootstrap bundle ships variable names and placeholders, never
// values. A re-seeded template is the one path by which a live provider key could enter this
// repository, and nothing else scans for it - `check` is lint plus typecheck, the other gates read
// code and policy, and bootstrap/verify.sh inspects the installed seat rather than the tracked files.
// The patterns are the redaction layer's own, so a value this gate accepts is a value the HTTP
// recorder would also fail to redact.
//
// Usage:
//   bun run check-names-only
//
// Exit 1 when a tracked bootstrap/config file carries something that looks like a credential, when a
// seed file stops shipping names and placeholders, or when the config mirror grows an apiKey line.

import path from "node:path"
import { SECRET_PATTERNS } from "../packages/http-recorder/src/redaction/secrets"

// Values that are legitimately not secret in a seed file: the DB pin and the input-method names.
const ALLOWED_SEED_VALUES = new Set(["opencode-main.db", "fcitx", "@im=fcitx", "ibus"])
const SEED_FILES = ["auth.json.template", "env.template"]

export async function checkNamesOnly(root: string): Promise<string[]> {
  const directory = path.join(root, "bootstrap", "config")
  const problems: string[] = []
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })].sort()

  for (const file of files) {
    const text = await Bun.file(path.join(directory, file)).text()
    for (const { label, pattern } of SECRET_PATTERNS)
      if (pattern.test(text)) problems.push(`bootstrap/config/${file} looks like it carries a ${label}`)

    // auth.json is re-seeded by hand, so its one failure mode is a real key left in the placeholder's place.
    if (file === "auth.json.template")
      for (const [index, line] of text.split("\n").entries()) {
        const value = /^\s*"key"\s*:\s*"(.*?)"\s*,?\s*$/.exec(line)?.[1]
        if (value !== undefined && !value.startsWith("REPLACE_ME"))
          problems.push(`bootstrap/config/${file}:${index + 1} ships a key value; templates carry REPLACE_ME placeholders`)
      }

    if (SEED_FILES.includes(file) || file.startsWith("environment.d/"))
      for (const [index, line] of text.split("\n").entries()) {
        const value = /^(?:export\s+)?[A-Z][A-Z0-9_]*=(.*)$/.exec(line.trim())?.[1]?.replace(/^["']|["']$/g, "")
        if (value === undefined || value === "" || ALLOWED_SEED_VALUES.has(value)) continue
        problems.push(`bootstrap/config/${file}:${index + 1} ships a value (${value.length} chars); seed files carry names only`)
      }
  }

  const config = await Bun.file(path.join(directory, "opencode.jsonc")).text()
  if (/apiKey/i.test(config)) problems.push("bootstrap/config/opencode.jsonc carries an apiKey line; keys live in auth.json")

  return problems
}

if (import.meta.main) {
  const problems = await checkNamesOnly(path.resolve(import.meta.dirname, ".."))
  if (problems.length > 0) {
    console.error("NAMES-ONLY contract failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error("\nThe bootstrap bundle ships names and placeholders; values stay on the machine (ADR 0010).")
    process.exit(1)
  }
  console.log("NAMES-ONLY contract holds (bootstrap/config)")
}
