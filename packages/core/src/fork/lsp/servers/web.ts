import { Effect } from "effect"
import path from "path"
import { LSPServer } from "../server.js"

/** A server shipped as an npm package: a binary already on PATH wins, otherwise the package is installed. */
const npmServer = (input: {
  readonly id: string
  readonly extensions: readonly string[]
  readonly root: LSPServer.Info["root"]
  readonly command: string
  readonly pkg: string
  readonly args: readonly string[]
  readonly initialization?: Record<string, unknown>
}): LSPServer.Info => ({
  id: input.id,
  extensions: input.extensions,
  root: input.root,
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const binary = ctx.which(input.command) ?? (yield* ctx.install.npm(input.pkg))
      if (!binary) return undefined
      return LSPServer.launch(root, binary, input.args, { initialization: input.initialization })
    }),
})

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

export const Deno: LSPServer.Info = {
  id: "deno",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  root: LSPServer.strictNearestRoot(["deno.json", "deno.jsonc"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const deno = ctx.which("deno")
      return deno ? LSPServer.launch(root, deno, ["lsp"]) : undefined
    }),
}

export const Typescript: LSPServer.Info = {
  id: "typescript",
  extensions: JS_EXTENSIONS,
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES, ["deno.json", "deno.jsonc"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const tsserver = LSPServer.resolveModule("typescript/lib/tsserver.js", ctx.directory)
      if (!tsserver) return undefined
      // A hand-installed server is preferred; with downloads disabled it is the only source.
      const binary = ctx.which("typescript-language-server") ?? (yield* ctx.install.npm("typescript-language-server"))
      if (!binary) return undefined
      return LSPServer.launch(root, binary, ["--stdio"], { initialization: { tsserver: { path: tsserver } } })
    }),
}

export const Vue = npmServer({
  id: "vue",
  extensions: [".vue"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  command: "vue-language-server",
  pkg: "@vue/language-server",
  args: ["--stdio"],
  // Left empty on purpose: the server detects the workspace's TypeScript itself.
  initialization: {},
})

export const ESLint: LSPServer.Info = {
  id: "eslint",
  extensions: [...JS_EXTENSIONS, ".vue"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      if (!LSPServer.resolveModule("eslint", ctx.directory)) return undefined
      const server = path.join(ctx.bin, "vscode-eslint", "server", "out", "eslintServer.js")
      if (!(yield* ctx.fs.existsSafe(server))) {
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url: "https://github.com/microsoft/vscode-eslint/archive/refs/heads/main.zip",
          name: "vscode-eslint.zip",
        })
        if (!unpacked) return undefined
        const installed = path.join(ctx.bin, "vscode-eslint")
        yield* ctx.fs.remove(installed, { recursive: true, force: true })
        yield* ctx.fs.rename(path.join(ctx.bin, "vscode-eslint-main"), installed)
        const npm = process.platform === "win32" ? "npm.cmd" : "npm"
        yield* ctx.install.run(npm, ["install"], { cwd: installed })
        yield* ctx.install.run(npm, ["run", "compile"], { cwd: installed })
      }
      return LSPServer.launch(root, "node", [server, "--stdio"])
    }),
}

export const Oxlint: LSPServer.Info = {
  id: "oxlint",
  extensions: [...JS_EXTENSIONS, ".vue", ".astro", ".svelte"],
  root: LSPServer.nearestRoot([".oxlintrc.json", ...LSPServer.JAVASCRIPT_LOCKFILES, "package.json"]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const suffix = process.platform === "win32" ? ".cmd" : ""
      // A project-local binary first, then one in an ancestor up to the worktree, then PATH.
      const resolve = (name: string) =>
        Effect.gen(function* () {
          const local = path.join(root, "node_modules", ".bin", name + suffix)
          if (yield* ctx.fs.existsSafe(local)) return local
          return yield* LSPServer.findUp(ctx, [path.join("node_modules", ".bin", name + suffix)], root, ctx.worktree)
        })
      const lint = (yield* resolve("oxlint")) ?? ctx.which("oxlint")
      if (lint) {
        const help = yield* ctx.probe(lint, ["--help"])
        if (help.stdout.includes("--lsp")) return LSPServer.launch(root, lint, ["--lsp"])
      }
      const server = (yield* resolve("oxc_language_server")) ?? ctx.which("oxc_language_server")
      return server ? LSPServer.launch(root, server) : undefined
    }),
}

export const Biome: LSPServer.Info = {
  id: "biome",
  extensions: [
    ...JS_EXTENSIONS,
    ".json",
    ".jsonc",
    ".vue",
    ".astro",
    ".svelte",
    ".css",
    ".graphql",
    ".gql",
    ".html",
  ],
  root: LSPServer.nearestRoot(["biome.json", "biome.jsonc", ...LSPServer.JAVASCRIPT_LOCKFILES]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const local = path.join(root, "node_modules", ".bin", "biome")
      const found = (yield* ctx.fs.existsSafe(local)) ? local : ctx.which("biome")
      if (found) return LSPServer.launch(root, found, ["lsp-proxy", "--stdio"])
      if (!LSPServer.resolveModule("biome", root)) return undefined
      const installed = yield* ctx.install.npm("biome")
      return installed ? LSPServer.launch(root, installed, ["lsp-proxy", "--stdio"]) : undefined
    }),
}

export const Svelte = npmServer({
  id: "svelte",
  extensions: [".svelte"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  command: "svelteserver",
  pkg: "svelte-language-server",
  args: ["--stdio"],
  initialization: {},
})

export const Astro: LSPServer.Info = {
  id: "astro",
  extensions: [".astro"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const tsserver = LSPServer.resolveModule("typescript/lib/tsserver.js", ctx.directory)
      if (!tsserver) return undefined
      const binary = ctx.which("astro-ls") ?? (yield* ctx.install.npm("@astrojs/language-server"))
      if (!binary) return undefined
      return LSPServer.launch(root, binary, ["--stdio"], { initialization: { typescript: { tsdk: path.dirname(tsserver) } } })
    }),
}

export const YamlLS = npmServer({
  id: "yaml-ls",
  extensions: [".yaml", ".yml"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  command: "yaml-language-server",
  pkg: "yaml-language-server",
  args: ["--stdio"],
})

export const PHPIntelephense = npmServer({
  id: "php intelephense",
  extensions: [".php"],
  root: LSPServer.nearestRoot(["composer.json", "composer.lock", ".php-version"]),
  command: "intelephense",
  pkg: "intelephense",
  args: ["--stdio"],
  initialization: { telemetry: { enabled: false } },
})

export const Prisma: LSPServer.Info = {
  id: "prisma",
  extensions: [".prisma"],
  root: LSPServer.nearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"], ["package.json"]),
  spawn: (root, ctx) =>
    Effect.sync(() => {
      const prisma = ctx.which("prisma")
      return prisma ? LSPServer.launch(root, prisma, ["language-server"]) : undefined
    }),
}

export const BashLS = npmServer({
  id: "bash",
  extensions: [".sh", ".bash", ".zsh", ".ksh"],
  root: (_file, ctx) => Effect.succeed(ctx.directory),
  command: "bash-language-server",
  pkg: "bash-language-server",
  args: ["start"],
})

export const DockerfileLS = npmServer({
  id: "dockerfile",
  extensions: [".dockerfile", "Dockerfile"],
  root: (_file, ctx) => Effect.succeed(ctx.directory),
  command: "docker-langserver",
  pkg: "dockerfile-language-server-nodejs",
  args: ["--stdio"],
})
