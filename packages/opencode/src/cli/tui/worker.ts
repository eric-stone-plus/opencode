import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

Heap.start()

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Runtime warnings (e.g. TimeoutNaNWarning from setTimeout(NaN)) print straight
// to fd 2, which the main thread's alt-screen TUI shares — one warning garbles
// the lower half of the screen. Registering any listener suppresses Bun's
// default printer, so forward them over RPC where the main thread can route
// them into the console overlay instead.
process.on("warning", (warning) => {
  Rpc.emit("process.warning", {
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
  })
})

// Tool execution and plugin hooks run in this worker and their console.*
// calls share the main thread's fd 2 — one stray log (e.g. a plugin's
// tool.execute.before error path) garbles the alt-screen TUI exactly like a
// runtime warning. Forward worker console output over RPC so the main thread
// can land it in the console overlay instead of the terminal.
const formatConsoleArg = (arg: unknown): string => {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}
const forwardConsole =
  (level: "log" | "info" | "warn" | "error" | "debug") =>
  (...args: unknown[]) => {
    Rpc.emit("console.forward", { level, text: args.map(formatConsoleArg).join(" ") })
  }
console.log = forwardConsole("log")
console.info = forwardConsole("info")
console.warn = forwardConsole("warn")
console.error = forwardConsole("error")
console.debug = forwardConsole("debug")

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
