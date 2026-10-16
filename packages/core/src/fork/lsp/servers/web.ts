import { Effect } from "effect"
import path from "path"
import { LSPServer } from "../server.js"

// Every npm package below is pinned 2026-10-16 to the version the registry published then; a bare name
// resolves the mutable `latest` dist-tag at install time. Bump deliberately after reviewing the diff.

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

/**
 * The launcher suffix npm writes into `node_modules/.bin` on Windows. Spawning the extensionless sh
 * shim fails there, so every local `.bin` lookup has to name the `.cmd` wrapper instead.
 */
export const binSuffix = (platform: NodeJS.Platform) => (platform === "win32" ? ".cmd" : "")

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
      const binary = ctx.which("typescript-language-server") ?? (yield* ctx.install.npm("typescript-language-server@6.0.2"))
      if (!binary) return undefined
      return LSPServer.launch(root, binary, ["--stdio"], { initialization: { tsserver: { path: tsserver } } })
    }),
}

export const Vue = npmServer({
  id: "vue",
  extensions: [".vue"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  command: "vue-language-server",
  pkg: "@vue/language-server@3.3.13",
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
        // Pinned 2026-10-16 to the commit of release/3.0.34, the release that was latest then; a branch
        // archive would run whatever upstream published that day. The source archive has no published
        // digest, so the commit is the integrity boundary; `npm install` then installs per the archive's
        // lockfile. Bump deliberately after reviewing the upstream diff.
        const staging = path.join(ctx.bin, "vscode-eslint-staging")
        yield* ctx.fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
        const unpacked = yield* LSPServer.installArchive(ctx, {
          url: "https://github.com/microsoft/vscode-eslint/archive/de46ae7016bc1682b6f1e0bd18262501b0e202ca.zip",
          name: "vscode-eslint.zip",
          into: staging,
        })
        if (!unpacked) return undefined
        const extracted = (yield* ctx.fs.readDirectory(staging).pipe(Effect.orElseSucceed(() => [] as string[])))[0]
        if (!extracted) return undefined
        const installed = path.join(ctx.bin, "vscode-eslint")
        yield* ctx.fs.remove(installed, { recursive: true, force: true })
        yield* ctx.fs.rename(path.join(staging, extracted), installed)
        yield* ctx.fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
        const npm = process.platform === "win32" ? "npm.cmd" : "npm"
        if (!(yield* ctx.install.run(npm, ["install"], { cwd: installed }))) return undefined
        if (!(yield* ctx.install.run(npm, ["run", "compile"], { cwd: installed }))) return undefined
        if (!(yield* ctx.fs.existsSafe(server))) return undefined
      }
      return LSPServer.launch(root, "node", [server, "--stdio"])
    }),
}

export const Oxlint: LSPServer.Info = {
  id: "oxlint",
  extensions: [...JS_EXTENSIONS, ".vue", ".astro", ".svelte"],
  // No `package.json` marker: every installed package has one, so a monorepo would root one server per
  // package, and a symlinked alias of the same package would root a second one. Every other JS server here
  // roots at a project lockfile or its own config file.
  root: LSPServer.nearestRoot([".oxlintrc.json", ...LSPServer.JAVASCRIPT_LOCKFILES]),
  spawn: (root, ctx) =>
    Effect.gen(function* () {
      const suffix = binSuffix(process.platform)
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
      // The project's own root, not the instance directory: Biome resolves the toolchain from the package
      // that declares the lockfile, which is also where its `node_modules/.bin` wrapper lives.
      const local = path.join(root, "node_modules", ".bin", `biome${binSuffix(process.platform)}`)
      const found = (yield* ctx.fs.existsSafe(local)) ? local : ctx.which("biome")
      if (found) return LSPServer.launch(root, found, ["lsp-proxy", "--stdio"])
      // The CLI package is scoped: a bare `biome` is a different (typo-squattable) registry entry, and real
      // projects depend on `@biomejs/biome`, so the guard has to look for that name too.
      if (!LSPServer.resolveModule("@biomejs/biome", root)) return undefined
      const installed = yield* ctx.install.npm("@biomejs/biome@2.5.15")
      return installed ? LSPServer.launch(root, installed, ["lsp-proxy", "--stdio"]) : undefined
    }),
}

export const Svelte = npmServer({
  id: "svelte",
  extensions: [".svelte"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  command: "svelteserver",
  pkg: "svelte-language-server@0.18.4",
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
      const binary = ctx.which("astro-ls") ?? (yield* ctx.install.npm("@astrojs/language-server@2.17.2"))
      if (!binary) return undefined
      return LSPServer.launch(root, binary, ["--stdio"], { initialization: { typescript: { tsdk: path.dirname(tsserver) } } })
    }),
}

export const YamlLS = npmServer({
  id: "yaml-ls",
  extensions: [".yaml", ".yml"],
  root: LSPServer.nearestRoot(LSPServer.JAVASCRIPT_LOCKFILES),
  command: "yaml-language-server",
  pkg: "yaml-language-server@2.0.0",
  args: ["--stdio"],
})

export const PHPIntelephense = npmServer({
  id: "php intelephense",
  extensions: [".php"],
  root: LSPServer.nearestRoot(["composer.json", "composer.lock", ".php-version"]),
  command: "intelephense",
  pkg: "intelephense@1.18.5",
  args: ["--stdio"],
  initialization: { telemetry: { enabled: false } },
})

export const Prisma: LSPServer.Info = {
  id: "prisma",
  extensions: [".prisma"],
  // No `package.json` exclusion: every Node project has one, so excluding it disabled the server for all of
  // them, schema present or not. The `.prisma` extension plus the schema markers already scope this server.
  root: LSPServer.nearestRoot(["schema.prisma", "prisma/schema.prisma", "prisma"]),
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
  pkg: "bash-language-server@5.8.1",
  args: ["start"],
})

export const DockerfileLS = npmServer({
  id: "dockerfile",
  // A bare "Dockerfile" entry can never match: the matcher compares `path.parse(file).ext || file`, which is
  // the full path for extensionless files. Basename matching would have to live in lsp.ts.
  extensions: [".dockerfile"],
  root: (_file, ctx) => Effect.succeed(ctx.directory),
  command: "docker-langserver",
  pkg: "dockerfile-language-server-nodejs@0.15.0",
  args: ["--stdio"],
})
