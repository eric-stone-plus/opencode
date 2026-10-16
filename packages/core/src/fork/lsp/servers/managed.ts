import { Effect, Option, Schema } from "effect"
import path from "path"
import { LSPServer } from "../server.js"

// Servers that are downloaded or built when no copy is installed. Every fetch, build, and install goes
// through `ctx.install`, which does nothing when downloads are disabled.

const arch = (names: Record<string, string>) => names[process.arch] ?? process.arch
const platform = (names: Record<string, string>) => names[process.platform] ?? process.platform

export const ElixirLS: LSPServer.Info = {
  id: "elixir-ls",
  extensions: [".ex", ".exs"],
  root: LSPServer.nearestRoot(["mix.exs", "mix.lock"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("elixir-ls")
      if (found) return LSPServer.launch(root, found)
      const release = path.join(ctx.bin, "elixir-ls-master")
      const binary = path.join(release, "release", process.platform === "win32" ? "language_server.bat" : "language_server.sh")
      if (!(yield* ctx.fs.existsSafe(binary))) {
        if (!ctx.which("elixir")) return undefined
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url: "https://github.com/elixir-lsp/elixir-ls/archive/refs/heads/master.zip",
          name: "elixir-ls.zip",
        })
        if (!unpacked) return undefined
        const build = { cwd: release, env: { MIX_ENV: "prod" } }
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
      const url = LSPServer.assetUrl(yield* LSPServer.latestRelease(ctx, "zigtools/zls"), name)
      if (!url || !(yield* LSPServer.installArchive(ctx, { url, name }))) return undefined
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
    const installed = yield* ctx.install.run("dotnet", ["tool", "install", "--global", "roslyn-language-server", "--prerelease"])
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

/** The Razor tooling bundled with the VS Code C# extension, newest installation first. */
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
    for (const root of new Set(roots)) {
      const entries = yield* ctx.fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]))
      const installations = yield* Effect.forEach(
        entries.filter((entry) => entry.startsWith("ms-dotnettools.csharp-")),
        (entry) =>
          ctx.fs.stat(path.join(root, entry)).pipe(
            Effect.map((info) => ({ entry, modified: Option.getOrElse(info.mtime, () => new Date(0)).getTime() })),
            Effect.orElseSucceed(() => ({ entry, modified: 0 })),
          ),
      )
      for (const { entry } of installations.toSorted((a, b) => b.modified - a.modified)) {
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
      const installed = yield* ctx.install.run("dotnet", ["tool", "install", "fsautocomplete", "--tool-path", ctx.bin])
      return installed ? LSPServer.launch(root, path.join(ctx.bin, `fsautocomplete${LSPServer.EXE}`)) : undefined
    }),
}

const CLANGD_ARGS = ["--background-index", "--clang-tidy"]
const CLANGD_PLATFORMS: Record<string, string> = { darwin: "mac", linux: "linux", win32: "windows" }

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

      const release = yield* LSPServer.latestRelease(ctx, "clangd/clangd")
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
      if (!(yield* LSPServer.installArchive(ctx, { url: asset.browser_download_url, name: asset.name }))) return undefined
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
      const major = /"(\d+)\.\d+\.\d+"/.exec(version.stderr)?.[1]
      if (major === undefined || Number.parseInt(major) < 21) return undefined
      const distribution = path.join(ctx.bin, "jdtls")
      const plugins = path.join(distribution, "plugins")
      if (!(yield* ctx.fs.existsSafe(plugins))) {
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url: "https://www.eclipse.org/downloads/download.php?file=/jdtls/snapshots/jdt-language-server-latest.tar.gz",
          name: "release.tar.gz",
          directory: distribution,
        })
        if (!unpacked) return undefined
      }
      const launcher = (yield* ctx.fs.readDirectory(plugins).pipe(Effect.orElseSucceed(() => [] as string[]))).find((item) =>
        /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(item),
      )
      if (!launcher || !(yield* ctx.fs.existsSafe(path.join(plugins, launcher)))) return undefined
      const configuration = path.join(
        distribution,
        JDTLS_CONFIGURATIONS[process.platform] ?? "config_linux",
      )
      const data = yield* ctx.fs.makeTempDirectory({ prefix: "opencode-jdtls-data" })
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
      const launcher = path.join(distribution, process.platform === "win32" ? "kotlin-lsp.cmd" : "kotlin-lsp.sh")
      if (!(yield* ctx.fs.existsSafe(launcher))) {
        const version = (yield* LSPServer.latestRelease(ctx, "Kotlin/kotlin-lsp"))?.name?.replace(/^v/, "")
        const combo = `${platform({ darwin: "mac", win32: "win" })}-${arch({ arm64: "aarch64" })}`
        if (!version || !["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"].includes(combo))
          return undefined
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url: `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/kotlin-lsp-${version}-${combo}.zip`,
          name: "kotlin-ls.zip",
          directory: distribution,
        })
        if (!unpacked) return undefined
        yield* LSPServer.markExecutable(ctx, launcher)
      }
      return (yield* ctx.fs.existsSafe(launcher)) ? LSPServer.launch(root, launcher, ["--stdio"]) : undefined
    }),
}

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
      const release = yield* LSPServer.latestRelease(ctx, "LuaLS/lua-language-server")
      const name = `lua-language-server-${release?.tag_name}-${target}.${process.platform === "win32" ? "zip" : "tar.gz"}`
      const url = LSPServer.assetUrl(release, name)
      if (!url) return undefined
      yield* ctx.fs.remove(installation, { recursive: true, force: true }).pipe(Effect.ignore)
      if (!(yield* LSPServer.installArchive(ctx, { url, name, into: installation }))) return undefined
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}

const TerraformRelease = Schema.Struct({
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
        decodeTerraformRelease(yield* ctx.install.json("https://api.releases.hashicorp.com/v1/releases/terraform-ls/latest")),
      )
      const url = release?.builds?.find(
        (build) => build.arch === (process.arch === "arm64" ? "arm64" : "amd64") && build.os === platform({ win32: "windows" }),
      )?.url
      if (!url || !(yield* LSPServer.installArchive(ctx, { url, name: "terraform-ls.zip" }))) return undefined
      const binary = path.join(ctx.bin, `terraform-ls${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary, ["serve"], { initialization })
    }),
}

export const TexLab: LSPServer.Info = {
  id: "texlab",
  extensions: [".tex", ".bib"],
  root: LSPServer.nearestRoot([".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("texlab")
      if (found) return LSPServer.launch(root, found)
      const release = yield* LSPServer.latestRelease(ctx, "latex-lsp/texlab")
      if (!release?.tag_name) return undefined
      const name = `texlab-${process.arch === "arm64" ? "aarch64" : "x86_64"}-${platform({ darwin: "macos", win32: "windows", linux: "linux" })}.${process.platform === "win32" ? "zip" : "tar.gz"}`
      const url = LSPServer.assetUrl(release, name)
      if (!url || !(yield* LSPServer.installArchive(ctx, { url, name }))) return undefined
      const binary = path.join(ctx.bin, `texlab${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}

export const Tinymist: LSPServer.Info = {
  id: "tinymist",
  extensions: [".typ", ".typc"],
  root: LSPServer.nearestRoot(["typst.toml"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("tinymist")
      if (found) return LSPServer.launch(root, found)
      const release = yield* LSPServer.latestRelease(ctx, "Myriad-Dreamin/tinymist")
      if (!release) return undefined
      const triple = platform({ darwin: "apple-darwin", win32: "pc-windows-msvc", linux: "unknown-linux-gnu" })
      const extension = process.platform === "win32" ? "zip" : "tar.gz"
      const name = `tinymist-${process.arch === "arm64" ? "aarch64" : "x86_64"}-${triple}.${extension}`
      const url = LSPServer.assetUrl(release, name)
      if (!url || !(yield* LSPServer.installArchive(ctx, { url, name, strip: extension === "zip" ? undefined : 1 }))) return undefined
      const binary = path.join(ctx.bin, `tinymist${LSPServer.EXE}`)
      if (!(yield* ctx.fs.existsSafe(binary))) return undefined
      yield* LSPServer.markExecutable(ctx, binary)
      return LSPServer.launch(root, binary)
    }),
}
