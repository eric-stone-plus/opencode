import { $ } from "bun"
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import {
  parseDelegatePreview,
  parseDelegateRules,
  parseNameStatus,
  parseNumstat,
  toReviewSpec,
  type ReviewSpec,
} from "../../../../bootstrap/skills-extra/review-delegate/scripts/build-review-spec"

/**
 * Seams under test (agreed scope for this suite):
 *   1. `build-review-spec.ts` parse exports — fixture-pinned delegate JSON schema.
 *   2. `build-review-spec.ts` CLI — argv → ReviewSpec JSON on stdout, live against
 *      real `ocr delegate preview`/`rule` in a scratch git repo, plus graceful
 *      degradation when `ocr` is absent from PATH.
 *   3. Cross-surface contract — review.txt ocr block + SKILL.md finding fields.
 */
const SCRIPT = path.resolve(import.meta.dirname, "../../../../bootstrap/skills-extra/review-delegate/scripts/build-review-spec.ts")
const SKILL = path.resolve(import.meta.dirname, "../../../../bootstrap/skills-extra/review-delegate/SKILL.md")
const FIXTURES = path.resolve(import.meta.dirname, "fixtures")
const REVIEW_TXT = path.resolve(import.meta.dirname, "../../src/command/template/review.txt")

const scratchRoots: string[] = []

async function makeScratch(): Promise<string> {
  const dir = path.join("/tmp/opencode", `review-delegate-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  scratchRoots.push(dir)
  await $`git init -q .`.cwd(dir).quiet()
  await $`git config user.email test@opencode.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
  await fs.writeFile(path.join(dir, "b.md"), "# doc\n")
  await $`git add -A`.cwd(dir).quiet()
  await $`git commit -qm "init: a + b"`.cwd(dir).quiet()
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 2\n")
  await fs.writeFile(path.join(dir, "x.ts"), "export const x = 3\n")
  await fs.writeFile(path.join(dir, "b.md"), "# doc\nmore\n")
  await $`git add -A`.cwd(dir).quiet()
  await $`git commit -qm "second: modify a + b, add x"`.cwd(dir).quiet()
  return dir
}

async function runCli(args: string[], opts?: { env?: Record<string, string>; cwd?: string }) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: opts?.cwd ?? process.cwd(),
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, exitCode }
}

async function runOcr(args: string[], cwd: string) {
  const proc = Bun.spawn(["ocr", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, exitCode }
}

/** PATH with git + bun but no ocr, for fallback-mode runs. */
function restrictedPath(): string {
  return `${path.dirname(Bun.which("git") ?? "/usr/bin/git")}:${path.dirname(process.execPath)}:/bin:/usr/bin`
}

afterAll(async () => {
  for (const dir of scratchRoots) await fs.rm(dir, { recursive: true, force: true })
})

describe("review-delegate delegate JSON parsing (fixture-pinned schema)", () => {
  test("preview-range fixture pins the range-mode shape", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "preview-range.json"), "utf8")
    const preview = parseDelegatePreview(raw)
    expect(preview.mode).toBe("range")
    expect(preview.from).toBe("HEAD~1")
    expect(preview.to).toBe("HEAD")
    expect(preview.merge_base).toMatch(/^[0-9a-f]{40}$/)
    expect(preview.reviewable_count).toBe(2)
    expect(preview.excluded_count).toBe(2)
    expect(preview.reviewable_files.map((f: { path: string }) => f.path)).toEqual(["a.ts", "x.ts"])
    expect(preview.excluded_files.map((f) => [f.path, f.status, f.exclude_reason])).toEqual([
      ["b.md", "modified", "unsupported_ext"],
      ["d.txt", "added", "unsupported_ext"],
    ])
    expect(Object.keys(preview).sort()).toEqual([
      "excluded_count",
      "excluded_files",
      "from",
      "merge_base",
      "mode",
      "repository",
      "reviewable_count",
      "reviewable_files",
      "schema_version",
      "to",
      "total_deletions",
      "total_files",
      "total_insertions",
    ])
  })

  test("preview-commit fixture pins the commit-mode shape (background carries the commit message)", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "preview-commit.json"), "utf8")
    const preview = parseDelegatePreview(raw)
    expect(preview.mode).toBe("commit")
    expect(preview.commit).toBe("HEAD")
    expect(preview.background).toBe("second: modify a + b, add x + d")
    expect(preview.from).toBeUndefined()
    expect(preview.merge_base).toBeUndefined()
    const spec = toReviewSpec(preview, parseDelegateRules(await fs.readFile(path.join(FIXTURES, "rule-groups.json"), "utf8")))
    expect(spec.background).toBe("second: modify a + b, add x + d")
  })

  test("preview-workspace fixture pins the workspace-mode shape (untracked files listed)", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "preview-workspace.json"), "utf8")
    const preview = parseDelegatePreview(raw)
    expect(preview.mode).toBe("workspace")
    expect(preview.from).toBeUndefined()
    expect(preview.to).toBeUndefined()
    expect(preview.commit).toBeUndefined()
    const untracked = preview.excluded_files.find((f: { path: string }) => f.path === "u.txt")
    expect(untracked?.status).toBe("added")
  })

  test("rule-groups fixture pins the rule shape and content grouping", async () => {
    const raw = await fs.readFile(path.join(FIXTURES, "rule-groups.json"), "utf8")
    const rules = parseDelegateRules(raw)
    expect(rules.schema_version).toBe("1")
    expect(rules.groups).toHaveLength(2)
    const [ts, doc] = rules.groups
    expect(Object.keys(ts).sort()).toEqual(["files", "group_id", "pattern", "rule", "source"])
    expect(ts.source).toBe("system")
    expect(ts.pattern).toBe("**/*.{ts,js,tsx,jsx,mjs,cjs}")
    expect(ts.files).toEqual(["a.ts", "src/c.ts"])
    expect(ts.rule).toContain("TypeScript Types")
    expect(doc.pattern).toBe("default")
    expect(doc.files).toEqual(["b.md"])
    expect(doc.rule).toContain("Correctness")
  })

  test("rejects malformed delegate JSON instead of guessing", () => {
    expect(() => parseDelegatePreview("not json")).toThrow()
    expect(() => parseDelegatePreview("{}")).toThrow()
    expect(() => parseDelegateRules("{}")).toThrow()
    expect(() => parseDelegateRules(JSON.stringify({ schema_version: "1", groups: [{ group_id: 1 }] }))).toThrow()
  })

  test("name-status -z records: rename keys the new path, raw paths stay raw", () => {
    const rows = parseNameStatus("M\0a.ts\0R100\0src/oldname.ts\0src/newname.ts\0M\0tab\tinside.ts\0")
    expect(rows.get("a.ts")).toBe("modified")
    expect(rows.get("src/newname.ts")).toBe("renamed")
    expect(rows.has("src/oldname.ts")).toBe(false)
    expect(rows.get("tab\tinside.ts")).toBe("modified")
  })

  test("numstat counts land on the new path for both rename forms", () => {
    const z = parseNumstat("2\t0\t\u0000src/oldname.ts\u0000src/newname.ts\u0000" + "1\t1\ta.ts\u0000")
    expect(z.get("src/newname.ts")).toEqual({ insertions: 2, deletions: 0 })
    expect(z.get("a.ts")).toEqual({ insertions: 1, deletions: 1 })
    const brace = parseNumstat("2\t0\tsrc/{oldname.ts => newname.ts}\u0000")
    expect(brace.get("src/newname.ts")).toEqual({ insertions: 2, deletions: 0 })
    expect(brace.has("src/newname.ts}")).toBe(false)
  })

  test("toReviewSpec anchors the coverage ledger on ocr's file list, each file exactly once", async () => {
    const preview = parseDelegatePreview(await fs.readFile(path.join(FIXTURES, "preview-range.json"), "utf8"))
    const rules = parseDelegateRules(await fs.readFile(path.join(FIXTURES, "rule-groups.json"), "utf8"))
    const spec = toReviewSpec(preview, rules)
    expect(spec.schema_version).toBe("1")
    expect(spec.source).toBe("ocr")
    expect(spec.mode).toBe("range")
    expect(spec.merge_base).toBe(preview.merge_base)
    expect(spec.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.ts", "b.md", "d.txt", "x.ts"])
    expect(new Set(spec.files.map((f: { path: string }) => f.path)).size).toBe(spec.files.length)
    const byPath = new Map(spec.files.map((f) => [f.path, f] as const))
    expect(byPath.get("a.ts")?.ledger).toBe("reviewed")
    expect(byPath.get("x.ts")?.ledger).toBe("reviewed")
    expect(byPath.get("b.md")?.ledger).toBe("skipped")
    expect(byPath.get("b.md")?.skip_reason).toBe("ocr:unsupported_ext")
    expect(byPath.get("d.txt")?.skip_reason).toBe("ocr:unsupported_ext")
    expect(spec.rule_groups).toHaveLength(2)
  })

  test("lying preview counters are distrusted: file lists win and the mismatch is noticed", async () => {
    const lying = JSON.parse(await fs.readFile(path.join(FIXTURES, "preview-range.json"), "utf8"))
    lying.total_files = 99
    lying.reviewable_count = 7
    lying.excluded_count = 0
    lying.total_insertions = 123
    lying.total_deletions = 456
    const spec = toReviewSpec(parseDelegatePreview(JSON.stringify(lying)), null)
    expect(spec.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.ts", "b.md", "d.txt", "x.ts"])
    expect(spec.files.filter((f) => f.ledger === "reviewed")).toHaveLength(2)
    expect(spec.files.filter((f) => f.ledger === "skipped")).toHaveLength(2)
    expect(spec.notice).toMatch(/counters/)
    expect(spec.notice).toMatch(/trusting the file lists/)
    expect(spec.notice).toContain("total_files=99")
  })
})

describe("review-delegate CLI against real ocr in a scratch repo", () => {
  test("preview + rule live output parses to a ReviewSpec with a complete coverage ledger", async () => {
    const dir = await makeScratch()

    const previewLive = await runOcr(["delegate", "preview", "--from", "HEAD~1", "--to", "HEAD", "-f", "json"], dir)
    expect(previewLive.exitCode).toBe(0)
    const preview = parseDelegatePreview(previewLive.stdout)
    expect(preview.mode).toBe("range")

    const reviewablePaths = preview.reviewable_files.map((f: { path: string }) => f.path)
    expect(reviewablePaths).toEqual(["a.ts", "x.ts"])
    const ruleLive = await runOcr(["delegate", "rule", ...reviewablePaths, "-f", "json"], dir)
    expect(ruleLive.exitCode).toBe(0)
    const rules = parseDelegateRules(ruleLive.stdout)
    const tsGroup = rules.groups.find((g: { files: string[] }) => g.files.includes("a.ts"))
    expect(tsGroup?.rule).toContain("TypeScript Types")

    const cli = await runCli(["--from", "HEAD~1", "--to", "HEAD", "--repo", dir], { cwd: dir })
    expect(cli.exitCode).toBe(0)
    const spec = JSON.parse(cli.stdout) as ReviewSpec
    expect(spec.schema_version).toBe("1")
    expect(spec.source).toBe("ocr")
    expect(spec.mode).toBe("range")
    expect(spec.from).toBe("HEAD~1")
    expect(spec.to).toBe("HEAD")
    expect(spec.merge_base).toMatch(/^[0-9a-f]{40}$/)
    expect(spec.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.ts", "b.md", "x.ts"])
    expect(new Set(spec.files.map((f: { path: string }) => f.path)).size).toBe(spec.files.length)
    const byPath = new Map(spec.files.map((f) => [f.path, f] as const))
    expect(byPath.get("a.ts")?.ledger).toBe("reviewed")
    expect(byPath.get("x.ts")?.ledger).toBe("reviewed")
    expect(byPath.get("b.md")?.ledger).toBe("skipped")
    expect(byPath.get("b.md")?.skip_reason).toBe("ocr:unsupported_ext")
    const specTsGroup = spec.rule_groups.find((g: { files: string[] }) => g.files.includes("a.ts"))
    expect(specTsGroup?.rule).toBe(tsGroup?.rule)
    const specDocGroup = spec.rule_groups.find((g: { files: string[] }) => g.files.includes("b.md"))
    expect(specDocGroup?.rule).toContain("Correctness")
  })

  test("workspace mode covers uncommitted changes plus untracked files", async () => {
    const dir = await makeScratch()
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 99\n")
    await fs.writeFile(path.join(dir, "u.txt"), "untracked\n")
    const cli = await runCli(["--repo", dir], { cwd: dir })
    expect(cli.exitCode).toBe(0)
    const spec = JSON.parse(cli.stdout) as ReviewSpec
    expect(spec.source).toBe("ocr")
    expect(spec.mode).toBe("workspace")
    expect(spec.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.ts", "u.txt"])
  })

  test("a file named --exclude still reaches rule groups (path list is flag-inert)", async () => {
    const dir = await makeScratch()
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 3\n")
    await fs.writeFile(path.join(dir, "b.md"), "# doc\nchanged\n")
    await fs.writeFile(path.join(dir, "x.ts"), "export const x = 4\n")
    await fs.writeFile(path.join(dir, "--exclude"), "export const e = 1\n")
    await $`git add -A`.cwd(dir).quiet()
    await $`git commit -qm "touch all four incl. --exclude"`.cwd(dir).quiet()

    const cli = await runCli(["--from", "HEAD~1", "--to", "HEAD", "--repo", dir], { cwd: dir })
    expect(cli.exitCode).toBe(0)
    const spec = JSON.parse(cli.stdout) as ReviewSpec
    const listed = spec.files.map((f: { path: string }) => f.path)
    expect(listed.sort()).toEqual(["--exclude", "a.ts", "b.md", "x.ts"])
    const grouped = spec.rule_groups.flatMap((g: { files: string[] }) => g.files)
    for (const p of listed) expect(grouped).toContain(p)
  })
})

describe("review-delegate graceful degradation without ocr", () => {
  test("PATH without ocr falls back to git enumeration and says so", async () => {
    const dir = await makeScratch()
    await fs.writeFile(path.join(dir, "u.txt"), "untracked\n")
    const restricted = restrictedPath()
    expect(Bun.which("ocr", { PATH: restricted })).toBeNull()

    const range = await runCli(["--from", "HEAD~1", "--to", "HEAD", "--repo", dir], {
      cwd: dir,
      env: { PATH: restricted },
    })
    expect(range.exitCode).toBe(0)
    const spec = JSON.parse(range.stdout) as ReviewSpec
    expect(spec.source).toBe("git-fallback")
    expect(spec.notice).toMatch(/fallback/i)
    expect(spec.notice).toMatch(/ocr/i)
    // Range semantics mirror ocr/`git diff <from>...<to>`: committed changes only.
    expect(spec.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.ts", "b.md", "x.ts"])
    expect(new Set(spec.files.map((f: { path: string }) => f.path)).size).toBe(spec.files.length)
    for (const f of spec.files) {
      expect(f.ledger).toBe("reviewed")
      expect(f.skip_reason).toBeUndefined()
    }
    expect(spec.rule_groups).toEqual([])
    expect(spec.merge_base).toMatch(/^[0-9a-f]{40}$/)

    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 42\n")
    const workspace = await runCli(["--repo", dir], { cwd: dir, env: { PATH: restricted } })
    expect(workspace.exitCode).toBe(0)
    const wsSpec = JSON.parse(workspace.stdout) as ReviewSpec
    expect(wsSpec.mode).toBe("workspace")
    expect(wsSpec.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.ts", "u.txt"])
  })

  test("fallback keeps tab/unicode paths raw and attributes rename counts to the new path", async () => {
    const dir = await makeScratch()
    await fs.writeFile(path.join(dir, "tab\tinside.ts"), "export const t = 1\n")
    await fs.writeFile(path.join(dir, "uni-中文.ts"), "export const u = 1\n")
    await fs.mkdir(path.join(dir, "src"))
    await fs.writeFile(path.join(dir, "src", "oldname.ts"), Array.from({ length: 10 }, (_, i) => `export const line${i} = ${i}\n`).join(""))
    await $`git add -A`.cwd(dir).quiet()
    await $`git commit -qm "add weird names"`.cwd(dir).quiet()
    await $`git mv src/oldname.ts src/newname.ts`.cwd(dir).quiet()
    await fs.writeFile(path.join(dir, "src", "newname.ts"), Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i}\n`).join(""))
    await fs.writeFile(path.join(dir, "tab\tinside.ts"), "export const t = 1\nexport const t2 = 2\n")
    await fs.writeFile(path.join(dir, "uni-中文.ts"), "export const u = 1\nexport const u2 = 2\n")
    await $`git add -A`.cwd(dir).quiet()
    await $`git commit -qm "rename + edit"`.cwd(dir).quiet()
    await fs.writeFile(path.join(dir, "new\tuni-新.ts"), "export const n = 1\n")

    const restricted = restrictedPath()

    const range = await runCli(["--from", "HEAD~1", "--to", "HEAD", "--repo", dir], { cwd: dir, env: { PATH: restricted } })
    expect(range.exitCode).toBe(0)
    const spec = JSON.parse(range.stdout) as ReviewSpec
    const byPath = new Map(spec.files.map((f) => [f.path, f] as const))
    expect([...byPath.keys()].sort()).toEqual(["src/newname.ts", "tab\tinside.ts", "uni-中文.ts"])
    expect(byPath.get("tab\tinside.ts")?.status).toBe("modified")
    expect(byPath.get("tab\tinside.ts")?.insertions).toBe(1)
    expect(byPath.get("uni-中文.ts")?.status).toBe("modified")
    expect(byPath.get("src/newname.ts")?.status).toBe("renamed")
    expect(byPath.get("src/newname.ts")?.insertions).toBe(2)
    expect(byPath.get("src/newname.ts")?.deletions).toBe(0)

    const ws = await runCli(["--repo", dir], { cwd: dir, env: { PATH: restricted } })
    expect(ws.exitCode).toBe(0)
    const wsSpec = JSON.parse(ws.stdout) as ReviewSpec
    expect(wsSpec.files.map((f: { path: string }) => f.path)).toContain("new\tuni-新.ts")
  })
})

describe("review-delegate skill surfaces stay consistent with /review", () => {
  test("SKILL.md exists with the combined-pipeline frontmatter", async () => {
    const skill = await fs.readFile(SKILL, "utf8")
    expect(skill).toContain("name: review-delegate")
    expect(skill).toContain("ocr delegate preview")
    expect(skill).toContain("ocr delegate rule")
    expect(skill).toContain("fallback")
  })

  test("SKILL.md findings contract names every review.txt finding field", async () => {
    const skill = await fs.readFile(SKILL, "utf8")
    const template = await fs.readFile(REVIEW_TXT, "utf8")
    for (const field of ["file", "line", "severity", "category", "title", "description", "fix"]) {
      expect(template).toContain(`**${field}**`)
      expect(skill).toContain(`**${field}**`)
    }
    for (const token of ["high | med | low", "bug | security | behavior-change | structure | performance", "approve | approve-with-nits | needs-fixes"]) {
      expect(skill).toContain(token)
    }
    expect(skill).toContain("exactly once")
  })

  test("SKILL.md mandates escalating behavior-change signal in excluded files", async () => {
    const skill = await fs.readFile(SKILL, "utf8")
    expect(skill).toContain("behavior-change signal")
    expect(skill).toContain("MUST review it")
    expect(skill).toContain("never `skipped`")
  })

  test("review.txt carries the ocr delegate block and stays in sync with the core copy", async () => {
    const template = await fs.readFile(REVIEW_TXT, "utf8")
    expect(template).toContain("ocr delegate preview")
    expect(template).toContain("ocr delegate rule")
    expect(template).toContain("not on PATH")
    expect(template).toContain("every listed file")
    expect(template).not.toContain("over those files")
    const core = await fs.readFile(path.resolve(import.meta.dirname, "../../../core/src/plugin/command/review.txt"), "utf8")
    expect(core).toBe(template)
  })
})
