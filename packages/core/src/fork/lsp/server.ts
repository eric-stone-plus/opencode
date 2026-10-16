export * as LSPServer from "./server.js"

import { Effect, Option, Result, Schema, Stream } from "effect"
import type { Duration } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess } from "effect/process"
import { createRequire } from "node:module"
import path from "path"
import type { FSUtil } from "@opencode/util/fs-util"
import type { Npm } from "@opencode/util/npm"
import type { AppProcess } from "@opencode/util/process"
import { which } from "../../util/which.js"

export const EXE = process.platform === "win32" ? ".exe" : ""

export interface Flags {
  /** No server may fetch, build, or install anything; only software already on the machine is used. */
  readonly disableDownload: boolean
  /** Use `ty` instead of Pyright for Python. */
  readonly experimentalTy: boolean
}

const truthy = (value: string | undefined) => ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "")

export const flagsFromEnv = (env: NodeJS.ProcessEnv): Flags => ({
  disableDownload: truthy(env.OPENCODE_DISABLE_LSP_DOWNLOAD),
  experimentalTy: truthy(env.OPENCODE_EXPERIMENTAL_LSP_TY),
})

/** How to start a server process, resolved by `Info.spawn` and run by the client. */
export interface Handle {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
}

export interface ProbeResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Everything that fetches or builds software. Servers reach the network, npm, and compilers only through
 * this object, and with downloads disabled every member is inert, so the opt-out holds for every
 * server by construction instead of by a check in each one.
 */
export interface Install {
  readonly enabled: boolean
  /** Resolves the `bin` (or the package's only binary) of an npm package, installing the package if needed. */
  readonly npm: (pkg: string, bin?: string) => Effect.Effect<string | undefined>
  /** Runs an installer or build step. True when it exited successfully. */
  readonly run: (command: string, args: readonly string[], options?: RunOptions) => Effect.Effect<boolean>
  /** Fetches a JSON document, undefined on any failure. */
  readonly json: (url: string) => Effect.Effect<unknown>
  /** Streams a URL to a file. True when a non-empty file was written. */
  readonly download: (url: string, destination: string) => Effect.Effect<boolean>
  /** Unpacks a .zip, .tar.gz or .tar.xz archive into `destination`. */
  readonly extract: (archive: string, destination: string, options?: { readonly strip?: number }) => Effect.Effect<boolean>
}

export interface Context {
  readonly directory: string
  /** The project worktree; the filesystem root for projects without one. */
  readonly worktree: string
  /** Where downloaded tools are installed. */
  readonly bin: string
  readonly home: string
  readonly env: NodeJS.ProcessEnv
  readonly flags: Flags
  readonly fs: FSUtil.Interface
  /** A command on PATH or in `bin`. */
  readonly which: (command: string) => string | undefined
  /** Runs a short read-only command to inspect the machine (a version, a help text). Never installs. */
  readonly probe: (command: string, args: readonly string[], options?: RunOptions) => Effect.Effect<ProbeResult>
  readonly install: Install
}

export interface Info {
  readonly id: string
  readonly extensions: readonly string[]
  /** The project root a server for `file` should start in, or undefined when the server does not apply. */
  readonly root: (file: string, ctx: Context) => Effect.Effect<string | undefined>
  /** Resolves how to start the server, or undefined when it is unavailable. */
  readonly spawn: (root: string, ctx: Context) => Effect.Effect<Handle | undefined, unknown>
}

export const launch = (
  root: string,
  command: string,
  args: readonly string[] = [],
  extra: Pick<Handle, "env" | "initialization"> = {},
): Handle => ({ command, args, cwd: root, ...extra })

export function resolveModule(id: string, directory: string) {
  return Result.getOrUndefined(
    Result.try({ try: () => createRequire(path.join(directory, "package.json")).resolve(id), catch: () => undefined }),
  )
}

/** The first of `targets` found walking up from `start` to `stop`, nearest directory first. */
export const findUp = (ctx: Context, targets: string[], start: string, stop = ctx.directory) =>
  ctx.fs.up({ targets, start, stop, mode: "first" }).pipe(
    Effect.map((found) => found[0]),
    Effect.orElseSucceed(() => undefined),
  )

/** Nearest directory holding one of `include`, falling back to the instance directory; undefined if `exclude` matches first. */
export const nearestRoot =
  (include: string[], exclude?: string[]): Info["root"] =>
  (file, ctx) =>
    Effect.gen(function* () {
      if (exclude && (yield* findUp(ctx, exclude, path.dirname(file)))) return undefined
      const found = yield* findUp(ctx, include, path.dirname(file))
      return found ? path.dirname(found) : ctx.directory
    })

/** Like `nearestRoot` but a server only applies where a marker exists. */
export const strictNearestRoot =
  (include: string[], exclude?: string[]): Info["root"] =>
  (file, ctx) =>
    Effect.gen(function* () {
      if (exclude && (yield* findUp(ctx, exclude, path.dirname(file)))) return undefined
      const found = yield* findUp(ctx, include, path.dirname(file))
      return found ? path.dirname(found) : undefined
    })

export const JAVASCRIPT_LOCKFILES = ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]

const GithubRelease = Schema.Struct({
  tag_name: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  assets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.optionalKey(Schema.String), browser_download_url: Schema.optionalKey(Schema.String) }),
    ),
  ),
})
const decodeRelease = Schema.decodeUnknownOption(GithubRelease)

/** The latest GitHub release of `repository` (owner/name); undefined when it cannot be fetched. */
export const latestRelease = (ctx: Context, repository: string) =>
  ctx.install
    .json(`https://api.github.com/repos/${repository}/releases/latest`)
    .pipe(Effect.map((value) => Option.getOrUndefined(decodeRelease(value))))

export const assetUrl = (release: typeof GithubRelease.Type | undefined, name: string) =>
  release?.assets?.find((asset) => asset.name === name)?.browser_download_url

/** Downloads an archive (into `ctx.bin` unless told otherwise), unpacks it into `into`, and removes the archive. */
export const installArchive = (
  ctx: Context,
  input: {
    readonly url: string
    readonly name: string
    readonly directory?: string
    readonly into?: string
    readonly strip?: number
  },
) =>
  Effect.gen(function* () {
    // `name` can come straight from a release API response, so only its basename may become a local path;
    // a `../` inside it would otherwise write outside the binary directory.
    const archive = path.join(input.directory ?? ctx.bin, path.basename(input.name))
    if (!(yield* ctx.install.download(input.url, archive))) {
      yield* ctx.fs.remove(archive, { force: true }).pipe(Effect.ignore)
      return false
    }
    const unpacked = yield* ctx.install.extract(archive, input.into ?? input.directory ?? ctx.bin, {
      strip: input.strip,
    })
    yield* ctx.fs.remove(archive, { force: true }).pipe(Effect.ignore)
    return unpacked
  })

export const markExecutable = (ctx: Context, file: string) =>
  process.platform === "win32" ? Effect.void : ctx.fs.chmod(file, 0o755).pipe(Effect.ignore)

/** Where Python tooling conventionally keeps a virtual environment for a project. */
export const virtualEnvironments = (ctx: Context, root: string) =>
  [ctx.env["VIRTUAL_ENV"], path.join(root, ".venv"), path.join(root, "venv")].filter(
    (candidate): candidate is string => candidate !== undefined,
  )

/** An executable inside a virtual environment's script directory. */
export const virtualEnvironmentBinary = (venv: string, name: string) =>
  process.platform === "win32" ? path.join(venv, "Scripts", `${name}.exe`) : path.join(venv, "bin", name)

export const firstExisting = (ctx: Context, files: readonly string[]) =>
  Effect.gen(function* () {
    for (const file of files) if (yield* ctx.fs.existsSafe(file)) return file
    return undefined
  })

/** The interpreter of the first virtual environment that has one. */
export const virtualEnvironmentPython = (ctx: Context, root: string) =>
  firstExisting(
    ctx,
    virtualEnvironments(ctx, root).map((venv) => virtualEnvironmentBinary(venv, "python")),
  )

const run = (
  processes: AppProcess.Interface,
  command: string,
  args: readonly string[],
  options: RunOptions,
  timeout: Duration.Input,
) =>
  processes
    .run(ChildProcess.make(command, [...args], { cwd: options.cwd, env: options.env, extendEnv: true, stdin: "ignore" }), {
      timeout,
      maxOutputBytes: 1024 * 1024,
      maxErrorBytes: 1024 * 1024,
    })
    .pipe(
      Effect.map((result) => ({
        code: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      })),
      Effect.orElseSucceed(() => ({ code: 127, stdout: "", stderr: "" })),
    )

export const makeContext = (input: {
  readonly directory: string
  readonly worktree: string
  readonly bin: string
  readonly home: string
  readonly env: NodeJS.ProcessEnv
  readonly flags: Flags
  readonly fs: FSUtil.Interface
  readonly npm: Npm.Interface
  readonly processes: AppProcess.Interface
  readonly http: HttpClient.HttpClient
}): Context => {
  const enabled = !input.flags.disableDownload
  const http = HttpClient.filterStatusOk(input.http)
  const inert: Install = {
    enabled,
    npm: () => Effect.succeed(undefined),
    run: () => Effect.succeed(false),
    json: () => Effect.succeed(undefined),
    download: () => Effect.succeed(false),
    extract: () => Effect.succeed(false),
  }
  const install: Install = enabled
    ? {
        enabled,
        npm: (pkg, bin) => input.npm.which(pkg, bin),
        run: (command, args, options = {}) =>
          run(input.processes, command, args, options, "10 minutes").pipe(Effect.map((result) => result.code === 0)),
        json: (url) =>
          http.execute(HttpClientRequest.get(url, { headers: { accept: "application/vnd.github+json" } })).pipe(
            Effect.flatMap((response) => response.json),
            Effect.orElseSucceed(() => undefined),
          ),
        download: (url, destination) =>
          Effect.gen(function* () {
            yield* input.fs.makeDirectory(path.dirname(destination), { recursive: true })
            const response = yield* http.execute(HttpClientRequest.get(url))
            yield* response.stream.pipe(Stream.run(input.fs.sink(destination)))
            return Number((yield* input.fs.stat(destination)).size) > 0
          }).pipe(Effect.orElseSucceed(() => false)),
        extract: (archive, destination, options = {}) =>
          input.fs.makeDirectory(destination, { recursive: true }).pipe(
            Effect.andThen(
              archive.endsWith(".zip")
                ? process.platform === "win32"
                  ? run(
                      input.processes,
                      "powershell",
                      [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
                      ],
                      {},
                      "10 minutes",
                    )
                  : run(input.processes, "unzip", ["-o", "-q", archive, "-d", destination], {}, "10 minutes")
                : run(
                    input.processes,
                    "tar",
                    [
                      archive.endsWith(".tar.xz") ? "-xf" : "-xzf",
                      archive,
                      "-C",
                      destination,
                      ...(options.strip ? [`--strip-components=${options.strip}`] : []),
                    ],
                    {},
                    "10 minutes",
                  ),
            ),
            Effect.map((result) => result.code === 0),
            Effect.orElseSucceed(() => false),
          ),
      }
    : inert
  return {
    directory: input.directory,
    worktree: input.worktree,
    bin: input.bin,
    home: input.home,
    env: input.env,
    flags: input.flags,
    fs: input.fs,
    which: (command) => which(command, input.env, input.bin) ?? undefined,
    probe: (command, args, options = {}) => run(input.processes, command, args, options, "10 seconds"),
    install,
  }
}
