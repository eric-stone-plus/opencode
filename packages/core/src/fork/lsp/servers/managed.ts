import { Effect, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import path from "path"
import { LSPServer } from "../server.js"

// Servers that are downloaded or built when no copy is installed. Every fetch, build, and install goes
// through `ctx.install`, which does nothing when downloads are disabled.

const arch = (names: Record<string, string>) => names[process.arch] ?? process.arch
const platform = (names: Record<string, string>) => names[process.platform] ?? process.platform

/** The sha256 a `.sha256` sidecar publishes, or undefined when it holds no 64-hex digest. */
const sidecarSha256 = (document: string) => /([0-9a-f]{64})\b/i.exec(document)?.[1]?.toLowerCase()

/** The sha256 `list` publishes for the file `url` names, or undefined when no line matches. */
const checksumSha256 = (list: string, url: string) => {
  const name = url.split("/").pop()
  const line = list.split("\n").find((entry) => entry.trim().split(/\s+/).at(-1)?.replace(/^\*/, "") === name)
  return line ? sidecarSha256(line) : undefined
}

/** The upstream architecture token for `architecture`, or undefined when upstream publishes no build for it. */
export const releaseArch = (architecture: NodeJS.Architecture, names: { readonly x64: string; readonly arm64: string }) =>
  architecture === "x64" ? names.x64 : architecture === "arm64" ? names.arm64 : undefined

export const ElixirLS: LSPServer.Info = {
  id: "elixir-ls",
  extensions: [".ex", ".exs"],
  root: LSPServer.nearestRoot(["mix.exs", "mix.lock"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("elixir-ls")
      if (found) return LSPServer.launch(root, found)
      const source = path.join(ctx.bin, "elixir-ls-source")
      const binary = path.join(source, "release", process.platform === "win32" ? "language_server.bat" : "language_server.sh")
      if (!(yield* ctx.fs.existsSafe(binary))) {
        if (!ctx.which("elixir")) return undefined
        // Pinned 2026-10-16 to the commit behind v0.31.1, the release that was latest then; a tag ref can
        // be force-pushed to different content, so the archive names the commit itself. A branch archive
        // would build and run whatever upstream published that day. The source archive has no published
        // digest, so the commit is the integrity boundary here; `mix deps.get` then verifies each
        // dependency against the archive's mix.lock. Bump deliberately after reviewing the upstream diff.
        const staging = path.join(ctx.bin, "elixir-ls-staging")
        yield* ctx.fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url: "https://github.com/elixir-lsp/elixir-ls/archive/256ec7787dc14fa666817199ec6aa5dc64787e37.zip",
          name: "elixir-ls.zip",
          into: staging,
        })
        if (!unpacked) return undefined
        const extracted = (yield* ctx.fs.readDirectory(staging).pipe(Effect.orElseSucceed(() => [] as string[])))[0]
        if (!extracted) return undefined
        yield* ctx.fs.remove(source, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* ctx.fs.rename(path.join(staging, extracted), source)
        yield* ctx.fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
        const build = { cwd: source, env: { MIX_ENV: "prod" } }
        if (!(yield* ctx.install.run("mix", ["deps.get"], build))) return undefined
        if (!(yield* ctx.install.run("mix", ["compile"], build))) return undefined
        if (!(yield* ctx.install.run("mix", ["elixir_ls.release2", "-o", "release"], build))) return undefined
        if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      }
      return LSPServer.launch(root, binary)
    }),
}

const ZLS_ASSETS = [
  "zls-x86_64-linux.tar.xz",
  "zls-x86_64-macos.tar.xz",
  "zls-x86_64-windows.zip",
  "zls-aarch64-linux.tar.xz",
  "zls-aarch64-macos.tar.xz",
  "zls-aarch64-windows.zip",
  "zls-x86-linux.tar.xz",
  "zls-x86-windows.zip",
]

// Pinned 2026-10-16 to the release that was latest then; bump deliberately after reviewing the upstream diff.
const ZLS_RELEASE = "0.16.0"

export const Zls: LSPServer.Info = {
  id: "zls",
  extensions: [".zig", ".zon"],
  root: LSPServer.nearestRoot(["build.zig"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("zls")
      if (found) return LSPServer.launch(root, found)
      if (!ctx.which("zig")) return undefined
      const name = `zls-${arch({ arm64: "aarch64", x64: "x86_64", ia32: "x86" })}-${platform({ darwin: "macos", win32: "windows" })}.${process.platform === "win32" ? "zip" : "tar.xz"}`
      if (!ZLS_ASSETS.includes(name)) return undefined
      const release = yield* LSPServer.releaseByTag(ctx, "zigtools/zls", ZLS_RELEASE)
      const asset = yield* LSPServer.releaseAsset(release, name)
      if (!asset || !(yield* LSPServer.installArchive(ctx, { url: asset.url, name, digest: asset.digest }))) return undefined
      const binary = path.join(ctx.bin, `zls${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}

const roslyn = (ctx: LSPServer.Context) =>
  Effect.gen(function* () {
    const existing = ctx.which("roslyn-language-server")
    if (existing) return existing
    const global = path.join(
      ctx.env.DOTNET_CLI_HOME ?? ctx.home,
      ".dotnet",
      "tools",
      `roslyn-language-server${process.platform === "win32" ? ".cmd" : ""}`,
    )
    if (yield* ctx.fs.existsSafe(global)) return global
    if (!ctx.which("dotnet")) return undefined
    // Pinned 2026-10-16 to the version the feed published then; `--prerelease` would install whatever the
    // feed serves that day. Bump deliberately after reviewing the upstream diff.
    const installed = yield* ctx.install.run("dotnet", [
      "tool",
      "install",
      "--global",
      "roslyn-language-server",
      "--version",
      "5.13.0-1.26514.10",
    ])
    if (!installed) return undefined
    return ctx.which("roslyn-language-server") ?? ((yield* ctx.fs.existsSafe(global)) ? global : undefined)
  })

const DOTNET_MARKERS = [".slnx", ".sln", ".csproj", "global.json"]

export const CSharp: LSPServer.Info = {
  id: "csharp",
  extensions: [".cs", ".csx"],
  root: LSPServer.nearestRoot(DOTNET_MARKERS),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const binary = yield* roslyn(ctx)
      return binary ? LSPServer.launch(root, binary, ["--stdio", "--autoLoadProjects"]) : undefined
    }),
}

/** The Razor tooling bundled with the VS Code C# extension, newest installation across every root. */
const razorExtension = (ctx: LSPServer.Context) =>
  Effect.gen(function* () {
    const home = ctx.home
    const roots = [
      ctx.env.VSCODE_EXTENSIONS,
      path.join(home, ".vscode", "extensions"),
      path.join(home, ".vscode-insiders", "extensions"),
      path.join(home, ".vscode-server", "extensions"),
      path.join(home, ".vscode-server-insiders", "extensions"),
    ].filter((item): item is string => item !== undefined)
    // Collect every installation from every root first: sorting inside one root would let an older
    // install in an earlier root shadow a newer one in a later root.
    const installations = yield* Effect.forEach(new Set(roots), (root) =>
      Effect.gen(function* () {
        const entries = yield* ctx.fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]))
        return yield* Effect.forEach(
          entries.filter((entry) => entry.startsWith("ms-dotnettools.csharp-")),
          (entry) =>
            ctx.fs.stat(path.join(root, entry)).pipe(
              Effect.map((info) => ({
                root,
                entry,
                modified: Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
              })),
              Effect.orElseSucceed(() => ({ root, entry, modified: 0 })),
            ),
        )
      }),
    )
    for (const { root, entry } of installations.flat().toSorted((a, b) => b.modified - a.modified)) {
      const extension = path.join(root, entry, ".razorExtension")
      const found = {
        compiler: path.join(extension, "Microsoft.CodeAnalysis.Razor.Compiler.dll"),
        targets: path.join(extension, "Targets", "Microsoft.NET.Sdk.Razor.DesignTime.targets"),
        extension: path.join(extension, "Microsoft.VisualStudioCode.RazorExtension.dll"),
      }
      if (
        (yield* ctx.fs.existsSafe(found.compiler)) &&
        (yield* ctx.fs.existsSafe(found.targets)) &&
        (yield* ctx.fs.existsSafe(found.extension))
      )
        return found
    }
    return undefined
  })

export const Razor: LSPServer.Info = {
  id: "razor",
  extensions: [".razor", ".cshtml"],
  root: LSPServer.nearestRoot(DOTNET_MARKERS),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const binary = yield* roslyn(ctx)
      if (!binary) return undefined
      const razor = yield* razorExtension(ctx)
      if (!razor) return undefined
      return LSPServer.launch(root, binary, [
        "--stdio",
        "--autoLoadProjects",
        `--razorSourceGenerator=${razor.compiler}`,
        `--razorDesignTimePath=${razor.targets}`,
        "--extension",
        razor.extension,
      ])
    }),
}

export const FSharp: LSPServer.Info = {
  id: "fsharp",
  extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
  root: LSPServer.nearestRoot([".slnx", ".sln", ".fsproj", "global.json"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("fsautocomplete")
      if (found) return LSPServer.launch(root, found)
      if (!ctx.which("dotnet")) return undefined
      // Pinned 2026-10-16 to the version the feed published then; a bare name would install whatever
      // `dotnet tool install` resolves that day. Bump deliberately after reviewing the upstream diff.
      const installed = yield* ctx.install.run("dotnet", ["tool", "install", "fsautocomplete", "--version", "0.85.4", "--tool-path", ctx.bin])
      const binary = path.join(ctx.bin, `fsautocomplete${LSPServer.EXE}`)
      return installed && (yield* ctx.fs.existsSafe(binary)) ? LSPServer.launch(root, binary) : undefined
    }),
}

const CLANGD_ARGS = ["--background-index", "--clang-tidy"]
const CLANGD_PLATFORMS: Record<string, string> = { darwin: "mac", linux: "linux", win32: "windows" }
// Pinned 2026-10-16 to the release that was latest then; bump deliberately after reviewing the upstream diff.
const CLANGD_RELEASE = "23.1.0"

export const Clangd: LSPServer.Info = {
  id: "clangd",
  extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
  root: LSPServer.nearestRoot(["compile_commands.json", "compile_flags.txt", ".clangd"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("clangd")
      if (found) return LSPServer.launch(root, found, CLANGD_ARGS)
      const installed = yield* LSPServer.firstExisting(ctx, [
        path.join(ctx.bin, `clangd${LSPServer.EXE}`),
        ...(yield* ctx.fs.readDirectory(ctx.bin).pipe(
          Effect.map((entries) =>
            entries
              .filter((entry) => entry.startsWith("clangd_"))
              .map((entry) => path.join(ctx.bin, entry, "bin", `clangd${LSPServer.EXE}`)),
          ),
          Effect.orElseSucceed(() => [] as string[]),
        )),
      ])
      if (installed) return LSPServer.launch(root, installed, CLANGD_ARGS)

      const release = yield* LSPServer.releaseByTag(ctx, "clangd/clangd", CLANGD_RELEASE)
      const tag = release?.tag_name
      const token = CLANGD_PLATFORMS[process.platform]
      if (!tag || !token) return undefined
      const matching = (release?.assets ?? []).filter(
        (asset) => asset.name?.includes(token) && asset.name.includes(tag) && asset.browser_download_url,
      )
      const asset =
        matching.find((item) => item.name?.endsWith(".zip")) ?? matching.find((item) => item.name?.endsWith(".tar.xz")) ?? matching[0]
      if (!asset?.name || !asset.browser_download_url) return undefined
      if (!asset.name.endsWith(".zip") && !asset.name.endsWith(".tar.xz")) return undefined
      const verified = yield* LSPServer.releaseAsset(release, asset.name)
      if (!verified || !(yield* LSPServer.installArchive(ctx, { url: verified.url, name: asset.name, digest: verified.digest })))
        return undefined
      const binary = path.join(ctx.bin, `clangd_${tag}`, "bin", `clangd${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      const link = path.join(ctx.bin, "clangd")
      yield* ctx.fs.remove(link, { force: true }).pipe(Effect.ignore)
      yield* ctx.fs.symlink(binary, link).pipe(Effect.ignore)
      return LSPServer.launch(root, binary, CLANGD_ARGS)
    }),
}

const MAVEN_MODULES = /<modules>([\s\S]*?)<\/modules>/g

/** True when `pom` declares `modulePath` (relative to the pom's directory) as one of its `<module>` entries. */
function isModuleOf(pom: string, modulePath: string) {
  const normalized = modulePath.replace(/\\/g, "/").replace(/\/$/, "")
  if (!normalized) return false
  return (pom.match(MAVEN_MODULES) ?? []).some((block) =>
    [...block.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].some(
      (declared) => declared[1].replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") === normalized,
    ),
  )
}

/** Climbs while each parent pom declares the module below it, so a multi-module build is rooted at its top. */
const mavenRoot = (ctx: LSPServer.Context, root: string, parents: readonly string[]): Effect.Effect<string> =>
  Effect.gen(function* () {
    const [pom, ...rest] = parents
    if (!pom) return root
    const content = yield* ctx.fs.readFileStringSafe(pom).pipe(Effect.orElseSucceed(() => undefined))
    if (!content || !isModuleOf(content, path.relative(path.dirname(pom), root))) return root
    return yield* mavenRoot(ctx, path.dirname(pom), rest)
  })

const JDTLS_CONFIGURATIONS: Record<string, string> = { darwin: "config_mac", linux: "config_linux", win32: "config_win" }
// Pinned 2026-10-16 to the snapshot that was newest then; eclipse.org keeps every dated snapshot, so this
// URL never moves (unlike `jdt-language-server-latest.tar.gz`). The `.sha256` sidecar published next to it
// is the integrity boundary. Bump deliberately after reviewing the upstream changelog.
const JDTLS_SNAPSHOT = "jdt-language-server-1.63.0-202610151832.tar.gz"

export const JDTLS: LSPServer.Info = {
  id: "jdtls",
  extensions: [".java"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      const settings = ["settings.gradle", "settings.gradle.kts"]
      const wrapper = yield* LSPServer.strictNearestRoot(["gradlew", "gradlew.bat"], settings)(file, ctx)
      if (wrapper) return wrapper
      const gradle = yield* LSPServer.strictNearestRoot(settings)(file, ctx)
      if (gradle) return gradle
      const build = yield* LSPServer.strictNearestRoot(["build.gradle", "build.gradle.kts"])(file, ctx)
      if (build) return build
      const poms = yield* ctx.fs.findUp("pom.xml", path.dirname(file), ctx.directory).pipe(Effect.orElseSucceed(() => [] as string[]))
      if (poms.length > 0) return yield* mavenRoot(ctx, path.dirname(poms[0]), poms.slice(1))
      return yield* LSPServer.strictNearestRoot([".project", ".classpath"])(file, ctx)
    }),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      if (!ctx.which("java")) return undefined
      const version = yield* ctx.probe("java", ["-version"])
      // GA JDKs print two components (`openjdk version "21"`); 8 prints the legacy `1.8.0_x` form.
      const parsed = /"(\d+)(?:\.(\d+))?(?:\.(\d+))?"/.exec(version.stderr)
      const major = parsed ? (parsed[1] === "1" && parsed[2] ? Number.parseInt(parsed[2]) : Number.parseInt(parsed[1])) : undefined
      if (major === undefined || major < 21) return undefined
      const distribution = path.join(ctx.bin, "jdtls")
      const plugins = path.join(distribution, "plugins")
      // The index is per project root, in the install directory rather than a temp dir: jdtls reuses it
      // across restarts instead of re-indexing, and the directory does not accumulate on disk.
      const data = path.join(distribution, "data", createHash("sha256").update(root).digest("hex").slice(0, 16))
      if (!(yield* ctx.fs.existsSafe(plugins))) {
        const url = `https://download.eclipse.org/jdtls/snapshots/${JDTLS_SNAPSHOT}`
        // The snapshot name is pinned, but a corrupted or substituted download would still be unpacked and
        // executed; the sidecar is what makes the archive verifiable, so refuse to install without it.
        const sidecar = yield* ctx.install.text(`${url}.sha256`)
        const digest = sidecar ? sidecarSha256(sidecar) : undefined
        if (!digest) {
          yield* Effect.logWarning("jdtls snapshot has no published checksum; refusing to install it", { url })
          return undefined
        }
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url,
          name: "release.tar.gz",
          directory: distribution,
          digest: `sha256:${digest}`,
        })
        if (!unpacked) return undefined
        // A reinstalled distribution may not match the old index for this root.
        yield* ctx.fs.remove(data, { recursive: true, force: true }).pipe(Effect.ignore)
      }
      const launcher = (yield* ctx.fs.readDirectory(plugins).pipe(Effect.orElseSucceed(() => [] as string[]))).find((item) =>
        /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(item),
      )
      if (!launcher || !(yield* ctx.fs.existsSafe(path.join(plugins, launcher)))) return undefined
      const configuration = path.join(
        distribution,
        JDTLS_CONFIGURATIONS[process.platform] ?? "config_linux",
      )
      yield* ctx.fs.makeDirectory(data, { recursive: true }).pipe(Effect.ignore)
      return LSPServer.launch(root, "java", [
        "-jar",
        path.join(plugins, launcher),
        "-configuration",
        configuration,
        "-data",
        data,
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Dlog.level=ALL",
        "--add-modules=ALL-SYSTEM",
        "--add-opens java.base/java.util=ALL-UNNAMED",
        "--add-opens java.base/java.lang=ALL-UNNAMED",
      ])
    }),
}

export const KotlinLS: LSPServer.Info = {
  id: "kotlin-ls",
  extensions: [".kt", ".kts"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      // Gradle settings first (multi-project or included build), then the wrapper, then a module build, then
      // Maven. Only the last step may fall back to the instance directory, or the earlier ones could never be skipped.
      for (const markers of [
        ["settings.gradle.kts", "settings.gradle"],
        ["gradlew", "gradlew.bat"],
        ["build.gradle.kts", "build.gradle"],
      ]) {
        const found = yield* LSPServer.strictNearestRoot(markers)(file, ctx)
        if (found) return found
      }
      return yield* LSPServer.nearestRoot(["pom.xml"])(file, ctx)
    }),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const distribution = path.join(ctx.bin, "kotlin-ls")
      // The vsix lays the server out under `extension/server`, and `bin/intellij-server` is the entry the
      // bundled `kotlin-lsp.sh` shim itself execs (that shim warns that it is deprecated).
      const launcher = path.join(
        distribution,
        "extension",
        "server",
        "bin",
        process.platform === "win32" ? "intellij-server.exe" : "intellij-server",
      )
      if (!(yield* ctx.fs.existsSafe(launcher))) {
        const release = yield* LSPServer.latestRelease(ctx, "Kotlin/kotlin-lsp")
        const build = release?.name?.replace(/^v/, "")
        const token = `${platform({ darwin: "mac", win32: "win" })}-${arch({ x64: "amd64", arm64: "aarch64" })}`
        if (!build || !["mac-amd64", "mac-aarch64", "linux-amd64", "linux-aarch64", "win-amd64", "win-aarch64"].includes(token))
          return undefined
        // The artifact name embeds an extension version the tag does not carry, so the publisher's own link
        // for this platform is the only coherent source. Requiring the release's build in the path keeps a
        // stale link from a previous release from being used.
        const links = [
          ...(release?.body ?? "").matchAll(
            /https:\/\/download\.jetbrains\.com\/language-server\/kotlin-server\/[^\s)"']+\.vsix(?![.\w])/g,
          ),
        ].map((match) => match[0])
        const url = links.find((link) => link.includes(`/kotlin-server/${build}/`) && link.endsWith(`-${token}.vsix`))
        if (!url) return undefined
        const sidecar = yield* ctx.install.text(`${url}.sha256`)
        const digest = sidecar ? sidecarSha256(sidecar) : undefined
        if (!digest) {
          yield* Effect.logWarning("kotlin-ls artifact has no published checksum; refusing to install it", { url })
          return undefined
        }
        // A vsix is a zip; the local name only selects the extractor.
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url,
          name: "kotlin-ls.zip",
          directory: distribution,
          digest: `sha256:${digest}`,
        })
        if (!unpacked) return undefined
        if (!(yield* ctx.fs.existsSafe(launcher))) return undefined
        yield* LSPServer.markExecutable(ctx, launcher)
      }
      return (yield* ctx.fs.existsSafe(launcher)) ? LSPServer.launch(root, launcher, ["--stdio"]) : undefined
    }),
}

// Pinned 2026-10-16 to the release that was latest then; bump deliberately after reviewing the upstream diff.
const LUA_LS_RELEASE = "3.19.2"

export const LuaLS: LSPServer.Info = {
  id: "lua-ls",
  extensions: [".lua"],
  root: LSPServer.nearestRoot([
    ".luarc.json",
    ".luarc.jsonc",
    ".luacheckrc",
    ".stylua.toml",
    "stylua.toml",
    "selene.toml",
    "selene.yml",
  ]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("lua-language-server")
      if (found) return LSPServer.launch(root, found)
      const target = `${process.platform}-${process.arch}`
      // Unlike a single-binary server, it needs its supporting files (meta/, locale/), so the whole archive is kept.
      const installation = path.join(ctx.bin, `lua-language-server-${process.arch}-${process.platform}`)
      const binary = path.join(installation, "bin", `lua-language-server${LSPServer.EXE}`)
      if (yield* ctx.fs.existsSafe(binary)) return LSPServer.launch(root, binary)
      if (!["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-ia32"].includes(target)) return undefined
      const release = yield* LSPServer.releaseByTag(ctx, "LuaLS/lua-language-server", LUA_LS_RELEASE)
      const name = `lua-language-server-${release?.tag_name}-${target}.${process.platform === "win32" ? "zip" : "tar.gz"}`
      const asset = yield* LSPServer.releaseAsset(release, name)
      if (!asset) return undefined
      yield* ctx.fs.remove(installation, { recursive: true, force: true }).pipe(Effect.ignore)
      if (!(yield* LSPServer.installArchive(ctx, { url: asset.url, name, digest: asset.digest, into: installation }))) return undefined
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}

const TerraformRelease = Schema.Struct({
  url_shasums: Schema.optionalKey(Schema.String),
  builds: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        arch: Schema.optionalKey(Schema.String),
        os: Schema.optionalKey(Schema.String),
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
})
const decodeTerraformRelease = Schema.decodeUnknownOption(TerraformRelease)

export const TerraformLS: LSPServer.Info = {
  id: "terraform",
  extensions: [".tf", ".tfvars"],
  root: LSPServer.nearestRoot([".terraform.lock.hcl", "terraform.tfstate", "*.tf"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const initialization = { experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true } }
      const found = ctx.which("terraform-ls")
      if (found) return LSPServer.launch(root, found, ["serve"], { initialization })
      const release = Option.getOrUndefined(
        // Pinned 2026-10-16 to the release that was latest then; the version in this URL is the pin, and
        // the response's `url_shasums` list is the integrity boundary for the archive it names.
        decodeTerraformRelease(yield* ctx.install.json("https://api.releases.hashicorp.com/v1/releases/terraform-ls/0.39.0")),
      )
      const architecture = releaseArch(process.arch, { x64: "amd64", arm64: "arm64" })
      if (!architecture) return undefined
      const url = release?.builds?.find(
        (build) => build.arch === architecture && build.os === platform({ win32: "windows" }),
      )?.url
      if (!url) return undefined
      // HashiCorp publishes no digest for the archive itself, only this list; without a matching line the
      // install must not proceed, or the checksum check would silently disappear whenever the list is absent.
      const sums = release?.url_shasums ? yield* ctx.install.text(release.url_shasums) : undefined
      const digest = sums ? checksumSha256(sums, url) : undefined
      if (!digest) {
        yield* Effect.logWarning("terraform-ls archive has no published checksum; refusing to install it", { url })
        return undefined
      }
      if (!(yield* LSPServer.installArchive(ctx, { url, name: "terraform-ls.zip", digest: `sha256:${digest}` }))) return undefined
      const binary = path.join(ctx.bin, `terraform-ls${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary, ["serve"], { initialization })
    }),
}

// Pinned 2026-10-16 to the release that was latest then; bump deliberately after reviewing the upstream diff.
const TEXLAB_RELEASE = "v5.26.0"

export const TexLab: LSPServer.Info = {
  id: "texlab",
  extensions: [".tex", ".bib"],
  root: LSPServer.nearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("texlab")
      if (found) return LSPServer.launch(root, found)
      const release = yield* LSPServer.releaseByTag(ctx, "latex-lsp/texlab", TEXLAB_RELEASE)
      if (!release?.tag_name) return undefined
      const architecture = releaseArch(process.arch, { x64: "x86_64", arm64: "aarch64" })
      if (!architecture) return undefined
      const name = `texlab-${architecture}-${platform({ darwin: "macos", win32: "windows", linux: "linux" })}.${process.platform === "win32" ? "zip" : "tar.gz"}`
      const asset = yield* LSPServer.releaseAsset(release, name)
      if (!asset || !(yield* LSPServer.installArchive(ctx, { url: asset.url, name, digest: asset.digest }))) return undefined
      const binary = path.join(ctx.bin, `texlab${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}

// Pinned 2026-10-16 to the release that was latest then; bump deliberately after reviewing the upstream diff.
const TINYMIST_RELEASE = "v0.15.8"

export const Tinymist: LSPServer.Info = {
  id: "tinymist",
  extensions: [".typ", ".typc"],
  root: LSPServer.nearestRoot(["typst.toml"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("tinymist")
      if (found) return LSPServer.launch(root, found)
      const release = yield* LSPServer.releaseByTag(ctx, "Myriad-Dreamin/tinymist", TINYMIST_RELEASE)
      if (!release) return undefined
      const triple = platform({ darwin: "apple-darwin", win32: "pc-windows-msvc", linux: "unknown-linux-gnu" })
      const extension = process.platform === "win32" ? "zip" : "tar.gz"
      const architecture = releaseArch(process.arch, { x64: "x86_64", arm64: "aarch64" })
      if (!architecture) return undefined
      const name = `tinymist-${architecture}-${triple}.${extension}`
      const asset = yield* LSPServer.releaseAsset(release, name)
      if (!asset || !(yield* LSPServer.installArchive(ctx, { url: asset.url, name, digest: asset.digest, strip: extension === "zip" ? undefined : 1 })))
        return undefined
      const binary = path.join(ctx.bin, `tinymist${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}
