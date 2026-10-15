// CI guard (borrow C16 / C19). `bun turbo test --affected` exits 0 with "No tasks were executed" when
// no affected package has a test script. That is correct for docs-only changes and wrong when a
// test-bearing package changed: the run would be green with zero tests. This guard only accepts a
// zero-task run when no changed file sits inside a workspace that declares a `test` script, so the
// silent-green shape fails loudly instead.
//
// Usage: bun run script/affected-guard.ts <turbo-log-file>
//   TURBO_SCM_BASE / TURBO_SCM_HEAD must match the values the guarded test run used (CI exports both).

import path from "node:path"

// Returns the workspace directories (relative to root) that contain a changed file and declare a
// `test` script. Walks up from each changed file to the nearest package.json and skips the root
// package (its `test` script is the "do not run tests from root" guard, not a test suite).
export async function testBearingChanged(
  root: string,
  changed: readonly string[],
  exists: (file: string) => Promise<boolean>,
  readScripts: (packageJSON: string) => Promise<Record<string, string> | undefined>,
): Promise<string[]> {
  const offenders = new Set<string>()
  for (const file of changed) {
    let directory = path.dirname(path.resolve(root, file))
    let manifest: string | undefined
    while (directory !== root && directory.startsWith(root)) {
      const candidate = path.join(directory, "package.json")
      if (await exists(candidate)) {
        manifest = candidate
        break
      }
      directory = path.dirname(directory)
    }
    if (manifest === undefined) continue
    const scripts = await readScripts(manifest)
    if (scripts?.test !== undefined) offenders.add(path.relative(root, path.dirname(manifest)))
  }
  return [...offenders].sort()
}

async function changedPaths(root: string, base: string, head: string) {
  const proc = Bun.spawn(["git", "diff", "--name-only", "--no-renames", base, head], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) return { ok: false as const, error: stderr.trim() }
  return { ok: true as const, paths: stdout.split("\n").filter((line) => line !== "") }
}

if (import.meta.main) {
  const log = process.argv[2]
  if (log === undefined) {
    console.error("usage: bun run script/affected-guard.ts <turbo-log-file>")
    process.exit(2)
  }
  const output = await Bun.file(log).text()
  if (!output.includes("No tasks were executed")) {
    console.log("affected guard: the run executed test tasks")
    process.exit(0)
  }
  const base = process.env.TURBO_SCM_BASE
  const head = process.env.TURBO_SCM_HEAD
  if (base === undefined || head === undefined) {
    console.error("affected guard: TURBO_SCM_BASE and TURBO_SCM_HEAD must be set to verify a zero-task run")
    process.exit(1)
  }
  const root = path.resolve(import.meta.dirname, "..")
  const changed = await changedPaths(root, base, head)
  if (!changed.ok) {
    console.error("affected guard: could not diff the guarded range")
    console.error(changed.error)
    process.exit(1)
  }
  const offenders = await testBearingChanged(
    root,
    changed.paths,
    async (file) => Bun.file(file).exists(),
    async (manifest) => {
      const parsed = (await Bun.file(manifest).json()) as { scripts?: Record<string, string> }
      return parsed.scripts
    },
  )
  if (offenders.length > 0) {
    console.error("affected test run executed 0 tasks, but these changed workspaces have test scripts:")
    for (const offender of offenders) console.error(`  - ${offender}`)
    process.exit(1)
  }
  console.log("affected guard: 0 tasks ran and no changed workspace declares a test script")
}
