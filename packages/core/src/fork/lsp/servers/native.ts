import { Effect } from "effect"
import path from "path"
import { LSPServer } from "../server.js"

const PYTHON_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]

export const Gopls: LSPServer.Info = {
  id: "gopls",
  extensions: [".go"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      const work = yield* LSPServer.nearestRoot(["go.work"])(file, ctx)
      if (work) return work
      return yield* LSPServer.nearestRoot(["go.mod", "go.sum"])(file, ctx)
    }),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("gopls")
      if (found) return LSPServer.launch(root, found)
      if (!ctx.which("go")) return undefined
      const installed = yield* ctx.install.run("go", ["install", "golang.org/x/tools/gopls@latest"], {
        env: { GOBIN: ctx.bin },
      })
      return installed ? LSPServer.launch(root, path.join(ctx.bin, `gopls${LSPServer.EXE}`)) : undefined
    }),
}

export const Rubocop: LSPServer.Info = {
  id: "ruby-lsp",
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  root: LSPServer.nearestRoot(["Gemfile"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const found = ctx.which("rubocop")
      if (found) return LSPServer.launch(root, found, ["--lsp"])
      if (!ctx.which("ruby") || !ctx.which("gem")) return undefined
      const installed = yield* ctx.install.run("gem", ["install", "rubocop", "--bindir", ctx.bin])
      return installed ? LSPServer.launch(root, path.join(ctx.bin, `rubocop${LSPServer.EXE}`), ["--lsp"]) : undefined
    }),
}

export const Ty: LSPServer.Info = {
  id: "ty",
  extensions: [".py", ".pyi"],
  root: LSPServer.nearestRoot(["pyproject.toml", "ty.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      if (!ctx.flags.experimentalTy) return undefined
      const pythonPath = yield* LSPServer.virtualEnvironmentPython(ctx, root)
      const binary =
        ctx.which("ty") ??
        (yield* LSPServer.firstExisting(
          ctx,
          LSPServer.virtualEnvironments(ctx, root).map((venv) => LSPServer.virtualEnvironmentBinary(venv, "ty")),
        ))
      return binary
        ? LSPServer.launch(root, binary, ["server"], { initialization: pythonPath ? { pythonPath } : {} })
        : undefined
    }),
}

export const Pyright: LSPServer.Info = {
  id: "pyright",
  extensions: [".py", ".pyi"],
  root: LSPServer.nearestRoot(PYTHON_MARKERS),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const binary = ctx.which("pyright-langserver") ?? (yield* ctx.install.npm("pyright", "pyright-langserver"))
      if (!binary) return undefined
      const pythonPath = yield* LSPServer.virtualEnvironmentPython(ctx, root)
      return LSPServer.launch(root, binary, ["--stdio"], { initialization: pythonPath ? { pythonPath } : {} })
    }),
}

export const SourceKit: LSPServer.Info = {
  id: "sourcekit-lsp",
  extensions: [".swift", ".objc", "objcpp"],
  root: LSPServer.nearestRoot(["Package.swift", "*.xcodeproj", "*.xcworkspace"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      // The Swift toolchain provides it on PATH; on macOS it usually lives inside Xcode.
      const found = ctx.which("sourcekit-lsp")
      if (found) return LSPServer.launch(root, found)
      if (!ctx.which("xcrun")) return undefined
      const located = yield* ctx.probe("xcrun", ["--find", "sourcekit-lsp"])
      return located.code === 0 ? LSPServer.launch(root, located.stdout.trim()) : undefined
    }),
}

export const RustAnalyzer: LSPServer.Info = {
  id: "rust",
  extensions: [".rs"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      const crate = yield* LSPServer.nearestRoot(["Cargo.toml", "Cargo.lock"])(file, ctx)
      if (crate === undefined) return undefined
      return yield* cargoWorkspaceRoot(ctx, crate, crate)
    }),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const binary = ctx.which("rust-analyzer")
      return binary ? LSPServer.launch(root, binary) : undefined
    }),
}

/** A crate inside a Cargo workspace is analysed from the workspace root, searched for up to the worktree. */
const cargoWorkspaceRoot = (ctx: LSPServer.Context, directory: string, crate: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parent = path.dirname(directory)
    if (parent === directory) return crate
    const manifest = yield* ctx.fs
      .readFileStringSafe(path.join(directory, "Cargo.toml"))
      .pipe(Effect.orElseSucceed(() => undefined))
    if (manifest?.includes("[workspace]")) return directory
    if (!parent.startsWith(ctx.worktree)) return crate
    return yield* cargoWorkspaceRoot(ctx, parent, crate)
  })

export const Dart: LSPServer.Info = {
  id: "dart",
  extensions: [".dart"],
  root: LSPServer.nearestRoot(["pubspec.yaml", "analysis_options.yaml"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const dart = ctx.which("dart")
      return dart ? LSPServer.launch(root, dart, ["language-server", "--lsp"]) : undefined
    }),
}

export const Ocaml: LSPServer.Info = {
  id: "ocaml-lsp",
  extensions: [".ml", ".mli"],
  root: LSPServer.nearestRoot(["dune-project", "dune-workspace", ".merlin", "opam"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const binary = ctx.which("ocamllsp")
      return binary ? LSPServer.launch(root, binary) : undefined
    }),
}

export const Gleam: LSPServer.Info = {
  id: "gleam",
  extensions: [".gleam"],
  root: LSPServer.nearestRoot(["gleam.toml"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const gleam = ctx.which("gleam")
      return gleam ? LSPServer.launch(root, gleam, ["lsp"]) : undefined
    }),
}

export const Clojure: LSPServer.Info = {
  id: "clojure-lsp",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  root: LSPServer.nearestRoot(["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const binary = ctx.which("clojure-lsp") ?? (process.platform === "win32" ? ctx.which("clojure-lsp.exe") : undefined)
      return binary ? LSPServer.launch(root, binary, ["listen"]) : undefined
    }),
}

export const Nixd: LSPServer.Info = {
  id: "nixd",
  extensions: [".nix"],
  root: (file, ctx) =>
    Effect.gen(function* () {
      // A flake is the most reliable Nix project root; otherwise the repository root, then the instance directory.
      const flake = yield* LSPServer.nearestRoot(["flake.nix"])(file, ctx)
      if (flake && flake !== ctx.directory) return flake
      if (ctx.worktree && ctx.worktree !== ctx.directory) return ctx.worktree
      return ctx.directory
    }),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const nixd = ctx.which("nixd")
      return nixd ? LSPServer.launch(root, nixd) : undefined
    }),
}

export const HLS: LSPServer.Info = {
  id: "haskell-language-server",
  extensions: [".hs", ".lhs"],
  root: LSPServer.nearestRoot(["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const binary = ctx.which("haskell-language-server-wrapper")
      return binary ? LSPServer.launch(root, binary, ["--lsp"]) : undefined
    }),
}

export const JuliaLS: LSPServer.Info = {
  id: "julials",
  extensions: [".jl"],
  root: LSPServer.nearestRoot(["Project.toml", "Manifest.toml", "*.jl"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const julia = ctx.which("julia")
      return julia
        ? LSPServer.launch(root, julia, ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"])
        : undefined
    }),
}
