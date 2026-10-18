import { describe, expect, test } from "bun:test"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"

// Obviously fake values: the stub server never sees, and the CLI never prints, anything like a key.
const integrations = [
  { id: "deepseek-plan", name: "DeepSeek Plan", labels: ["Work", "Personal"] },
  { id: "deepseek-coding", name: "DeepSeek Coding", labels: ["default"] },
  { id: "deepseek-coding-cn", name: "DeepSeek Coding CN", labels: ["default"] },
  { id: "deepseek-payg", name: "DeepSeek Pay-as-you-go", labels: [] },
]

describe("auth purge", () => {
  test("registers the command and its flags", async () => {
    const [auth, purge] = await Promise.all([cli(["auth", "--help"]), cli(["auth", "purge", "--help"])])
    expect(auth.stdout).toContain("remove saved credentials and every stale copy of their values")
    expect(purge.exitCode).toBe(0)
    for (const flag of ["--all", "--yes", "--dry-run", "--files", "--history", "--compact", "--server", "--standalone"])
      expect(purge.stdout).toContain(flag)
  })

  test("previews a purge by substring without confirming or changing anything", async () => {
    const stub = purgeServer()
    using server = stub.server
    const result = await cli(["auth", "purge", "PLAN", "--dry-run", "--server", server.url.toString()])
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stub.purges).toEqual([
      { integrationIDs: ["deepseek-plan"], files: true, history: false, compact: false, dryRun: true },
    ])
    expect(result.stdout).toContain("DeepSeek Plan (deepseek-plan): Work, Personal")
    expect(result.stdout).toContain("Would remove 1 of 1 credential(s)")
    expect(stub.paths).not.toContain("/api/credential")
  })

  test("requires --yes without an interactive terminal and sends nothing before it", async () => {
    const stub = purgeServer()
    using server = stub.server
    const result = await cli(["auth", "purge", "plan", "--server", server.url.toString()])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Pass --yes to purge without an interactive terminal")
    expect(stub.purges).toEqual([])
  })

  test.each([
    { args: ["nothing-like-it"], message: 'No integration with stored credentials matches "nothing-like-it"' },
    { args: ["deepseek-cod"], message: '"deepseek-cod" is ambiguous: deepseek-coding, deepseek-coding-cn' },
    { args: ["deepseek-payg"], message: 'No integration with stored credentials matches "deepseek-payg"' },
    { args: ["plan", "--all"], message: "Pass integration targets or --all, not both" },
    { args: [], message: "Name the integrations to purge, or pass --all" },
  ])("fails $args without purging, listing candidates", async ({ args, message }) => {
    const stub = purgeServer()
    using server = stub.server
    const result = await cli(["auth", "purge", ...args, "--yes", "--server", server.url.toString()])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(message)
    expect(stub.purges).toEqual([])
  })

  test("prefers an exact ID over longer IDs that contain it", async () => {
    const stub = purgeServer()
    using server = stub.server
    const result = await cli(["auth", "purge", "deepseek-coding", "--yes", "--no-files", "--history", "--server", server.url.toString()])
    expect(result.exitCode).toBe(0)
    expect(stub.purges).toEqual([
      { integrationIDs: ["deepseek-coding"], files: false, history: true, compact: false, dryRun: false },
    ])
  })

  // ADR 0010: removing a vendor deletes its config block, not its stored key — so the credential
  // outlives the integration catalog and can only be named from the credential store.
  test("resolves a credential whose integration left the config, and only then reads the store", async () => {
    const stub = purgeServer()
    using server = stub.server
    const result = await cli(["auth", "purge", "xiaomi-token-plan-cn", "--dry-run", "--server", server.url.toString()])
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stub.purges).toEqual([
      { integrationIDs: ["xiaomi-token-plan-cn"], files: true, history: false, compact: false, dryRun: true },
    ])
    expect(result.stdout).toContain("removed integration (xiaomi-token-plan-cn): default")
    expect(stub.paths).toContain("/api/credential")
  })

  test("does not read the credential store while a catalog target resolves", async () => {
    const stub = purgeServer()
    using server = stub.server
    const result = await cli(["auth", "purge", "deepseek-plan", "--dry-run", "--server", server.url.toString()])
    expect(result.exitCode).toBe(0)
    expect(stub.paths).not.toContain("/api/credential")
  })

  test("purges everything with --all and exits 2 while copies remain", async () => {
    const stub = purgeServer({ remaining: [{ kind: "database", location: "~/data/db (file)", count: 3 }] })
    using server = stub.server
    const result = await cli(["auth", "purge", "--all", "--yes", "--compact", "--server", server.url.toString()])
    expect(result.exitCode).toBe(2)
    expect(stub.purges).toEqual([{ all: true, files: true, history: true, compact: true, dryRun: false }])
    expect(result.stdout).toContain("Copies remain")
    expect(result.stdout).toContain("~/data/db (file): 3 copy/copies")
  })
})

function purgeServer(options: { remaining?: unknown[] } = {}) {
  const purges: unknown[] = []
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      paths.push(url.pathname)
      if (url.pathname === "/api/info")
        return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp/opencode" } })
      if (url.pathname === "/api/model/default") return Response.json(located(null))
      if (url.pathname === "/api/integration")
        return Response.json(
          located(
            integrations.map((item) => ({
              id: item.id,
              name: item.name,
              methods: [{ type: "key" }],
              connections: item.labels.map((label) => ({ type: "credential", method: "key", id: `cred_${label}`, label })),
            })),
          ),
        )
      if (url.pathname === "/api/credential" && request.method === "GET")
        return Response.json(
          located([
            { id: "cred_Work", integrationID: "deepseek-plan", label: "Work", active: true, value: "fake-value" },
            { id: "cred_orphan", integrationID: "xiaomi-token-plan-cn", label: "default", active: true, value: "fake-value" },
          ]),
        )
      if (url.pathname === "/api/credential/purge" && request.method === "POST") {
        const body = (await request.json()) as { integrationIDs?: string[]; dryRun?: boolean }
        purges.push(body)
        return Response.json({
          data: {
            dryRun: body.dryRun === true,
            credentials: [{ id: "cred_x", integrationID: body.integrationIDs?.[0] ?? "all", label: "Work", removed: body.dryRun !== true }],
            secrets: { distinct: 1, shared: 0, short: 0 },
            swept: [{ kind: "auth", location: "~/.local/share/opencode/auth.json", count: 1 }],
            remaining: options.remaining ?? [],
          },
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  return { server, purges, paths }
}

function located<T>(data: T) {
  return {
    location: { directory: process.cwd(), project: { id: "project", directory: process.cwd(), canonical: process.cwd() } },
    data,
  }
}

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    // Simulate the operator CLI: the suite may run inside an agent shell whose initial
    // environment carries the real session id/token. Empty values are treated as absent.
    env: { ...process.env, OPENCODE_SESSION_ID: "", OPENCODE_SESSION_TOKEN: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
