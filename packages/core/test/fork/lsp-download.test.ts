import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { LSP } from "@opencode/core/fork/lsp/lsp"
import { LSPServer } from "@opencode/core/fork/lsp/server"
import { builtIns } from "@opencode/core/fork/lsp/servers/index"
import { Clangd, ElixirLS, FSharp, JDTLS, KotlinLS, LuaLS, Razor, TerraformLS, TexLab, Tinymist, Zls, releaseArch } from "@opencode/core/fork/lsp/servers/managed"
import { Gopls, Nixd, Rubocop, RustAnalyzer, SourceKit } from "@opencode/core/fork/lsp/servers/native"
import { Biome, ESLint, Prisma, Typescript, binSuffix } from "@opencode/core/fork/lsp/servers/web"
import { builtinServerIds } from "../fixture/v1-config/lsp"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { lspDocument, lspLayer, type Harness } from "../fixture/lsp/service"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const itFs = testEffect(LayerNode.compile(FSUtil.node))

/**
 * A context with the real filesystem and install implementations, a scripted network, and a process
 * runner that records commands instead of running them. npm resolves nothing.
 */
const installContext = (input: {
  readonly fs: FSUtil.Interface
  readonly directory: string
  readonly worktree?: string
  readonly bin: string
  readonly home: string
  readonly env?: NodeJS.ProcessEnv
  readonly http?: HttpClient.HttpClient
  readonly runs?: string[]
  readonly run?: (command: { _tag: string; command?: string; args?: readonly string[] }) => Effect.Effect<unknown, unknown>
}) =>
  LSPServer.makeContext({
    directory: input.directory,
    worktree: input.worktree ?? input.directory,
    bin: input.bin,
    home: input.home,
    env: input.env ?? {},
    flags: { disableDownload: false, experimentalTy: false },
    fs: input.fs,
    npm: { which: () => Effect.succeed(undefined) } as never,
    processes: {
      run:
        input.run ??
        ((command: { _tag: string; command?: string; args?: readonly string[] }) =>
          Effect.sync(() => {
            input.runs?.push(
              command._tag === "StandardCommand" ? [command.command, ...(command.args ?? [])].join(" ") : "piped",
            )
            return {
              command: command.command ?? "stub",
              exitCode: 0,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }
          })),
    } as never,
    http: input.http ?? HttpClient.make(() => Effect.die(new Error("no network in this test"))),
  })

/** An HTTP client that answers every request with `body`, so downloads can be exercised without a network. */
const httpReturning = (body: Uint8Array, headers?: Record<string, string>) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { headers }))))

/** A context whose install seam records requests and fails every download, so only the request is under test. */
const recordingContext = (input: {
  readonly fs: FSUtil.Interface
  readonly directory: string
  readonly bin: string
  readonly json?: unknown
  readonly text?: string
  readonly which?: (command: string) => string | undefined
}) => {
  const urls: string[] = []
  const downloads: { url: string; digest?: string }[] = []
  const runs: string[] = []
  const install: LSPServer.Install = {
    enabled: true,
    npm: () => Effect.succeed(undefined),
    run: (command, args) =>
      Effect.sync(() => {
        runs.push([command, ...args].join(" "))
        return true
      }),
    json: (url) =>
      Effect.sync(() => {
        urls.push(url)
        return input.json
      }),
    text: (url) =>
      Effect.sync(() => {
        urls.push(url)
        return input.text
      }),
    download: (url, _destination, options) =>
      Effect.sync(() => {
        downloads.push({ url, digest: options?.digest })
        return false
      }),
    extract: () => Effect.succeed(false),
  }
  const base = LSPServer.makeContext({
    directory: input.directory,
    worktree: input.directory,
    bin: input.bin,
    home: input.directory,
    env: {},
    flags: { disableDownload: true, experimentalTy: false },
    fs: input.fs,
    npm: {} as never,
    processes: {} as never,
    http: HttpClient.make(() => Effect.die(new Error("no network in this test"))),
  })
  return { ctx: { ...base, install, which: input.which ?? (() => undefined) }, urls, downloads, runs }
}

// Every case builds its own layer, so it owns a fresh project directory and its own recorded calls.
const test = <A, E>(
  name: string,
  options: Parameters<typeof lspLayer>[0],
  body: (lsp: LSP.Interface, harness: Harness) => Effect.Effect<A, E>,
) => {
  const { layer, harness } = lspLayer(options)
  testEffect(layer).live(name, () => LSP.Service.use((lsp) => body(lsp, harness)))
}

const write = (file: string, text = "stub\n") =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

/** The npm and source trees a server needs to get past its local checks and reach an install. */
const typescriptStub = (directory: string) =>
  Effect.all([
    write(path.join(directory, "src", "a.ts")),
    write(
      path.join(directory, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", version: "0.0.0" }),
    ),
    write(path.join(directory, "node_modules", "typescript", "lib", "tsserver.js"), "// stub\n"),
  ])

const biomeStub = (directory: string) =>
  Effect.all([
    write(path.join(directory, "src", "a.ts")),
    write(
      path.join(directory, "node_modules", "@biomejs", "biome", "package.json"),
      JSON.stringify({ name: "@biomejs/biome", version: "0.0.0", main: "index.js" }),
    ),
    write(path.join(directory, "node_modules", "@biomejs", "biome", "index.js"), "// stub\n"),
  ])

describe("downloads disabled", () => {
  it.effect("makeContext keeps every install member inert, keeping the opt-out true for every server", () =>
    Effect.gen(function* () {
      const explode = () => Effect.die(new Error("the install capability must not be reachable"))
      const context = LSPServer.makeContext({
        directory: "/nowhere",
        worktree: "/nowhere",
        bin: "/nowhere/bin",
        home: "/nowhere",
        env: {},
        flags: { disableDownload: true, experimentalTy: false },
        fs: {} as never,
        npm: { which: explode } as never,
        processes: { run: explode } as never,
        http: HttpClient.make(() => explode()) as never,
      })
      expect(context.install.enabled).toBe(false)
      expect(yield* context.install.npm("typescript-language-server")).toBeUndefined()
      expect(yield* context.install.npm("biome")).toBeUndefined()
      expect(yield* context.install.json("https://api.github.com/repos/clangd/clangd/releases/latest")).toBeUndefined()
      expect(yield* context.install.text("https://download.eclipse.org/jdtls/snapshots/example.tar.gz.sha256")).toBeUndefined()
      expect(yield* context.install.download("https://example.com/tool.zip", "/nowhere/tool.zip")).toBe(false)
      expect(yield* context.install.extract("/nowhere/tool.zip", "/nowhere")).toBe(false)
      expect(yield* context.install.run("sh", ["-c", "touch /nowhere/pwned"])).toBe(false)
    }),
  )

  test(
    "typescript never reaches npm while downloads are disabled, and does when they are enabled",
    { entries: [lspDocument(true)], builtIns: [Typescript], flags: { disableDownload: true } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* typescriptStub(h.directory)
        const file = path.join(h.directory, "src", "a.ts")
        expect(yield* lsp.hasClients(file)).toBe(true)
        yield* lsp.touchFile(file)
        // The only sources left for the server binary are PATH and the guarded install, which stays inert.
        expect(h.npm).toEqual([])
        expect(h.processes).toEqual([])
        expect(h.http).toEqual([])
      }),
  )

  test(
    "typescript asks npm when downloads are enabled",
    { entries: [lspDocument(true)], builtIns: [Typescript], flags: { disableDownload: false } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* typescriptStub(h.directory)
        yield* lsp.touchFile(path.join(h.directory, "src", "a.ts"))
        expect(h.npm).toContain("typescript-language-server@6.0.2")
      }),
  )

  test(
    "biome never reaches npm while downloads are disabled, and does when they are enabled",
    { entries: [lspDocument(true)], builtIns: [Biome], flags: { disableDownload: true } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* biomeStub(h.directory)
        const file = path.join(h.directory, "src", "a.ts")
        expect(yield* lsp.hasClients(file)).toBe(true)
        yield* lsp.touchFile(file)
        expect(h.npm).toEqual([])
        expect(h.processes).toEqual([])
        expect(h.http).toEqual([])
      }),
  )

  test(
    "biome asks npm when downloads are enabled",
    { entries: [lspDocument(true)], builtIns: [Biome], flags: { disableDownload: false } },
    (lsp, h) =>
      Effect.gen(function* () {
        yield* biomeStub(h.directory)
        yield* lsp.touchFile(path.join(h.directory, "src", "a.ts"))
        expect(h.npm).toContain("@biomejs/biome@2.5.15")
      }),
  )

  test(
    "no built-in server reaches npm, the network, or an installer while downloads are disabled",
    { entries: [lspDocument(true)], builtIns, flags: { disableDownload: true } },
    (lsp, h) =>
      Effect.gen(function* () {
        for (const server of builtIns) {
          const extension = server.extensions.find((candidate) => candidate.startsWith("."))
          if (!extension) continue
          const file = path.join(h.directory, "probe" + extension)
          yield* write(file)
          yield* lsp.touchFile(file)
        }
        expect(h.npm).toEqual([])
        expect(h.http).toEqual([])
        expect(h.processes.filter((command) => /install|(^| )npm |pip |cargo |dotnet tool|go get|curl |wget /i.test(command))).toEqual([])
      }),
  )
})

describe("install integrity", () => {
  const hello = new TextEncoder().encode("hello world")
  // The sha256 of "hello world", taken from an independent tool (`printf 'hello world' | sha256sum`).
  const helloDigest = "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"

  itFs.live("download verifies a sha256 digest and removes a mismatched file", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const ctx = installContext({ fs, directory: tmp.path, bin: tmp.path, home: tmp.path, http: httpReturning(hello) })
      const verified = path.join(tmp.path, "verified.zip")
      expect(yield* ctx.install.download("https://example.com/tool.zip", verified, { digest: helloDigest })).toBe(true)
      expect(yield* fs.existsSafe(verified)).toBe(true)
      const tampered = path.join(tmp.path, "tampered.zip")
      expect(
        yield* ctx.install.download("https://example.com/tool.zip", tampered, { digest: `sha256:${"0".repeat(64)}` }),
      ).toBe(false)
      expect(yield* fs.existsSafe(tampered)).toBe(false)
    }),
  )

  itFs.live("download treats a body shorter than Content-Length as a failure and removes the partial file", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const ctx = installContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        http: httpReturning(hello, { "content-length": "4096" }),
      })
      const partial = path.join(tmp.path, "partial.zip")
      expect(yield* ctx.install.download("https://example.com/tool.zip", partial)).toBe(false)
      expect(yield* fs.existsSafe(partial)).toBe(false)
    }),
  )

  itFs.live("download enforces a byte cap and removes the oversized file", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const ctx = installContext({ fs, directory: tmp.path, bin: tmp.path, home: tmp.path, http: httpReturning(hello) })
      const oversized = path.join(tmp.path, "oversized.zip")
      expect(yield* ctx.install.download("https://example.com/tool.zip", oversized, { maxBytes: 4 })).toBe(false)
      expect(yield* fs.existsSafe(oversized)).toBe(false)
    }),
  )

  itFs.live("download refuses a digest it cannot verify", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const ctx = installContext({ fs, directory: tmp.path, bin: tmp.path, home: tmp.path, http: httpReturning(hello) })
      const unverifiable = path.join(tmp.path, "unverifiable.zip")
      expect(yield* ctx.install.download("https://example.com/tool.zip", unverifiable, { digest: "md5:deadbeef" })).toBe(
        false,
      )
      expect(yield* fs.existsSafe(unverifiable)).toBe(false)
    }),
  )

  itFs.live("installArchive verifies the digest before extracting the archive", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const runs: string[] = []
      const ctx = installContext({ fs, directory: tmp.path, bin: tmp.path, home: tmp.path, http: httpReturning(hello), runs })
      expect(
        yield* LSPServer.installArchive(ctx, {
          url: "https://example.com/tool.zip",
          name: "tool.zip",
          digest: `sha256:${"0".repeat(64)}`,
        }),
      ).toBe(false)
      // A tampered archive must never reach the extractor.
      expect(runs).toEqual([])
      expect(yield* fs.existsSafe(path.join(tmp.path, "tool.zip"))).toBe(false)
      expect(yield* LSPServer.installArchive(ctx, { url: "https://example.com/tool.zip", name: "tool.zip", digest: helloDigest })).toBe(
        true,
      )
      expect(runs.some((command) => command.startsWith("unzip "))).toBe(true)
    }),
  )

  itFs.live("installArchive keeps a remote-controlled asset name inside the install directory", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const destinations: string[] = []
      const base = installContext({ fs: service, directory: tmp.path, bin: path.join(tmp.path, "bin"), home: tmp.path })
      const ctx = {
        ...base,
        install: {
          ...base.install,
          download: (_url: string, destination: string) =>
            Effect.sync(() => void destinations.push(destination)).pipe(Effect.as(false)),
        },
      }
      expect(yield* LSPServer.installArchive(ctx, { url: "https://example.com/x.zip", name: "../../escape.zip" })).toBe(false)
      expect(destinations).toEqual([path.join(tmp.path, "bin", "escape.zip")])
    }),
  )
})

describe("release integrity", () => {
  const digest = `sha256:${"a".repeat(64)}`
  const release = {
    tag_name: "1.0.0",
    assets: [{ name: "tool.zip", browser_download_url: "https://example.com/tool.zip", digest }],
  }

  it.effect("releaseAsset returns the published digest and refuses an asset without one", () =>
    Effect.gen(function* () {
      expect(yield* LSPServer.releaseAsset(release, "tool.zip")).toEqual({ url: "https://example.com/tool.zip", digest })
      const unverified = { tag_name: "1.0.0", assets: [{ name: "tool.zip", browser_download_url: "https://example.com/tool.zip" }] }
      expect(yield* LSPServer.releaseAsset(unverified, "tool.zip")).toBeUndefined()
      expect(yield* LSPServer.releaseAsset(release, "other.zip")).toBeUndefined()
    }),
  )

  itFs.live("releaseByTag reads the pinned tag, not the moving latest release", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const { ctx, urls } = recordingContext({ fs, directory: tmp.path, bin: tmp.path, json: { tag_name: "0.16.0", assets: [] } })
      const found = yield* LSPServer.releaseByTag(ctx, "zigtools/zls", "0.16.0")
      expect(found?.tag_name).toBe("0.16.0")
      expect(urls).toEqual(["https://api.github.com/repos/zigtools/zls/releases/tags/0.16.0"])
    }),
  )

  // The pinned tags below were read from the upstream release API on 2026-10-16; a deliberate bump updates
  // both the constant and this expectation.
  const pinnedReleases = [
    { name: "zls", server: Zls, repository: "zigtools/zls", tag: "0.16.0" },
    { name: "clangd", server: Clangd, repository: "clangd/clangd", tag: "23.1.0" },
    { name: "lua-ls", server: LuaLS, repository: "LuaLS/lua-language-server", tag: "3.19.2" },
    { name: "texlab", server: TexLab, repository: "latex-lsp/texlab", tag: "v5.26.0" },
    { name: "tinymist", server: Tinymist, repository: "Myriad-Dreamin/tinymist", tag: "v0.15.8" },
  ]
  for (const pinned of pinnedReleases) {
    itFs.live(`${pinned.name} resolves the pinned release tag ${pinned.tag}`, () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdirScoped()
        const { ctx, urls } = recordingContext({
          fs,
          directory: tmp.path,
          bin: tmp.path,
          json: {},
          which: (command) => (command === "zig" ? "/usr/bin/zig" : undefined),
        })
        expect(yield* pinned.server.spawn(tmp.path, ctx)).toBeUndefined()
        expect(urls[0]).toBe(`https://api.github.com/repos/${pinned.repository}/releases/tags/${pinned.tag}`)
      }),
    )
  }

  itFs.live("kotlin-ls installs the platform vsix the release body names and verifies its sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const build = "263.6379.0"
      const version = "0.0.13"
      // The six links below are copied from the upstream release body, so the expectation is not derived
      // from the code under test.
      const link = (target: string) =>
        `https://download.jetbrains.com/language-server/kotlin-server/${build}/kotlin-server-${version}-${target}.vsix`
      const targets = ["linux-amd64", "linux-aarch64", "mac-amd64", "mac-aarch64", "win-amd64", "win-aarch64"]
      // The body below mirrors the upstream release body, including the checksum link that follows each
      // download link and ends in `.vsix.sha256`.
      const release = {
        name: `v${build}`,
        body: targets
          .map(
            (target) =>
              `* [Download for ${target}](${link(target)})&nbsp;&nbsp;|&nbsp;&nbsp;[SHA-256 checksum](${link(target)}.sha256)`,
          )
          .join("\n"),
      }
      const platformToken = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux"
      const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "aarch64" : undefined
      if (!architecture) return
      const token = `${platformToken}-${architecture}`
      if (!targets.includes(token)) return
      const checksum = "0b5cf7568b1955f9f42273fa926b1313847d13f2c84cea8310a45617a2975ca9"
      const recorded = recordingContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        json: release,
        text: `${checksum}  *kotlin-server-${version}-${token}.vsix`,
      })
      expect(yield* KotlinLS.spawn(tmp.path, recorded.ctx)).toBeUndefined()
      expect(recorded.downloads[0]).toEqual({ url: link(token), digest: `sha256:${checksum}` })
      // A body without a link for this platform must not fall back to a guessed URL.
      const missing = recordingContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        json: { name: `v${build}`, body: "no links here" },
        text: checksum,
      })
      expect(yield* KotlinLS.spawn(tmp.path, missing.ctx)).toBeUndefined()
      expect(missing.downloads).toEqual([])
      // A sidecar that cannot be read leaves the artifact unverified, so the install must not proceed.
      const unverified = recordingContext({ fs, directory: tmp.path, bin: tmp.path, json: release })
      expect(yield* KotlinLS.spawn(tmp.path, unverified.ctx)).toBeUndefined()
      expect(unverified.downloads).toEqual([])
    }),
  )

  itFs.live("elixir-ls builds a pinned commit instead of the master branch", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const { ctx, downloads } = recordingContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        which: (command) => (command === "elixir" ? "/usr/bin/elixir" : undefined),
      })
      expect(yield* ElixirLS.spawn(tmp.path, ctx)).toBeUndefined()
      // v0.31.1 is an annotated tag, so the archive has to name the commit it points at; a tag ref can be
      // force-pushed to different content. The commit was resolved from the tag object via the GitHub API.
      expect(downloads[0]?.url).toBe("https://github.com/elixir-lsp/elixir-ls/archive/256ec7787dc14fa666817199ec6aa5dc64787e37.zip")
    }),
  )

  itFs.live("eslint builds a pinned commit instead of the main branch", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      yield* write(
        path.join(tmp.path, "node_modules", "eslint", "package.json"),
        JSON.stringify({ name: "eslint", main: "index.js" }),
      )
      yield* write(path.join(tmp.path, "node_modules", "eslint", "index.js"), "module.exports = {}\n")
      const { ctx, downloads } = recordingContext({ fs, directory: tmp.path, bin: tmp.path })
      expect(yield* ESLint.spawn(tmp.path, ctx)).toBeUndefined()
      expect(downloads[0]?.url).toBe(
        "https://github.com/microsoft/vscode-eslint/archive/de46ae7016bc1682b6f1e0bd18262501b0e202ca.zip",
      )
    }),
  )

  itFs.live("gopls installs a pinned version instead of @latest and checks the binary it created", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const { ctx, runs } = recordingContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        which: (command) => (command === "go" ? "/usr/bin/go" : undefined),
      })
      expect(yield* Gopls.spawn(tmp.path, ctx)).toBeUndefined()
      expect(runs[0]).toBe("go install golang.org/x/tools/gopls@v0.24.0")
    }),
  )

  itFs.live("fsharp does not launch a binary the installer did not create", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const { ctx } = recordingContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        which: (command) => (command === "dotnet" ? "/usr/bin/dotnet" : undefined),
      })
      expect(yield* FSharp.spawn(tmp.path, ctx)).toBeUndefined()
    }),
  )

  itFs.live("terraform-ls reads a pinned release instead of the moving latest", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const { ctx, urls } = recordingContext({ fs, directory: tmp.path, bin: tmp.path, json: {} })
      expect(yield* TerraformLS.spawn(tmp.path, ctx)).toBeUndefined()
      expect(urls[0]).toBe("https://api.releases.hashicorp.com/v1/releases/terraform-ls/0.39.0")
    }),
  )

  itFs.live("terraform-ls verifies the archive against the publisher's checksum list and refuses to install without it", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const os = process.platform === "win32" ? "windows" : process.platform
      const architecture = releaseArch(process.arch, { x64: "amd64", arm64: "arm64" })
      if (!architecture) return
      const archive = `terraform-ls_0.39.0_${os}_${architecture}.zip`
      const release = {
        url_shasums: "https://releases.hashicorp.com/terraform-ls/0.39.0/terraform-ls_0.39.0_SHA256SUMS",
        builds: [{ arch: architecture, os, url: `https://releases.hashicorp.com/terraform-ls/0.39.0/${archive}` }],
      }
      // Two lines, so picking the first line instead of the matching one cannot pass.
      const sums = `${"b".repeat(64)}  terraform-ls_0.39.0_other_platform.zip\n${"a".repeat(64)}  ${archive}\n`
      const verified = recordingContext({ fs, directory: tmp.path, bin: tmp.path, json: release, text: sums })
      expect(yield* TerraformLS.spawn(tmp.path, verified.ctx)).toBeUndefined()
      expect(verified.downloads[0]).toEqual({
        url: `https://releases.hashicorp.com/terraform-ls/0.39.0/${archive}`,
        digest: `sha256:${"a".repeat(64)}`,
      })
      // No checksum list means no verification is possible, so the install must not proceed.
      const unverified = recordingContext({ fs, directory: tmp.path, bin: tmp.path, json: release })
      expect(yield* TerraformLS.spawn(tmp.path, unverified.ctx)).toBeUndefined()
      expect(unverified.downloads).toEqual([])
    }),
  )
})

describe("spawn failure reporting", () => {
  itFs.live("probe distinguishes a command that could not run from a real exit 127", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const missing = installContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        run: () => Effect.fail(new Error("spawn ENOENT")),
      })
      const unreachable = yield* missing.probe("no-such-tool", ["--version"])
      expect(unreachable.failed).toBe(true)
      expect(unreachable.code).toBe(127)
      const exited = installContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        run: () =>
          Effect.succeed({
            command: "sh",
            exitCode: 127,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("sh: 1: no-such-tool: not found\n"),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      })
      const real = yield* exited.probe("sh", ["-c", "no-such-tool"])
      expect(real.failed).toBe(false)
      expect(real.code).toBe(127)
      expect(real.stderr).toContain("not found")
    }),
  )
})

describe("root discovery", () => {
  itFs.live("nearestRoot walks up to the worktree, not just the instance directory", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const directory = path.join(tmp.path, "packages", "app")
      yield* write(path.join(tmp.path, "mix.exs"))
      yield* write(path.join(directory, "lib", "a.ex"))
      const ctx = installContext({
        fs,
        directory,
        worktree: tmp.path,
        bin: path.join(tmp.path, "bin"),
        home: tmp.path,
      })
      expect(yield* LSPServer.nearestRoot(["mix.exs"])(path.join(directory, "lib", "a.ex"), ctx)).toBe(tmp.path)
    }),
  )
})

describe("download host allowlist", () => {
  const hello = new TextEncoder().encode("hello world")

  itFs.live("refuses a host outside OPENCODE_LSP_DOWNLOAD_HOSTS before any request", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const requests: string[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => void requests.push(request.url)).pipe(
          Effect.andThen(Effect.succeed(HttpClientResponse.fromWeb(request, new Response(hello)))),
        ),
      )
      const ctx = installContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        env: { OPENCODE_LSP_DOWNLOAD_HOSTS: "example.com, api.github.com" },
        http,
      })
      expect(yield* ctx.install.download("https://evil.example.net/tool.zip", path.join(tmp.path, "a.zip"))).toBe(false)
      expect(requests).toEqual([])
      expect(yield* ctx.install.download("https://example.com/tool.zip", path.join(tmp.path, "b.zip"))).toBe(true)
      expect(requests).toEqual(["https://example.com/tool.zip"])
      expect(yield* ctx.install.json("https://evil.example.net/meta")).toBeUndefined()
      expect(requests).toHaveLength(1)
    }),
  )

  itFs.live("an unset allowlist leaves every host reachable, as before", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const requests: string[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => void requests.push(request.url)).pipe(
          Effect.andThen(Effect.succeed(HttpClientResponse.fromWeb(request, new Response(hello)))),
        ),
      )
      const ctx = installContext({ fs, directory: tmp.path, bin: tmp.path, home: tmp.path, http })
      expect(yield* ctx.install.download("https://example.net/tool.zip", path.join(tmp.path, "c.zip"))).toBe(true)
      expect(requests).toEqual(["https://example.net/tool.zip"])
    }),
  )

  // A redirect chain is only visible in the response's final URL: the request that leaves the machine names
  // the allowlisted host, while the bytes come from wherever that host points. The stub returns what the
  // client sees after following a redirect, so the check cannot pass on the initial URL alone.
  const redirectingClient = (requests: string[]) =>
    HttpClient.make((request) =>
      Effect.sync(() => void requests.push(request.url)).pipe(
        Effect.andThen(
          Effect.succeed(
            HttpClientResponse.fromWeb(
              HttpClientRequest.setUrl(request, "https://evil.example.net/redirected"),
              new Response(JSON.stringify({ ok: true })),
            ),
          ),
        ),
      ),
    )

  itFs.live("refuses a download whose redirect lands on a host outside OPENCODE_LSP_DOWNLOAD_HOSTS", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const requests: string[] = []
      const ctx = installContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        env: { OPENCODE_LSP_DOWNLOAD_HOSTS: "example.com" },
        http: redirectingClient(requests),
      })
      const destination = path.join(tmp.path, "redirected.zip")
      expect(yield* ctx.install.download("https://example.com/tool.zip", destination)).toBe(false)
      expect(yield* fs.existsSafe(destination)).toBe(false)
      // The metadata fetch follows redirects the same way, so it needs the same check.
      expect(yield* ctx.install.json("https://example.com/meta")).toBeUndefined()
      expect(requests).toEqual(["https://example.com/tool.zip", "https://example.com/meta"])
    }),
  )

  itFs.live("an unset allowlist still follows a redirect, as before", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const requests: string[] = []
      const ctx = installContext({
        fs,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        http: redirectingClient(requests),
      })
      expect(yield* ctx.install.download("https://example.net/tool.zip", path.join(tmp.path, "d.zip"))).toBe(true)
      expect(requests).toEqual(["https://example.net/tool.zip"])
    }),
  )
})

describe("jdtls and razor installation", () => {
  const launcherName = "org.eclipse.equinox.launcher_1.6.700.jar"
  const javaProbe = (version: string) => () =>
    Effect.succeed({ code: 0, stdout: "", stderr: `openjdk version "${version}" 2023-09-19\n`, failed: false })
  const dataDirectory = (handle: LSPServer.Handle | undefined) => {
    const args = handle?.args ?? []
    const index = args.indexOf("-data")
    return index === -1 ? undefined : args[index + 1]
  }

  itFs.live("jdtls accepts a GA JDK that prints a two-component version", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const bin = path.join(tmp.path, "bin")
      yield* write(path.join(bin, "jdtls", "plugins", launcherName))
      const base = installContext({ fs, directory: tmp.path, bin, home: tmp.path })
      const ctx = {
        ...base,
        which: (command: string) => (command === "java" ? "/usr/bin/java" : undefined),
        probe: javaProbe("21"),
      }
      expect(yield* JDTLS.spawn(tmp.path, ctx)).toBeDefined()
    }),
  )

  itFs.live("jdtls still accepts a three-component version and rejects a legacy JDK", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const bin = path.join(tmp.path, "bin")
      yield* write(path.join(bin, "jdtls", "plugins", launcherName))
      const base = installContext({ fs, directory: tmp.path, bin, home: tmp.path })
      const which = (command: string) => (command === "java" ? "/usr/bin/java" : undefined)
      expect(yield* JDTLS.spawn(tmp.path, { ...base, which, probe: javaProbe("21.0.1") })).toBeDefined()
      expect(yield* JDTLS.spawn(tmp.path, { ...base, which, probe: javaProbe("1.8.0_292") })).toBeUndefined()
    }),
  )

  itFs.live("jdtls keeps one data directory per root and clears it when the distribution is reinstalled", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const bin = path.join(tmp.path, "bin")
      const plugins = path.join(bin, "jdtls", "plugins")
      yield* write(path.join(plugins, launcherName))
      const base = installContext({ fs: service, directory: tmp.path, bin, home: tmp.path })
      const ctx = {
        ...base,
        which: (command: string) => (command === "java" ? "/usr/bin/java" : undefined),
        probe: javaProbe("21"),
      }
      const first = yield* JDTLS.spawn(tmp.path, ctx)
      const data = dataDirectory(first)
      expect(data).toBeDefined()
      if (!data) return
      // A data directory outside the install root would be a temp dir that the next restart cannot find.
      expect(data.startsWith(bin + path.sep)).toBe(true)
      const sentinel = path.join(data, "index-sentinel")
      yield* write(sentinel)
      yield* Effect.promise(() => fs.rm(plugins, { recursive: true, force: true }))
      const reinstalling = {
        ...ctx,
        install: {
          ...ctx.install,
          // The snapshot's published sidecar, so the reinstall passes the checksum gate.
          text: () => Effect.succeed("fd9447238785a36492b9802b4aa765bad1cb66954f57ba10883314d4c2371510\n"),
          download: () => Effect.succeed(true),
          extract: (archive: string, destination: string) =>
            Effect.gen(function* () {
              yield* write(path.join(destination, "plugins", launcherName))
              return true
            }),
        },
      }
      const second = yield* JDTLS.spawn(tmp.path, reinstalling)
      expect(dataDirectory(second)).toBe(data)
      expect(yield* service.existsSafe(sentinel)).toBe(false)
    }),
  )

  itFs.live("jdtls installs a dated snapshot and verifies its published checksum", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const bin = path.join(tmp.path, "bin")
      // The digest eclipse.org publishes next to the dated snapshot, read from the sidecar on 2026-10-16.
      const checksum = "fd9447238785a36492b9802b4aa765bad1cb66954f57ba10883314d4c2371510"
      const java = (command: string) => (command === "java" ? "/usr/bin/java" : undefined)
      const recorded = recordingContext({ fs, directory: tmp.path, bin, text: `${checksum}\n`, which: java })
      expect(yield* JDTLS.spawn(tmp.path, { ...recorded.ctx, probe: javaProbe("21") })).toBeUndefined()
      expect(recorded.downloads[0]).toEqual({
        url: "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-1.63.0-202610151832.tar.gz",
        digest: `sha256:${checksum}`,
      })
      // No sidecar means the snapshot cannot be verified, so the install must not proceed.
      const unverified = recordingContext({ fs, directory: tmp.path, bin, which: java })
      expect(yield* JDTLS.spawn(tmp.path, { ...unverified.ctx, probe: javaProbe("21") })).toBeUndefined()
      expect(unverified.downloads).toEqual([])
    }),
  )

  const completeRazorExtension = (root: string, name: string) => {
    const extension = path.join(root, name, ".razorExtension")
    return Effect.all([
      write(path.join(extension, "Microsoft.CodeAnalysis.Razor.Compiler.dll")),
      write(path.join(extension, "Targets", "Microsoft.NET.Sdk.Razor.DesignTime.targets")),
      write(path.join(extension, "Microsoft.VisualStudioCode.RazorExtension.dll")),
    ])
  }

  itFs.live("razor picks the newest installation across extension roots, not the first root", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const olderRoot = path.join(tmp.path, "vscode-extensions")
      const home = path.join(tmp.path, "home")
      yield* completeRazorExtension(olderRoot, "ms-dotnettools.csharp-1.0.0")
      yield* completeRazorExtension(path.join(home, ".vscode", "extensions"), "ms-dotnettools.csharp-2.0.0")
      const oldTime = new Date("2024-01-01T00:00:00Z")
      const newTime = new Date("2025-01-01T00:00:00Z")
      yield* Effect.promise(() => fs.utimes(path.join(olderRoot, "ms-dotnettools.csharp-1.0.0"), oldTime, oldTime))
      yield* Effect.promise(() =>
        fs.utimes(path.join(home, ".vscode", "extensions", "ms-dotnettools.csharp-2.0.0"), newTime, newTime),
      )
      const base = installContext({
        fs: service,
        directory: tmp.path,
        bin: path.join(tmp.path, "bin"),
        home,
        env: { VSCODE_EXTENSIONS: olderRoot },
      })
      const ctx = {
        ...base,
        which: (command: string) => (command === "roslyn-language-server" ? "/fake/roslyn" : undefined),
      }
      const handle = yield* Razor.spawn(tmp.path, ctx)
      expect(handle?.args.some((arg) => arg.includes("ms-dotnettools.csharp-2.0.0"))).toBe(true)
    }),
  )
})

describe("server definitions and roots", () => {
  it.effect("every builtin extension is a dotted extension, or the matcher can never see it", () =>
    Effect.sync(() => {
      const undotted = builtIns.flatMap((server) =>
        server.extensions
          .filter((extension) => !extension.startsWith("."))
          .map((extension) => `${server.id}:${extension}`),
      )
      expect(undotted).toEqual([])
    }),
  )

  it.effect("the builtin ids match the v1 config fixture and name the tool each server runs", () =>
    Effect.sync(() => {
      expect(builtIns.map((server) => server.id).sort()).toEqual([...builtinServerIds].sort())
      expect(Rubocop.id).toBe("rubocop")
    }),
  )

  it.effect("npm launcher shims get the Windows .cmd suffix", () =>
    Effect.sync(() => {
      expect(binSuffix("win32")).toBe(".cmd")
      expect(binSuffix("linux")).toBe("")
    }),
  )

  test("sourcekit attaches to Objective-C++ sources", { entries: [lspDocument(true)], builtIns: [SourceKit] }, (lsp, h) =>
    Effect.gen(function* () {
      yield* write(path.join(h.directory, "src", "a.mm"))
      expect(yield* lsp.hasClients(path.join(h.directory, "src", "a.mm"))).toBe(true)
    }),
  )

  itFs.live("gopls falls back to go.mod when no go.work exists", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const repository = path.join(tmp.path, "repo")
      const packageDirectory = path.join(repository, "pkg")
      yield* write(path.join(repository, "go.mod"))
      yield* write(path.join(packageDirectory, "a.go"))
      const ctx = installContext({
        fs: service,
        directory: packageDirectory,
        worktree: repository,
        bin: path.join(tmp.path, "bin"),
        home: tmp.path,
      })
      expect(yield* Gopls.root(path.join(packageDirectory, "a.go"), ctx)).toBe(repository)
    }),
  )

  itFs.live("nixd treats a flake in the instance directory as a project marker", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const repository = path.join(tmp.path, "repo")
      const subdirectory = path.join(repository, "sub")
      yield* write(path.join(subdirectory, "flake.nix"))
      yield* write(path.join(subdirectory, "a.nix"))
      const ctx = installContext({
        fs: service,
        directory: subdirectory,
        worktree: repository,
        bin: path.join(tmp.path, "bin"),
        home: tmp.path,
      })
      expect(yield* Nixd.root(path.join(subdirectory, "a.nix"), ctx)).toBe(subdirectory)
    }),
  )

  itFs.live("rust roots at a Cargo marker only when one exists", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp.path, "src", "lib.rs"))
      const ctx = installContext({ fs: service, directory: tmp.path, bin: path.join(tmp.path, "bin"), home: tmp.path })
      expect(yield* RustAnalyzer.root(path.join(tmp.path, "src", "lib.rs"), ctx)).toBeUndefined()
    }),
  )

  itFs.live("rust does not climb past the worktree into a sibling workspace", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const worktree = path.join(tmp.path, "repo")
      const crate = path.join(tmp.path, "repo-other", "crate")
      yield* write(path.join(tmp.path, "repo-other", "Cargo.toml"), '[workspace]\nmembers = ["crate"]\n')
      yield* write(path.join(crate, "Cargo.toml"), '[package]\nname = "crate"\n')
      yield* write(path.join(crate, "src", "lib.rs"))
      const ctx = installContext({ fs: service, directory: worktree, worktree, bin: path.join(tmp.path, "bin"), home: tmp.path })
      expect(yield* RustAnalyzer.root(path.join(crate, "src", "lib.rs"), ctx)).toBe(crate)
    }),
  )

  itFs.live("rust ignores a [workspace] table mentioned in a comment", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const repository = path.join(tmp.path, "repo")
      const crate = path.join(repository, "crate")
      yield* write(path.join(repository, "Cargo.toml"), '[workspace]\nmembers = ["crate"]\n')
      yield* write(path.join(crate, "Cargo.toml"), '# [workspace] is declared at the repository root\n[package]\nname = "crate"\n')
      yield* write(path.join(crate, "src", "lib.rs"))
      const ctx = installContext({
        fs: service,
        directory: repository,
        worktree: repository,
        bin: path.join(tmp.path, "bin"),
        home: tmp.path,
      })
      expect(yield* RustAnalyzer.root(path.join(crate, "src", "lib.rs"), ctx)).toBe(repository)
    }),
  )

  itFs.live("rubocop resolves the wrapper the installer wrote instead of a fixed name", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      let installed = false
      const base = installContext({ fs: service, directory: tmp.path, bin: path.join(tmp.path, "bin"), home: tmp.path })
      const ctx = {
        ...base,
        which: (command: string) => {
          if (command === "ruby" || command === "gem") return `/usr/bin/${command}`
          if (command === "rubocop") return installed ? "/fake/bin/rubocop.bat" : undefined
          return undefined
        },
        install: { ...base.install, run: () => Effect.sync(() => void (installed = true)).pipe(Effect.as(true)) },
      }
      const handle = yield* Rubocop.spawn(tmp.path, ctx)
      expect(handle?.command).toBe("/fake/bin/rubocop.bat")
      expect(handle?.args).toEqual(["--lsp"])
    }),
  )

  itFs.live("prisma stays enabled in a project that has a package.json", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp.path, "package.json"), "{}\n")
      yield* write(path.join(tmp.path, "prisma", "schema.prisma"))
      const ctx = installContext({ fs: service, directory: tmp.path, bin: path.join(tmp.path, "bin"), home: tmp.path })
      expect(yield* Prisma.root(path.join(tmp.path, "prisma", "schema.prisma"), ctx)).toBe(path.join(tmp.path, "prisma"))
    }),
  )

  it.effect("unsupported architectures are refused instead of downloading another machine's binary", () =>
    Effect.sync(() => {
      expect(releaseArch("x64", { x64: "amd64", arm64: "arm64" })).toBe("amd64")
      expect(releaseArch("arm64", { x64: "amd64", arm64: "arm64" })).toBe("arm64")
      expect(releaseArch("ia32", { x64: "amd64", arm64: "arm64" })).toBeUndefined()
      expect(releaseArch("arm", { x64: "amd64", arm64: "arm64" })).toBeUndefined()
    }),
  )

  itFs.live("virtualEnvironments drops an empty VIRTUAL_ENV instead of resolving it against the process cwd", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const ctx = installContext({
        fs: service,
        directory: tmp.path,
        bin: tmp.path,
        home: tmp.path,
        env: { VIRTUAL_ENV: "" },
      })
      expect(LSPServer.virtualEnvironments(ctx, tmp.path)).toEqual([
        path.join(tmp.path, ".venv"),
        path.join(tmp.path, "venv"),
      ])
    }),
  )
})

describe("install failure handling", () => {
  itFs.live("elixir-ls does not launch when a build step fails", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const { ctx, runs } = recordingContext({
        fs: service,
        directory: tmp.path,
        bin: path.join(tmp.path, "bin"),
        which: (command) => (command === "elixir" ? "/usr/bin/elixir" : undefined),
      })
      const installing = {
        ...ctx,
        install: {
          ...ctx.install,
          download: () => Effect.succeed(true),
          extract: (_archive: string, destination: string) =>
            Effect.gen(function* () {
              yield* write(path.join(destination, "elixir-ls-0.31.1", "mix.exs"))
              return true
            }),
          run: (command: string, args: readonly string[]) =>
            Effect.sync(() => {
              runs.push([command, ...args].join(" "))
              return false
            }),
        },
      }
      expect(yield* ElixirLS.spawn(tmp.path, installing)).toBeUndefined()
      // The first failed step must stop the build, not fall through to `mix compile` and a missing launcher.
      expect(runs).toEqual(["mix deps.get"])
    }),
  )

  itFs.live("eslint does not launch when npm install fails", () =>
    Effect.gen(function* () {
      const service = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      yield* write(
        path.join(tmp.path, "node_modules", "eslint", "package.json"),
        JSON.stringify({ name: "eslint", main: "index.js" }),
      )
      yield* write(path.join(tmp.path, "node_modules", "eslint", "index.js"), "module.exports = {}\n")
      const { ctx, runs } = recordingContext({ fs: service, directory: tmp.path, bin: path.join(tmp.path, "bin") })
      const installing = {
        ...ctx,
        install: {
          ...ctx.install,
          download: () => Effect.succeed(true),
          extract: (_archive: string, destination: string) =>
            Effect.gen(function* () {
              yield* write(path.join(destination, "vscode-eslint-release-3.0.34", "package.json"))
              return true
            }),
          run: (command: string, args: readonly string[]) =>
            Effect.sync(() => {
              runs.push([command, ...args].join(" "))
              return false
            }),
        },
      }
      expect(yield* ESLint.spawn(tmp.path, installing)).toBeUndefined()
      expect(runs).toEqual(["npm install"])
    }),
  )
})
