import { afterEach, describe, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { rejects } from "assert/strict"
import { assertBunVersion, assertForkInvariants, assertForkWiring, assertSyncReady, deleteModifyPaths, installBinary, installTuiConfig, resolveDeleteModifyConflicts } from "./sync-upstream"

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
      "packages/cli/src/index.ts":
        'const Handlers = Runtime.handlers(Commands, {\n  acp: () => import("./commands/handlers/acp"),\n})\n',
      "packages/cli/src/commands/commands.ts": 'commands: [\n  Spec.make("acp", {}),\n  Spec.make("update", {}),\n]\n',
      "packages/cli/src/services/updater.ts": "export const layer = Layer.succeed(Service, Service.of({ enabled: false }))\n",
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

  test("rejects a reintroduced upgrade or uninstall handler file", async () => {
    await rejects(
      assertForkInvariants(await fork({ "packages/cli/src/commands/handlers/upgrade.ts": "export {}\n" })),
      /handlers\/upgrade\.ts exists again/,
    )
    await rejects(
      assertForkInvariants(await fork({ "packages/cli/src/commands/handlers/uninstall.ts": "export {}\n" })),
      /handlers\/uninstall\.ts exists again/,
    )
  })

  test("rejects a re-registered loader", async () => {
    const directory = await fork({
      "packages/cli/src/index.ts":
        'const Handlers = Runtime.handlers(Commands, {\n  upgrade: () => import("./commands/handlers/upgrade"),\n})\n',
    })
    await rejects(assertForkInvariants(directory), /index\.ts loads commands\/handlers\/upgrade/)
  })

  test("rejects a re-registered command spec", async () => {
    const directory = await fork({
      "packages/cli/src/commands/commands.ts": 'commands: [\n  Spec.make("uninstall", {}),\n]\n',
    })
    await rejects(assertForkInvariants(directory), /commands\.ts registers the uninstall command/)
  })

  test("rejects a reintroduced updater network call", async () => {
    const directory = await fork({
      "packages/cli/src/services/updater.ts":
        "const url = `https://opencode.ai/update/api/${channel}/${artifact}/npm`\nfetch(url)\n",
    })
    await rejects(assertForkInvariants(directory), /updater network call site[\s\S]*services\/updater\.ts:1/)
    const installer = await fork({
      "packages/cli/src/services/other.ts": 'const installer = "https://opencode.ai/v2/install"\n',
    })
    await rejects(assertForkInvariants(installer), /services\/other\.ts:1/)
  })
})

describe("delete/modify conflict resolution", () => {
  test("parses only the deleted-by-us entries from porcelain output", () => {
    expect(deleteModifyPaths("DU a.ts\0UU b.ts\0UD c.ts\0")).toEqual(["a.ts"])
    expect(deleteModifyPaths("")).toEqual([])
    expect(deleteModifyPaths("DU with space.txt\0")).toEqual(["with space.txt"])
  })

  test("keeps this fork's deletion on a modify/delete conflict", async () => {
    const directory = await temporary()
    await git(directory, "init", "--initial-branch=main", "--template=")
    await git(directory, "config", "core.hooksPath", "/dev/null")
    await Bun.write(path.join(directory, "deleted-by-us.txt"), "base")
    await Bun.write(path.join(directory, "kept.txt"), "base")
    await git(directory, "add", ".")
    await git(directory, "commit", "-m", "base")
    await git(directory, "checkout", "-b", "upstream")
    await Bun.write(path.join(directory, "deleted-by-us.txt"), "upstream change")
    await git(directory, "commit", "-am", "upstream edit")
    await git(directory, "checkout", "main")
    await git(directory, "rm", "deleted-by-us.txt")
    await git(directory, "commit", "-m", "fork deletes the file")
    await rejects(git(directory, "merge", "--no-edit", "upstream"))
    expect(await git(directory, "status", "--porcelain")).toBe("DU deleted-by-us.txt")
    expect(await resolveDeleteModifyConflicts(directory)).toEqual(["deleted-by-us.txt"])
    expect(await git(directory, "diff", "--name-only", "--diff-filter=U")).toBe("")
    expect(await Bun.file(path.join(directory, "deleted-by-us.txt")).exists()).toBe(false)
  })
})

describe("fork wiring anchors", () => {
  const base: Record<string, string> = {
    "package.json":
      '{"scripts":{"check-single-loop": "bun run script/check-single-loop.ts","check-provider-policy": "bun run script/check-provider-policy.ts","debt-ratchet": "bun run script/debt-ratchet.ts","check-drift": "bun run script/check-drift.ts"}}',
    ".husky/pre-push":
      "bun run check\nbun run check-single-loop\nbun run check-provider-policy\nbun run debt-ratchet\n",
    "packages/core/src/plugin/internal.ts":
      '...ForkPlugin.post\nexport const guarded\n"block-unsafe-kill"\n"secret-path-guard"\n',
    "packages/core/src/plugin/supervisor.ts": "PluginInternal.guarded.has(plugin.id)\n",
    "packages/core/src/plugin/fork/index.ts": "ForkChildAuthorityPlugin\nForkAutonomyPlugin\n",
  }

  async function wired(files: Record<string, string> = {}) {
    const directory = await temporary()
    for (const [file, text] of Object.entries({ ...base, ...files })) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await Bun.write(path.join(directory, file), text)
    }
    return directory
  }

  test("accepts a fully wired fork tree", async () => {
    await assertForkWiring(await wired())
  })

  test("rejects a pre-push hook that lost a gate", async () => {
    await rejects(
      assertForkWiring(await wired({ ".husky/pre-push": "bun run check\nbun run check-single-loop\n" })),
      /pre-push no longer contains "bun run check-provider-policy\\n"/,
    )
  })

  test("rejects a package.json that lost a gate script", async () => {
    await rejects(
      assertForkWiring(await wired({ "package.json": '{"scripts":{"check-drift":"bun run script/check-drift.ts"}}' })),
      /package\.json no longer contains/,
    )
  })

  // The fixtures above encode the needles, so they cannot tell whether a needle still matches the real
  // tree - which is how `internal.ts` kept a needle ("PluginInternal.guarded") the file never contained:
  // it exports `guarded`, and the namespace string lives in supervisor.ts. This case runs the same check
  // against the checkout, so a needle that no longer matches reality fails here instead of at the next sync.
  test("the anchors match the real repository tree", async () => {
    await assertForkWiring(path.resolve(import.meta.dirname, ".."))
  })

  test("rejects a plugin chain that lost its registration or guards", async () => {
    await rejects(
      assertForkWiring(await wired({ "packages/core/src/plugin/internal.ts": "...ForkPlugin.post\n" })),
      /internal\.ts no longer contains "export const guarded"/,
    )
  })
})

describe("toolchain", () => {
  test("accepts bun at or above the V2 minimum and rejects older releases", () => {
    assertBunVersion("1.4.2")
    assertBunVersion("1.4.10")
    assertBunVersion("1.5.0")
    assertBunVersion("2.0.0")
    expect(() => assertBunVersion("1.4.1")).toThrow(/bun >= 1\.4\.2 is required \(found 1\.4\.1\)/)
    expect(() => assertBunVersion("1.3.9")).toThrow(/found 1\.3\.9/)
  })
})

describe("TUI config installation", () => {
  test("prefers the V2 cli.json seed over the legacy tui.json", async () => {
    const root = await temporary()
    const config = path.join(await temporary(), "config")
    await Bun.write(path.join(root, "cli.json"), '{"keybinds":"v2"}')
    await Bun.write(path.join(root, "tui.json"), '{"keybinds":"legacy"}')
    expect(await installTuiConfig(root, config)).toBe(path.join(config, "cli.json"))
    expect(await Bun.file(path.join(config, "cli.json")).text()).toBe('{"keybinds":"v2"}')
    expect(await Bun.file(path.join(config, "tui.json")).exists()).toBe(false)
  })

  test("keeps a seat that already has cli.json: the seed never clobbers local tuning", async () => {
    const root = await temporary()
    const config = path.join(await temporary(), "config")
    await Bun.write(path.join(root, "cli.json"), '{"keybinds":"v2"}')
    await Bun.write(path.join(config, "cli.json"), '{"keybinds":"tuned"}')
    expect(await installTuiConfig(root, config)).toBeUndefined()
    expect(await Bun.file(path.join(config, "cli.json")).text()).toBe('{"keybinds":"tuned"}')
  })

  test("falls back to the repo-root tui.json when no cli.json is present", async () => {
    const root = await temporary()
    const config = path.join(await temporary(), "config")
    await Bun.write(path.join(root, "tui.json"), '{"keybinds":"legacy"}')
    expect(await installTuiConfig(root, config)).toBe(path.join(config, "tui.json"))
    expect(await Bun.file(path.join(config, "tui.json")).text()).toBe('{"keybinds":"legacy"}')
  })

  test("installs nothing when the repo carries neither file", async () => {
    expect(await installTuiConfig(await temporary(), path.join(await temporary(), "config"))).toBeUndefined()
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
    await mkdir(path.join(directory, "packages", "cli"), { recursive: true })
    await mkdir(commands)
    await copyFile(import.meta.dir + "/sync-upstream.ts", path.join(directory, "script", "sync-upstream.ts"))
    await copyFile(import.meta.dir + "/check-single-loop.ts", path.join(directory, "script", "check-single-loop.ts"))
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
if [ "$1" = "test" ]; then
  printf 'test %s\\n' "$PWD" >> "$SYNC_TEST_TRACE"
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
            "cli",
            "dist",
            `cli-${process.platform}-${process.arch}`,
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
    return { code, output, error, directory, trace: await Bun.file(path.join(directory, "trace")).text() }
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
    expect(result.trace).toBe(`install --frozen-lockfile\nbuild\ntest ${result.directory}/script\npush\n`)
    expect(result.error).toContain("test stopped before runtime installation")
  })

  test("preserves the explicit no-rebuild mode", async () => {
    const result = await run({ noRebuild: true })
    expect(result.code).toBe(0)
    expect(result.trace).toBe("push\n")
  })
})
