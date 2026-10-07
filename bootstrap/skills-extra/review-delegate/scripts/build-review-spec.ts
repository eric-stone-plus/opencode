#!/usr/bin/env bun
/**
 * Build the combined review spec for the review-delegate skill.
 *
 *   bun build-review-spec.ts [--from <ref> --to <ref> | --commit <ref>] \
 *     [--repo <dir>] [--exclude <patterns>] [--background-file <path>]
 *
 * Deterministic layer of the combined pipeline: file selection and rule
 * resolution come from `ocr delegate` (no LLM), and this script normalizes
 * both into one ReviewSpec the host agent feeds into the two-axis review:
 *
 *   - `ocr delegate preview --format json` -> file list + ref/mode metadata
 *   - `ocr delegate rule <files> --format json` -> rules grouped by content
 *
 * Every file ocr lists lands in `files` exactly once: reviewable files get
 * ledger "reviewed", excluded files get ledger "skipped" with skip_reason
 * "ocr:<exclude_reason>". When `ocr` is not on PATH, falls back to plain git
 * enumeration (uncommitted + untracked in workspace mode) and says so in
 * `notice`; rule groups are then unavailable.
 */

export type DelegatePreviewFile = {
  path: string
  status: string
  insertions: number
  deletions: number
  exclude_reason?: string
}

export type DelegatePreview = {
  schema_version: string
  mode: string
  repository: string
  from?: string
  to?: string
  merge_base?: string
  commit?: string
  background?: string
  total_files: number
  reviewable_count: number
  excluded_count: number
  total_insertions: number
  total_deletions: number
  reviewable_files: DelegatePreviewFile[]
  excluded_files: DelegatePreviewFile[]
}

export type DelegateRuleGroup = {
  group_id: number
  source: string
  pattern: string
  files: string[]
  rule: string
}

export type DelegateRules = {
  schema_version: string
  groups: DelegateRuleGroup[]
}

export type ReviewSpecFile = {
  path: string
  status: string
  insertions: number
  deletions: number
  ledger: "reviewed" | "skipped"
  skip_reason?: string
}

export type ReviewSpec = {
  schema_version: "1"
  source: "ocr" | "git-fallback"
  notice?: string
  mode: string
  from?: string
  to?: string
  merge_base?: string
  commit?: string
  background?: string
  files: ReviewSpecFile[]
  rule_groups: DelegateRuleGroup[]
}

function parseObject(text: string, ctx: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${ctx}: not valid JSON`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ctx}: expected a JSON object`)
  }
  return value as Record<string, unknown>
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const value = obj[key]
  if (typeof value !== "string") throw new Error(`${ctx}: expected string field "${key}"`)
  return value
}

function requireNumber(obj: Record<string, unknown>, key: string, ctx: string): number {
  const value = obj[key]
  if (typeof value !== "number") throw new Error(`${ctx}: expected number field "${key}"`)
  return value
}

function optionalString(obj: Record<string, unknown>, key: string, ctx: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${ctx}: expected string field "${key}"`)
  return value
}

function requireArray(obj: Record<string, unknown>, key: string, ctx: string): unknown[] {
  const value = obj[key]
  if (!Array.isArray(value)) throw new Error(`${ctx}: expected array field "${key}"`)
  return value
}

function parsePreviewFile(entry: unknown, ctx: string): DelegatePreviewFile {
  if (typeof entry !== "object" || entry === null) throw new Error(`${ctx}: expected an object`)
  const obj = entry as Record<string, unknown>
  return {
    path: requireString(obj, "path", ctx),
    status: requireString(obj, "status", ctx),
    insertions: requireNumber(obj, "insertions", ctx),
    deletions: requireNumber(obj, "deletions", ctx),
    exclude_reason: optionalString(obj, "exclude_reason", ctx),
  }
}

export function parseDelegatePreview(text: string): DelegatePreview {
  const ctx = "ocr delegate preview"
  const obj = parseObject(text, ctx)
  const preview: DelegatePreview = {
    schema_version: requireString(obj, "schema_version", ctx),
    mode: requireString(obj, "mode", ctx),
    repository: requireString(obj, "repository", ctx),
    total_files: requireNumber(obj, "total_files", ctx),
    reviewable_count: requireNumber(obj, "reviewable_count", ctx),
    excluded_count: requireNumber(obj, "excluded_count", ctx),
    total_insertions: requireNumber(obj, "total_insertions", ctx),
    total_deletions: requireNumber(obj, "total_deletions", ctx),
    reviewable_files: requireArray(obj, "reviewable_files", ctx).map((entry, i) =>
      parsePreviewFile(entry, `${ctx} reviewable_files[${i}]`),
    ),
    excluded_files: requireArray(obj, "excluded_files", ctx).map((entry, i) =>
      parsePreviewFile(entry, `${ctx} excluded_files[${i}]`),
    ),
  }
  for (const key of ["from", "to", "merge_base", "commit", "background"] as const) {
    const value = optionalString(obj, key, ctx)
    if (value !== undefined) preview[key] = value
  }
  return preview
}

export function parseDelegateRules(text: string): DelegateRules {
  const ctx = "ocr delegate rule"
  const obj = parseObject(text, ctx)
  const groups = requireArray(obj, "groups", ctx).map((entry, i) => {
    const gctx = `${ctx} groups[${i}]`
    if (typeof entry !== "object" || entry === null) throw new Error(`${gctx}: expected an object`)
    const g = entry as Record<string, unknown>
    const files = requireArray(g, "files", gctx)
    return {
      group_id: requireNumber(g, "group_id", gctx),
      source: requireString(g, "source", gctx),
      pattern: requireString(g, "pattern", gctx),
      files: files.map((f, j) => {
        if (typeof f !== "string") throw new Error(`${gctx} files[${j}]: expected string`)
        return f
      }),
      rule: requireString(g, "rule", gctx),
    }
  })
  return { schema_version: requireString(obj, "schema_version", ctx), groups }
}

/**
 * Normalize delegate output into the ReviewSpec the two-axis review consumes.
 * `files` mirrors ocr's file list one-to-one — reviewable first, then excluded —
 * so the coverage ledger can be anchored on it with every file exactly once.
 * Lying preview counters never win: the file lists are the truth, and any
 * disagreement is surfaced in `notice` instead of thrown.
 */
export function toReviewSpec(
  preview: DelegatePreview,
  rules: DelegateRules | null,
  opts?: { source?: "ocr" | "git-fallback"; notice?: string },
): ReviewSpec {
  const files: ReviewSpecFile[] = []
  for (const f of preview.reviewable_files) {
    files.push({
      path: f.path,
      status: f.status,
      insertions: f.insertions,
      deletions: f.deletions,
      ledger: "reviewed",
    })
  }
  for (const f of preview.excluded_files) {
    files.push({
      path: f.path,
      status: f.status,
      insertions: f.insertions,
      deletions: f.deletions,
      ledger: "skipped",
      skip_reason: `ocr:${f.exclude_reason ?? "excluded"}`,
    })
  }
  const spec: ReviewSpec = {
    schema_version: "1",
    source: opts?.source ?? "ocr",
    mode: preview.mode,
    from: preview.from,
    to: preview.to,
    merge_base: preview.merge_base,
    commit: preview.commit,
    background: preview.background,
    files,
    rule_groups: rules?.groups ?? [],
  }
  const notices = [opts?.notice, counterNotice(preview)]
  const notice = notices.filter((n) => n !== undefined).join(" ")
  if (notice) spec.notice = notice
  return spec
}

/** Diff ocr's summary counters against the file lists; undefined when they agree. */
function counterNotice(preview: DelegatePreview): string | undefined {
  const all = [...preview.reviewable_files, ...preview.excluded_files]
  const sum = (pick: (f: DelegatePreviewFile) => number) => all.reduce((acc, f) => acc + pick(f), 0)
  const expected: [string, number, number][] = [
    ["total_files", preview.total_files, all.length],
    ["reviewable_count", preview.reviewable_count, preview.reviewable_files.length],
    ["excluded_count", preview.excluded_count, preview.excluded_files.length],
    ["total_insertions", preview.total_insertions, sum((f) => f.insertions)],
    ["total_deletions", preview.total_deletions, sum((f) => f.deletions)],
  ]
  const mismatched = expected.filter(([, claimed, actual]) => claimed !== actual)
  if (mismatched.length === 0) return undefined
  const detail = mismatched.map(([key, claimed, actual]) => `${key}=${claimed} vs ${actual} listed`).join(", ")
  return `ocr delegate preview counters disagree with the file lists (${detail}); trusting the file lists`
}

type Args = {
  from?: string
  to?: string
  commit?: string
  repo?: string
  exclude?: string
  backgroundFile?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case "--from":
        args.from = next()
        break
      case "--to":
        args.to = next()
        break
      case "--commit":
        args.commit = next()
        break
      case "--repo":
        args.repo = next()
        break
      case "--exclude":
        args.exclude = next()
        break
      case "--background-file":
        args.backgroundFile = next()
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (args.commit && (args.from || args.to)) throw new Error("use either --commit or --from/--to, not both")
  if ((args.from && !args.to) || (!args.from && args.to)) throw new Error("--from and --to must be used together")
  return args
}

function ocrPreviewArgs(args: Args): string[] {
  const cmd = ["delegate", "preview", "-f", "json"]
  if (args.commit) cmd.push("--commit", args.commit)
  if (args.from && args.to) cmd.push("--from", args.from, "--to", args.to)
  if (args.repo) cmd.push("--repo", args.repo)
  if (args.exclude) cmd.push("--exclude", args.exclude)
  if (args.backgroundFile) cmd.push("--background-file", args.backgroundFile)
  return cmd
}

async function runCapture(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`)
  }
  return stdout
}

const STATUS_LETTER: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "modified",
  U: "modified",
}

/** Map `git diff --name-status -z` / `git show --name-status -z` records to path + status.
 * `-z` keeps paths raw (a plain-text `tab<TAB>and.ts` or `uni-中文.ts` would come
 * back C-quoted and unreadable), and renames come as `status\0old\0new`. */
export function parseNameStatus(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = text.split("\0")
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i] ?? ""
    if (!status) break
    const letter = status.charAt(0)
    const rename = letter === "R" || letter === "C"
    const path = rename ? tokens[i + 2] : tokens[i + 1]
    if (path) out.set(path, STATUS_LETTER[letter] ?? "modified")
    i += rename ? 3 : 2
  }
  return out
}

/** Expand git's abbreviated rename forms to the new path: `dir/{old => new}`, `old => new`. */
function expandRenamePath(path: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`
  return path.includes(" => ") ? (path.split(" => ").pop() ?? path) : path
}

/** Map `git diff --numstat -z` / `git show --numstat -z` records to insertion/deletion counts. */
export function parseNumstat(text: string): Map<string, { insertions: number; deletions: number }> {
  const out = new Map<string, { insertions: number; deletions: number }>()
  const tokens = text.split("\0")
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i] ?? ""
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    // `-z` records are `ins\tdels\tpath` (tabs allowed inside the path); renames
    // leave the path field empty and carry old + new as the next two tokens.
    const path = record.slice(secondTab + 1)
    const key = path === "" ? tokens[i + 2] : expandRenamePath(path)
    if (!key) continue
    const rawInsertions = record.slice(0, firstTab)
    const rawDeletions = record.slice(firstTab + 1, secondTab)
    out.set(key, {
      insertions: rawInsertions === "-" ? 0 : Number(rawInsertions),
      deletions: rawDeletions === "-" ? 0 : Number(rawDeletions),
    })
    if (path === "") i += 2
  }
  return out
}

async function gitCapture(args: string[], cwd: string): Promise<string> {
  return runCapture(["git", ...args], cwd)
}

/**
 * Plain-git fallback: enumerate the change set without ocr. Uncommitted and
 * untracked files count in workspace mode (the /review contract includes
 * untracked). No rule groups and no ocr exclusions — the notice says so.
 */
async function buildFallbackSpec(args: Args): Promise<ReviewSpec> {
  const cwd = args.repo ?? process.cwd()
  const statuses = new Map<string, string>()
  const counts = new Map<string, { insertions: number; deletions: number }>()

  const collect = async (diffArgs: string[]) => {
    const nameStatus = await gitCapture(["diff", "--name-status", "-z", ...diffArgs], cwd)
    for (const [p, s] of parseNameStatus(nameStatus)) statuses.set(p, s)
    const numstat = await gitCapture(["diff", "--numstat", "-z", ...diffArgs], cwd)
    for (const [p, c] of parseNumstat(numstat)) counts.set(p, c)
  }

  let mergeBase: string | undefined
  if (args.commit) {
    const nameStatus = await gitCapture(["show", "--name-status", "--format=", "-z", args.commit], cwd)
    for (const [p, s] of parseNameStatus(nameStatus)) statuses.set(p, s)
    const numstat = await gitCapture(["show", "--numstat", "--format=", "-z", args.commit], cwd)
    for (const [p, c] of parseNumstat(numstat)) counts.set(p, c)
  } else if (args.from && args.to) {
    await collect([`${args.from}...${args.to}`])
    mergeBase = (await gitCapture(["merge-base", args.from, args.to], cwd)).trim()
  } else {
    await collect([])
    await collect(["--cached"])
    const porcelain = await gitCapture(["status", "--porcelain", "-z"], cwd)
    for (const entry of porcelain.split("\0")) {
      if (!entry.startsWith("?? ")) continue
      const path = entry.slice(3)
      if (!path) continue
      statuses.set(path, "added")
    }
  }

  const files: ReviewSpecFile[] = []
  for (const [path, status] of statuses) {
    const count = counts.get(path) ?? { insertions: 0, deletions: 0 }
    files.push({ path, status, insertions: count.insertions, deletions: count.deletions, ledger: "reviewed" })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  const spec: ReviewSpec = {
    schema_version: "1",
    source: "git-fallback",
    notice:
      "ocr not found on PATH; fallback to plain git enumeration (no ocr rule groups, no ocr exclusions). Say so in the review output.",
    mode: args.commit ? "commit" : args.from && args.to ? "range" : "workspace",
    from: args.from,
    to: args.to,
    merge_base: mergeBase,
    commit: args.commit,
    files,
    rule_groups: [],
  }
  return spec
}

async function buildOcrSpec(args: Args): Promise<ReviewSpec> {
  const cwd = args.repo ?? process.cwd()
  const previewText = await runCapture(["ocr", ...ocrPreviewArgs(args)], cwd)
  const preview = parseDelegatePreview(previewText)

  let rules: DelegateRules | null = null
  // Rule resolution covers every ocr-listed file (reviewable + excluded): the
  // host may deliberately review an excluded file (docs, data), and its rule
  // group should already be in the spec when it does. Flags come first and `--`
  // terminates flag parsing, so a path like `--exclude` cannot be eaten by
  // cobra as a flag (or take the next path as its value).
  const listed = [...preview.reviewable_files, ...preview.excluded_files].map((f) => f.path)
  if (listed.length > 0) {
    const ruleArgs = ["delegate", "rule", "-f", "json"]
    if (args.repo) ruleArgs.push("--repo", args.repo)
    if (args.exclude) ruleArgs.push("--exclude", args.exclude)
    if (args.backgroundFile) ruleArgs.push("--background-file", args.backgroundFile)
    ruleArgs.push("--", ...listed)
    rules = parseDelegateRules(await runCapture(["ocr", ...ruleArgs], cwd))
  }
  return toReviewSpec(preview, rules, { source: "ocr" })
}

export async function buildReviewSpec(argv: string[]): Promise<ReviewSpec> {
  const args = parseArgs(argv)
  if (Bun.which("ocr")) return buildOcrSpec(args)
  return buildFallbackSpec(args)
}

if (import.meta.main) {
  try {
    const spec = await buildReviewSpec(process.argv.slice(2))
    console.log(JSON.stringify(spec, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
