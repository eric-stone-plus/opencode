import { afterEach, describe, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { rejects } from "assert/strict"
import { assertForkInvariants, assertSyncReady, installBinary } from "./sync-upstream"

const directories: string[] = []
const gitBinary = Bun.which("git")!

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-sync-test-"))
  directories.push(directory)
  return directory
}

async function git(directory: string, ...args: string[]) {
  const proc = Bun.spawn([gitBinary, ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "sync test",
      GIT_AUTHOR_EMAIL: "sync@example.test",
      GIT_COMMITTER_NAME: "sync test",
      GIT_COMMITTER_EMAIL: "sync@example.test",
    },
  })
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(error)
  return output.trim()
}

async function repository() {
  const directory = await temporary()
  await git(directory, "init", "--initial-branch=main", "--template=")
  await git(directory, "config", "core.hooksPath", "/dev/null")
  await Bun.write(path.join(directory, ".gitignore"), "script/\npackages/\nbin/\nhome/\ntrace\n")
  await Bun.write(path.join(directory, "tracked"), "base")
  await git(directory, "add", ".")
  await git(directory, "commit", "-m", "base")
  await git(directory, "update-ref", "refs/remotes/upstream/dev", "HEAD")
  return directory
}

describe("sync preflight", () => {
  test("allows a clean main after the merge", async () => {
    await assertSyncReady(await repository(), true)
  })

  test("rejects uncommitted files even when continuing", async () => {
    const directory = await repository()
    await Bun.write(path.join(directory, "tracked"), "uncommitted")
    await rejects(assertSyncReady(directory, true), /Working tree is dirty/)
  })

  test("rejects another branch and detached HEAD when continuing", async () => {
    const directory = await repository()
    await git(directory, "checkout", "-b", "another")
    await rejects(assertSyncReady(directory, true), /Continue sync from main/)
    await git(directory, "checkout", "--detach")
    await rejects(assertSyncReady(directory, true), /detached HEAD/)
  })

  test("rejects a main that does not yet contain the upstream commit", async () => {
    const directory = await repository()
    await git(directory, "checkout", "-b", "upstream-tip")
    await git(directory, "commit", "--allow-empty", "-m", "upstream")
    await git(directory, "update-ref", "refs/remotes/upstream/dev", "HEAD")
    await git(directory, "checkout", "main")
    await rejects(assertSyncReady(directory, true), /Merge of upstream\/dev into main is not complete/)
  })

  test("detects rebase state through a linked worktree gitdir", async () => {
    const directory = await repository()
    const linked = path.join(await temporary(), "linked")
    await git(directory, "worktree", "add", "-b", "linked", linked)
    await mkdir(path.resolve(linked, await git(linked, "rev-parse", "--git-path", "rebase-merge")))
    await rejects(assertSyncReady(linked, true), /A rebase is in progress; this script merges/)
  })

  test("rejects an uncommitted merge", async () => {
    const directory = await repository()
    await Bun.write(path.resolve(directory, await git(directory, "rev-parse", "--git-path", "MERGE_HEAD")), "0".repeat(40))
    await rejects(assertSyncReady(directory, false), /Finish the merge first/)
  })
})

describe("fork invariants after the upstream merge", () => {
  // Real repository with packages/ tracked: the guard greps committed content.
  async function fork(files: Record<string, string>) {
    const directory = await temporary()
    await git(directory, "init", "--initial-branch=main", "--template=")
    await git(directory, "config", "core.hooksPath", "/dev/null")
    const base: Record<string, string> = {
      "packages/opencode/src/index.ts": 'import { ServeCommand } from "./cli/cmd/serve"\ncli.command(ServeCommand)\n',
      "packages/opencode/src/installation/index.ts":
        'upgrade: Effect.fn("Installation.upgrade")(function* () {})\nexport const upgrade = (...a) => runPromise((s) => s.upgrade(...a))\n',
      "packages/opencode/src/cli/upgrade.ts": "export async function upgrade() {}\n",
      ...files,
    }
    for (const [file, text] of Object.entries(base)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await Bun.write(path.join(directory, file), text)
    }
    await git(directory, "add", ".")
    await git(directory, "commit", "-m", "fork")
    return directory
  }

  test("accepts the fork's current shape", async () => {
    await assertForkInvariants(await fork({}))
  })

  test("rejects a reintroduced upgrade or web command file", async () => {
    await rejects(
      assertForkInvariants(await fork({ "packages/opencode/src/cli/cmd/upgrade.ts": "export {}\n" })),
      /cli\/cmd\/upgrade\.ts exists again/,
    )
    await rejects(
      assertForkInvariants(await fork({ "packages/opencode/src/cli/cmd/web.ts": "export {}\n" })),
      /cli\/cmd\/web\.ts exists again/,
    )
  })

  test("rejects a re-registered command", async () => {
    const directory = await fork({
      "packages/opencode/src/index.ts": 'import { WebCommand } from "./cli/cmd/web"\ncli.command(WebCommand)\n',
    })
    await rejects(assertForkInvariants(directory), /index\.ts references WebCommand/)
  })

  test("rejects a reintroduced Installation.upgrade call site", async () => {
    const directory = await fork({
      "packages/opencode/src/cli/upgrade.ts": "export async function upgrade() {\n  await Installation.upgrade(method, latest)\n}\n",
    })
    await rejects(assertForkInvariants(directory), /Installation\.upgrade call site[\s\S]*cli\/upgrade\.ts:2/)
    const service = await fork({
      "packages/opencode/src/server/global.ts": "const r = yield* installation.upgrade(method, target)\n",
    })
    await rejects(assertForkInvariants(service), /server\/global\.ts:1/)
  })
})

describe("binary installation", () => {
  test("replaces the path without modifying the old open inode", async () => {
    const directory = await temporary()
    const source = path.join(directory, "built")
    const destination = path.join(directory, "bin", "opencode")
    await Bun.write(source, "new binary")
    await Bun.write(destination, "old binary")
    const old = await open(destination, "r")
    try {
      await installBinary(source, destination)
      expect(await old.readFile("utf8")).toBe("old binary")
      expect(await Bun.file(destination).text()).toBe("new binary")
      expect((await stat(destination)).mode & 0o777).toBe(0o755)
      expect(await readdir(path.dirname(destination))).toEqual(["opencode"])
    } finally {
      await old.close()
    }
  })

  test("preserves the installed binary when staging fails", async () => {
    const directory = await temporary()
    const destination = path.join(directory, "bin", "opencode")
    await Bun.write(destination, "old binary")
    await rejects(installBinary(path.join(directory, "missing"), destination))
    expect(await Bun.file(destination).text()).toBe("old binary")
    expect(await readdir(path.dirname(destination))).toEqual(["opencode"])
  })
})

describe("sync validation order", () => {
  // The copied CLI operates only inside a temporary repository. Fake package
  // and push commands record their calls; no network, build, or real install.
  async function run(input: { fail?: "install" | "build"; noRebuild?: boolean }) {
    const directory = await repository()
    const commands = path.join(directory, "bin")
    await mkdir(path.join(directory, "script"))
    await mkdir(path.join(directory, "packages", "opencode"), { recursive: true })
    await mkdir(commands)
    await copyFile(import.meta.dir + "/sync-upstream.ts", path.join(directory, "script", "sync-upstream.ts"))
    await Bun.write(
      path.join(commands, "git"),
      `#!/bin/sh
if [ "$1" = "push" ]; then
  printf 'push\\n' >> "$SYNC_TEST_TRACE"
  [ "$SYNC_TEST_STOP_AT_PUSH" = "1" ] && echo 'test stopped before runtime installation' >&2 && exit 73
  exit 0
fi
exec "$SYNC_TEST_GIT" "$@"
`,
    )
    await Bun.write(
      path.join(commands, "bun"),
      `#!/bin/sh
if [ "$1" = "install" ]; then
  printf 'install %s\\n' "$2" >> "$SYNC_TEST_TRACE"
  [ "$SYNC_TEST_FAIL" = "install" ] && exit 71
  exit 0
fi
printf 'build\\n' >> "$SYNC_TEST_TRACE"
[ "$SYNC_TEST_FAIL" = "build" ] && exit 72
mkdir -p "$SYNC_TEST_BINARY_DIR"
printf '#!/bin/sh\\necho test-version\\n' > "$SYNC_TEST_BINARY_DIR/opencode"
chmod +x "$SYNC_TEST_BINARY_DIR/opencode"
`,
    )
    await chmod(path.join(commands, "git"), 0o755)
    await chmod(path.join(commands, "bun"), 0o755)
    const proc = Bun.spawn(
      [
        process.execPath,
        path.join(directory, "script", "sync-upstream.ts"),
        "--continue",
        ...(input.noRebuild ? ["--no-rebuild"] : []),
      ],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${commands}:${process.env.PATH}`,
          SYNC_TEST_GIT: gitBinary,
          SYNC_TEST_TRACE: path.join(directory, "trace"),
          SYNC_TEST_FAIL: input.fail ?? "",
          SYNC_TEST_STOP_AT_PUSH: input.noRebuild ? "0" : "1",
          SYNC_TEST_BINARY_DIR: path.join(
            directory,
            "packages",
            "opencode",
            "dist",
            `opencode-${process.platform}-${process.arch}`,
            "bin",
          ),
        },
      },
    )
    const [output, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, output, error, trace: await Bun.file(path.join(directory, "trace")).text() }
  }

  test("does not push or install a binary when dependencies fail", async () => {
    const result = await run({ fail: "install" })
    expect(result.code).toBe(1)
    expect(result.trace).toBe("install --frozen-lockfile\n")
    expect(result.error).toContain("Dependency install failed")
  })

  test("does not push or install a binary when the build fails", async () => {
    const result = await run({ fail: "build" })
    expect(result.code).toBe(1)
    expect(result.trace).toBe("install --frozen-lockfile\nbuild\n")
    expect(result.error).toContain("Build failed")
  })

  test("pushes only after dependency and build validation", async () => {
    const result = await run({})
    expect(result.code).toBe(1)
    expect(result.trace).toBe("install --frozen-lockfile\nbuild\npush\n")
    expect(result.error).toContain("test stopped before runtime installation")
  })

  test("preserves the explicit no-rebuild mode", async () => {
    const result = await run({ noRebuild: true })
    expect(result.code).toBe(0)
    expect(result.trace).toBe("push\n")
  })
})
