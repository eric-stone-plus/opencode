import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Context, Effect, Layer } from "effect"
import { Global } from "../src/global.js"

describe("global", () => {
  test("importing the module does not create directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-global-import-"))
    const directories = ["data", "cache", "config", "state", "tmp"].map((directory) => path.join(root, directory))
    const module = pathToFileURL(path.join(import.meta.dir, "../src/global.ts")).href
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", `const { Global } = await import(${JSON.stringify(module)}); void Global.Path.tmp`],
      env: {
        ...process.env,
        XDG_DATA_HOME: directories[0],
        XDG_CACHE_HOME: directories[1],
        XDG_CONFIG_HOME: directories[2],
        XDG_STATE_HOME: directories[3],
        TMPDIR: directories[4],
        // Windows resolves the platform tmp through TEMP/TMP, not TMPDIR.
        ...(process.platform === "win32" ? { TEMP: directories[4], TMP: directories[4] } : {}),
      },
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    directories.forEach((directory) => expect(fs.existsSync(path.join(directory, "opencode"))).toBe(false))
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("resolves a relative config directory against home, not the launch cwd", () => {
    const home = path.join(os.tmpdir(), "opencode-global-home")
    expect(Global.make({ home, config: ".opencode" }).config).toBe(path.join(home, ".opencode"))
    expect(Global.make({ home, config: path.join(home, "absolute") }).config).toBe(path.join(home, "absolute"))
  })

  test("building layerWith creates service directories and preserves an explicit tmp", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-global-layer-"))
    const directories = {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      log: path.join(root, "log"),
      bin: path.join(root, "bin"),
      repos: path.join(root, "repos"),
      tmp: path.join(root, "nested", "..", "tmp"),
    }

    const context = await Effect.runPromise(Effect.scoped(Layer.build(Global.layerWith(directories))))

    Object.values(directories).forEach((directory) => expect(fs.statSync(directory).isDirectory()).toBe(true))
    expect(Context.get(context, Global.Service).tmp).toBe(directories.tmp)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("creates private directories with owner-only modes and tightens existing ones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-global-private-"))
    const data = path.join(root, "data")
    const log = path.join(data, "log")
    // Simulate a data directory created by an older version with the default umask.
    fs.mkdirSync(data, { recursive: true })
    fs.chmodSync(data, 0o755)

    const directories = {
      data,
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      log,
      bin: path.join(root, "bin"),
      repos: path.join(data, "repos"),
      tmp: path.join(root, "tmp"),
    }
    await Effect.runPromise(Effect.scoped(Layer.build(Global.layerWith(directories))))

    if (process.platform !== "win32") {
      expect(fs.statSync(data).mode & 0o777).toBe(0o700)
      expect(fs.statSync(log).mode & 0o777).toBe(0o700)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("building a layer with default tmp creates and canonicalizes it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-global-layer-"))
    const directories = ["data", "cache", "config", "state", "tmp"].map((directory) => path.join(root, directory))
    // Point the platform tmp through a link so the assertion pins the canonicalization itself instead
    // of the platform's tmp layout. Windows needs privileges to create a directory symlink.
    const temporary = process.platform === "win32" ? directories[4] : path.join(root, "linked")
    if (temporary !== directories[4]) {
      fs.mkdirSync(directories[4])
      fs.symlinkSync(directories[4], temporary, "dir")
    }
    const module = pathToFileURL(path.join(import.meta.dir, "../src/global.ts")).href
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
          import { Context, Effect, Layer } from "effect"
          const { Global } = await import(${JSON.stringify(module)})
          const context = await Effect.runPromise(Effect.scoped(Layer.build(Global.layerWith({}))))
          process.stdout.write(Context.get(context, Global.Service).tmp)
        `,
      ],
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        XDG_DATA_HOME: directories[0],
        XDG_CACHE_HOME: directories[1],
        XDG_CONFIG_HOME: directories[2],
        XDG_STATE_HOME: directories[3],
        TMPDIR: temporary,
        // Windows resolves the platform tmp through TEMP/TMP, not TMPDIR.
        ...(process.platform === "win32" ? { TEMP: temporary, TMP: temporary } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    // Compare through the realpath the service itself applies: on Windows the sync call expands the
    // profile's 8.3 short name and the async one leaves it, so a sync reference measures a form the
    // service never produces there.
    expect(result.stdout.toString()).toBe(await fs.promises.realpath(path.join(temporary, "opencode")))
    const created = [
      path.join(directories[0], "opencode"),
      path.join(directories[1], "opencode", "bin"),
      path.join(directories[2], "opencode"),
      path.join(directories[3], "opencode"),
      path.join(directories[0], "opencode", "log"),
      path.join(directories[0], "opencode", "repos"),
      path.join(directories[4], "opencode"),
    ]
    created.forEach((directory) => expect(fs.statSync(directory).isDirectory()).toBe(true))
    fs.rmSync(root, { recursive: true, force: true })
  })
})
