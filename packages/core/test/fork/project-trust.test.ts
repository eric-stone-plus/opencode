import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ProjectTrust } from "@opencode/core/fork/project-trust"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

describe("ProjectTrust.parseRoots", () => {
  test("accepts one absolute path per line and skips blanks and comments", () => {
    expect(
      ProjectTrust.parseRoots(
        [
          "# operator-declared roots",
          "",
          "/home/eric/dev/repo",
          "   ",
          "  /home/eric/dev/other  ",
          "# a trailing comment line",
        ].join("\n"),
      ),
    ).toEqual({ roots: ["/home/eric/dev/repo", "/home/eric/dev/other"], ignored: [] })
  })

  test("never guesses: relative, glob, and tilde lines are ignored with a reason", () => {
    expect(ProjectTrust.parseRoots(["relative/path", "/repo/*", "~/dev", "/ok"].join("\n"))).toEqual({
      roots: ["/ok"],
      ignored: [
        { line: 1, reason: "not an absolute path" },
        { line: 2, reason: "glob patterns are not supported" },
        { line: 3, reason: "tilde expansion is not supported" },
      ],
    })
  })

  test("dedupes normalized declarations preserving order", () => {
    expect(ProjectTrust.parseRoots(["/a/b/", "/a/b", "/a/b//c", "/a/b/c", "/a/b/c"].join("\n"))).toEqual({
      roots: ["/a/b", "/a/b/c"],
      ignored: [],
    })
  })

  test("absent text is closed and a `#` inside a path is not a comment", () => {
    expect(ProjectTrust.parseRoots(undefined)).toEqual({ roots: [], ignored: [] })
    expect(ProjectTrust.parseRoots("/repo#fragment")).toEqual({ roots: ["/repo#fragment"], ignored: [] })
  })
})

describe("ProjectTrust.allows", () => {
  test("all: true trusts everything; closed trusts nothing", () => {
    expect(ProjectTrust.allows({ all: true, roots: [] }, "/anywhere")).toBe(true)
    expect(ProjectTrust.allows(ProjectTrust.closed, "/")).toBe(false)
    expect(ProjectTrust.allows(ProjectTrust.closed, "/repo")).toBe(false)
  })

  test("the service freezes the declaration: a consumer cannot widen it at run time", () => {
    const service = ProjectTrust.make({ all: false, roots: ["/trusted"] })
    const mutable = service.data as { all: boolean; roots: string[] }
    expect(() => mutable.roots.push("/evil")).toThrow()
    expect(() => {
      mutable.all = true
    }).toThrow()
    expect(service.allows("/evil")).toBe(false)
    expect(service.allows("/trusted/inside")).toBe(true)
  })

  test("a root matches itself and its descendants, never a mere prefix string", () => {
    const data: ProjectTrust.Data = { all: false, roots: ["/a/b"] }
    expect(ProjectTrust.allows(data, "/a/b")).toBe(true)
    expect(ProjectTrust.allows(data, "/a/b/")).toBe(true)
    expect(ProjectTrust.allows(data, "/a/b/c")).toBe(true)
    // `/a/bc` shares the string prefix but is not below `/a/b`.
    expect(ProjectTrust.allows(data, "/a/bc")).toBe(false)
    expect(ProjectTrust.allows(data, "/a")).toBe(false)
    // Traversal cannot climb out of a root.
    expect(ProjectTrust.allows(data, "/a/b/../c")).toBe(false)
    expect(ProjectTrust.allows(data, "/a/b/c/..")).toBe(true)
  })

  test("a path that cannot be resolved is never trusted", async () => {
    await using tmp = await tmpdir()
    const loop = path.join(tmp.path, "loop")
    await fs.mkdir(loop)
    await fs.symlink(path.join(loop, "b"), path.join(loop, "a"))
    await fs.symlink(path.join(loop, "a"), path.join(loop, "b"))
    const data: ProjectTrust.Data = { all: false, roots: [path.join(loop, "a")] }
    // realpath fails with ELOOP: an unresolvable root matches nothing, an
    // unresolvable directory is not trusted.
    expect(ProjectTrust.allows(data, path.join(loop, "a"))).toBe(false)
    expect(ProjectTrust.nearestRoot(data, path.join(loop, "a"))).toBeUndefined()
  })

  test("symlinks resolve on both sides: an escape inside a root is not trusted", async () => {
    await using tmp = await tmpdir()
    const trusted = path.join(tmp.path, "trusted")
    const outside = path.join(tmp.path, "outside")
    await fs.mkdir(path.join(trusted, "sub"), { recursive: true })
    await fs.mkdir(path.join(outside, "sub"), { recursive: true })
    // A link inside the trusted root pointing out must not admit the outside.
    await fs.symlink(outside, path.join(trusted, "escape"))
    // A link outside the root pointing in is trusted at its real location only.
    await fs.symlink(trusted, path.join(outside, "enter"))
    const data: ProjectTrust.Data = { all: false, roots: [trusted] }
    expect(ProjectTrust.allows(data, path.join(trusted, "sub"))).toBe(true)
    expect(ProjectTrust.allows(data, path.join(trusted, "escape"))).toBe(false)
    expect(ProjectTrust.allows(data, path.join(trusted, "escape", "sub"))).toBe(false)
    expect(ProjectTrust.allows(data, outside)).toBe(false)
    expect(ProjectTrust.allows(data, path.join(outside, "enter", "sub"))).toBe(true)
  })

  test("a missing tail cannot hide behind a symlinked parent", async () => {
    await using tmp = await tmpdir()
    const trusted = path.join(tmp.path, "trusted")
    const outside = path.join(tmp.path, "outside")
    await fs.mkdir(trusted, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(trusted, "escape"))
    const data: ProjectTrust.Data = { all: false, roots: [trusted] }
    // The path does not exist yet ("declare before create"), but its parent is a symlink out of the
    // root: the old lexical fallback answered `true` here.
    expect(ProjectTrust.allows(data, path.join(trusted, "escape", "missing"))).toBe(false)
    expect(ProjectTrust.nearestRoot(data, path.join(trusted, "escape", "missing"))).toBeUndefined()
    // A missing path whose existing ancestors stay inside the root is still trusted.
    expect(ProjectTrust.allows(data, path.join(trusted, "missing", "deeper"))).toBe(true)
  })

  test("a root declared through a symlink trusts its real location", async () => {
    await using tmp = await tmpdir()
    const real = path.join(tmp.path, "real")
    const link = path.join(tmp.path, "link")
    await fs.mkdir(path.join(real, "sub"), { recursive: true })
    await fs.symlink(real, link)
    const data: ProjectTrust.Data = { all: false, roots: [link] }
    expect(ProjectTrust.allows(data, path.join(real, "sub"))).toBe(true)
    expect(ProjectTrust.allows(data, link)).toBe(true)
  })
})

describe("ProjectTrust.nearestRoot", () => {
  test("returns the longest matching root so a nested declaration wins deterministically", () => {
    const data: ProjectTrust.Data = { all: false, roots: ["/a", "/a/b", "/a/b/c"] }
    expect(ProjectTrust.nearestRoot(data, "/a/b/c/d")).toBe("/a/b/c")
    expect(ProjectTrust.nearestRoot(data, "/a/b/x")).toBe("/a/b")
    expect(ProjectTrust.nearestRoot(data, "/a/z")).toBe("/a")
    expect(ProjectTrust.nearestRoot(data, "/elsewhere")).toBeUndefined()
    // `all` declares no root, so there is no nearest one.
    expect(ProjectTrust.nearestRoot({ all: true, roots: ["/a"] }, "/a/b")).toBeUndefined()
  })
})

describe("ProjectTrust service", () => {
  const run = (data?: ProjectTrust.Data) =>
    Effect.gen(function* () {
      const trust = yield* ProjectTrust.Service
      return {
        data: trust.data,
        allowed: trust.allows("/repo"),
        nearest: trust.nearestRoot("/repo"),
      }
    }).pipe(Effect.provide(ProjectTrust.layer(data)))

  test("layer defaults to closed: an absent declaration trusts nothing", async () => {
    expect(await Effect.runPromise(run())).toEqual({
      data: { all: false, roots: [] },
      allowed: false,
      nearest: undefined,
    })
  })

  test("layer carries the declared data", async () => {
    expect(await Effect.runPromise(run({ all: false, roots: ["/repo"] }))).toEqual({
      data: { all: false, roots: ["/repo"] },
      allowed: true,
      nearest: "/repo",
    })
  })
})

describe("ProjectTrust statelessness", () => {
  test("nothing is memoized: a symlink created between calls changes the answer", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "target")
    const sub = path.join(target, "sub")
    const elsewhere = path.join(tmp.path, "elsewhere")
    await fs.mkdir(sub, { recursive: true })
    await fs.mkdir(elsewhere, { recursive: true })
    const data: ProjectTrust.Data = { all: false, roots: [target] }
    expect(ProjectTrust.allows(data, sub)).toBe(true)
    // Replace the real directory with a link that leaves the root; a cached
    // decision keyed by the session or the path would still say true.
    await fs.rm(sub, { recursive: true })
    await fs.symlink(elsewhere, sub)
    expect(ProjectTrust.allows(data, sub)).toBe(false)
    expect(ProjectTrust.nearestRoot(data, sub)).toBeUndefined()
  })

  test("the trust path creates no file under an isolated HOME/XDG", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const globalConfig = path.join(home, ".config", "opencode")
    const project = path.join(home, "code", "repo")
    const start = path.join(project, "packages", "core")
    await fs.mkdir(start, { recursive: true })
    await fs.mkdir(path.join(project, ".opencode"), { recursive: true })
    await fs.mkdir(globalConfig, { recursive: true })
    await fs.writeFile(path.join(project, "opencode.json"), "{}")

    const env = Layer.mergeAll(
      LayerNode.compile(FSUtil.node),
      Layer.succeed(Global.Service, Global.make({ home, config: globalConfig })),
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make(start) }, { projectDirectory: AbsolutePath.make(project) }),
        ),
      ),
      ProjectTrust.layer({ all: false, roots: [project] }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* Effect.promise(() => listing(tmp.path))
        const parsed = ProjectTrust.parseRoots(`# declared\n${project}\n`)
        expect(parsed.roots).toEqual([project])
        expect(ProjectTrust.allows({ all: false, roots: parsed.roots }, start)).toBe(true)
        expect(ProjectTrust.nearestRoot({ all: false, roots: parsed.roots }, start)).toBe(project)
        const trust = yield* ProjectTrust.Service
        expect(trust.allows(start)).toBe(true)
        const sources = yield* ConfigDiscovery.discover()
        expect(sources.project.some((item) => item.path === path.join(project, ".opencode") && item.present)).toBe(true)
        const after = yield* Effect.promise(() => listing(tmp.path))
        expect(after).toEqual(before)
      }).pipe(Effect.provide(env)),
    )
  })
})

async function listing(root: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const names: string[] = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    names.push(relative)
    if (entry.isDirectory()) names.push(...(await listing(path.join(root, entry.name), relative)))
  }
  return names.sort()
}
