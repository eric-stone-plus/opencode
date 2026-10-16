export * as LSPServer from "./server.js"

import { Cause, Effect, Option, Result, Schema, Stream } from "effect"
import type { Duration } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess } from "effect/process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import path from "path"
import type { FSUtil } from "@opencode/util/fs-util"
import type { Npm } from "@opencode/util/npm"
import type { AppProcess } from "@opencode/util/process"
import { which } from "../../util/which.js"

export const EXE = process.platform === "win32" ? ".exe" : ""

/** Refuses artifacts larger than this; the largest language server archive is well under it. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/** The only digest form GitHub's release API publishes; anything else cannot be verified. */
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/i

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
  /** True when the command could not be run at all (missing binary, timeout, output overflow); `code` is 127 then, not an exit. */
  readonly failed: boolean
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
  /** Fetches a text document (a checksum list or sidecar), undefined on any failure. */
  readonly text: (url: string) => Effect.Effect<string | undefined>
  /** Streams a URL to a file. True when the complete file was written and matched `digest` when one is given. */
  readonly download: (
    url: string,
    destination: string,
    options?: { readonly digest?: string; readonly maxBytes?: number },
  ) => Effect.Effect<boolean>
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

/** The first of `targets` found walking up from `start` to `stop` (the worktree root by default), nearest first. */
export const findUp = (ctx: Context, targets: string[], start: string, stop = ctx.worktree) =>
  ctx.fs.up({ targets, start, stop, mode: "first" }).pipe(
    Effect.map((found) => found[0]),
    Effect.tapError((error) => Effect.logWarning("LSP root lookup failed", { targets, start, stop, error: String(error) })),
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
  /** The release notes; some publishers put their only per-platform download links here. */
  body: Schema.optionalKey(Schema.String),
  assets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        browser_download_url: Schema.optionalKey(Schema.String),
        /** GitHub's published `sha256:<hex>` for the uploaded asset; absent on releases uploaded before it existed. */
        digest: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
})
const decodeRelease = Schema.decodeUnknownOption(GithubRelease)

/** The latest GitHub release of `repository` (owner/name); undefined when it cannot be fetched. */
export const latestRelease = (ctx: Context, repository: string) =>
  ctx.install
    .json(`https://api.github.com/repos/${repository}/releases/latest`)
    .pipe(Effect.map((value) => Option.getOrUndefined(decodeRelease(value))))

/** The GitHub release tagged `tag` of `repository` (owner/name); undefined when it cannot be fetched. */
export const releaseByTag = (ctx: Context, repository: string, tag: string) =>
  ctx.install
    .json(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`)
    .pipe(Effect.map((value) => Option.getOrUndefined(decodeRelease(value))))

export interface ReleaseAsset {
  readonly url: string
  readonly digest: string
}

/**
 * The URL and the sha256 digest GitHub publishes for the release asset `name`. Refuses (undefined, with a
 * log) when the asset or its digest is missing: an unverified archive must not be unpacked into `ctx.bin`.
 */
export const releaseAsset = (release: typeof GithubRelease.Type | undefined, name: string) =>
  Effect.gen(function* () {
    const asset = release?.assets?.find((item) => item.name === name)
    if (!asset?.browser_download_url) return undefined
    if (!asset.digest) {
      yield* Effect.logWarning("GitHub release asset has no published digest; refusing to install it", { asset: name })
      return undefined
    }
    return { url: asset.browser_download_url, digest: asset.digest } satisfies ReleaseAsset
  })

/** Downloads an archive (into `ctx.bin` unless told otherwise), unpacks it into `into`, and removes the archive. */
export const installArchive = (
  ctx: Context,
  input: {
    readonly url: string
    readonly name: string
    readonly directory?: string
    readonly into?: string
    readonly strip?: number
    /** The `sha256:<hex>` digest the artifact must match; GitHub publishes one for every release asset. */
    readonly digest?: string
  },
) =>
  Effect.gen(function* () {
    // `name` can come straight from a release API response, so only its basename may become a local path;
    // a `../` inside it would otherwise write outside the binary directory.
    const archive = path.join(input.directory ?? ctx.bin, path.basename(input.name))
    if (!(yield* ctx.install.download(input.url, archive, { digest: input.digest }))) {
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
    // An empty VIRTUAL_ENV would become the relative path `bin/python`, resolved against the process CWD.
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
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
        failed: false,
      })),
      // 127 is also a plausible exit code, so callers need `failed` to tell "could not run" from "exited 127".
      Effect.catchCause((cause) =>
        Effect.logWarning("LSP command could not be run", { command, cause: Cause.pretty(cause) }).pipe(
          Effect.as({ code: 127, stdout: "", stderr: Cause.pretty(cause), failed: true }),
        ),
      ),
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
  // Empty means every host stays reachable, so an operator opts in by naming the hosts they allow.
  const allowedHosts = new Set(
    (input.env.OPENCODE_LSP_DOWNLOAD_HOSTS ?? "")
      .split(/[,\s]+/)
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  )
  const hostAllowed = (url: string) => {
    if (allowedHosts.size === 0) return true
    if (!URL.canParse(url)) return false
    return allowedHosts.has(new URL(url).hostname.toLowerCase())
  }
  // The allowlist has to hold for the final URL too: a redirect from an allowlisted host would otherwise
  // fetch from a host the operator did not name. The response's URL is where the body actually came from.
  const fetchDocument = (url: string, headers?: Record<string, string>) =>
    Effect.gen(function* () {
      if (!hostAllowed(url)) {
        yield* Effect.logWarning("LSP metadata host is not in OPENCODE_LSP_DOWNLOAD_HOSTS; refusing the request", { url })
        return undefined
      }
      const response = yield* http.execute(HttpClientRequest.get(url, headers ? { headers } : undefined))
      if (!hostAllowed(response.url)) {
        yield* Effect.logWarning("LSP metadata redirect left OPENCODE_LSP_DOWNLOAD_HOSTS; refusing the response", {
          url,
          final: response.url,
        })
        return undefined
      }
      return response
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  const inert: Install = {
    enabled,
    npm: () => Effect.succeed(undefined),
    run: () => Effect.succeed(false),
    json: () => Effect.succeed(undefined),
    text: () => Effect.succeed(undefined),
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
          fetchDocument(url, { accept: "application/vnd.github+json" }).pipe(
            Effect.flatMap((response) =>
              response ? response.json.pipe(Effect.orElseSucceed(() => undefined)) : Effect.succeed(undefined),
            ),
          ),
        text: (url) =>
          fetchDocument(url).pipe(
            Effect.flatMap((response) =>
              response ? response.text.pipe(Effect.orElseSucceed(() => undefined)) : Effect.succeed(undefined),
            ),
          ),
        download: (url, destination, options = {}) =>
          Effect.gen(function* () {
            if (!hostAllowed(url)) {
              yield* Effect.logWarning("LSP download host is not in OPENCODE_LSP_DOWNLOAD_HOSTS; refusing the download", {
                url,
              })
              return false
            }
            const expected = options.digest ? SHA256_DIGEST.exec(options.digest)?.[1]?.toLowerCase() : undefined
            if (options.digest && !expected) {
              yield* Effect.logWarning("LSP download digest is not a sha256 value; refusing the download", { url })
              return false
            }
            yield* input.fs.makeDirectory(path.dirname(destination), { recursive: true })
            const response = yield* http.execute(HttpClientRequest.get(url))
            // The body may come from a host the initial-URL check never saw; refuse before streaming it.
            if (!hostAllowed(response.url)) {
              yield* Effect.logWarning("LSP download redirect left OPENCODE_LSP_DOWNLOAD_HOSTS; refusing the download", {
                url,
                final: response.url,
              })
              return false
            }
            const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES
            const hash = expected ? createHash("sha256") : undefined
            let written = 0
            yield* response.stream.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  written += chunk.length
                  hash?.update(chunk)
                }),
              ),
              // Stops before the chunk that would pass the cap, so a hostile server cannot fill the disk.
              Stream.takeWhile(() => written <= maxBytes),
              Stream.run(input.fs.sink(destination)),
            )
            const size = Number((yield* input.fs.stat(destination)).size)
            const contentLength = response.headers["content-length"]
            const contentEncoding = response.headers["content-encoding"]
            const actual = hash ? `sha256:${hash.digest("hex")}` : undefined
            // A re-encoded body no longer matches Content-Length, so only an identity encoding can be checked.
            const lengthChecked = contentEncoding === undefined || contentEncoding === "identity"
            const truncated = contentLength !== undefined && lengthChecked && Number(contentLength) !== size
            if (size === 0 || size > maxBytes || size !== written || truncated || (expected && actual !== `sha256:${expected}`)) {
              yield* Effect.logWarning("LSP download failed verification; removing the partial file", {
                url,
                size,
                contentLength,
                expectedDigest: options.digest,
                actualDigest: actual,
              })
              yield* input.fs.remove(destination, { force: true }).pipe(Effect.ignore)
              return false
            }
            return true
          }).pipe(
            // Bounds a connection that never finishes; two hours does not cut off the slow links this host sees.
            Effect.timeout("2 hours"),
            Effect.catchCause((cause) =>
              Effect.logWarning("LSP download failed; removing the partial file", { url, cause: Cause.pretty(cause) }).pipe(
                Effect.andThen(input.fs.remove(destination, { force: true }).pipe(Effect.ignore)),
                Effect.as(false),
              ),
            ),
          ),
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
