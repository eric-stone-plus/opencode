import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin, { buildReviewArgs, resolveRepoDir, runOcr } from "../bootstrap/plugin/open-code-review"

// Standalone battery for the V2 promise port of the vendored OpenCodeReview
// plugin (bootstrap/plugin/open-code-review.ts; the V1 source it ports was
// retired from bootstrap/plugin-v1/). The host is stood in for by a double that implements
// exactly the domains the plugin touches: location, the tool transform, the
// command list/transform pair, and session.prompt — the same shape
// script/local-tools.test.ts uses.
//
// The fake `ocr` binary is an executable shim copied onto PATH (or handed to
// runOcr through its `invocation` override, as the V1 test did), so the real
// OCR is never spawned. What the shim sees (cwd, argv, the temporary
// background file) is written next to it and asserted here; the local
// modifications from the plugin header — the `repo` argument and the two
// failure hints — are pinned below.

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "ocr-plugin-test-"))
  directories.push(directory)
  return directory
}

type AddedTool = {
  readonly name: string
  readonly options?: { readonly codemode?: boolean }
  readonly description: string
  readonly input: { type: string; properties: Record<string, unknown>; required?: readonly string[]; additionalProperties?: boolean }
  readonly execute: (input: unknown, context: ReturnType<typeof toolContext>) => Promise<{ content?: unknown }>
}

type AddedCommand = {
  readonly name: string
  readonly description?: string
  readonly execute: (input: { sessionID: string; prompt: { text?: string }; delivery: string }) => Promise<void>
}

const tools = new Map<string, AddedTool>()
const commands: AddedCommand[] = []
const prompts: Array<{ sessionID: string; text: string; delivery: string }> = []

const context = {
  location: {
    directory: "",
    workspaceID: undefined,
    project: { id: "test", directory: "", canonical: "" },
  },
  command: {
    list: async () => ({ data: [] as Array<{ name: string }> }),
    transform: async (callback: (editor: { add: (command: AddedCommand) => void }) => void) => {
      callback({ add: (command) => commands.push(command) })
    },
  },
  session: {
    prompt: async (input: { sessionID: string; text: string; delivery: string }) => {
      prompts.push(input)
    },
  },
  tool: {
    transform: async (callback: (editor: { add: (tool: AddedTool) => void }) => void) => {
      callback({ add: (tool) => tools.set(tool.name, tool) })
    },
  },
}

await (plugin.setup as (ctx: unknown) => Promise<void>)(context)

function toolContext(signal: AbortSignal = new AbortController().signal) {
  return {
    sessionID: "ses_ocr",
    agent: "build",
    messageID: "msg_ocr",
    id: "call_ocr",
    signal,
    progress: async () => {},
  }
}

function tool(name: string) {
  const found = tools.get(name)
  if (!found) throw new Error(`tool not registered: ${name}`)
  return found
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// PATH is the only seam that decides which `ocr` the plugin spawns.
async function withPath<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  process.env.PATH = `${directory}${path.delimiter}${previous ?? ""}`
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
}

/** An executable `ocr` named exactly as the plugin spawns it. */
async function shim(directory: string, script: string) {
  const file = path.join(directory, "ocr")
  await writeFile(file, script, "utf8")
  await chmod(file, 0o700)
  return file
}

/** Healthy fake OCR: logs cwd + argv, copies the --background-file value, exits 0. */
function healthyShim(log: string, background: string) {
  return `#!/bin/sh
: > "${log}"
previous=""
for argument in "$@"; do
  echo "arg=$argument" >> "${log}"
  if [ "$previous" = "--background-file" ]; then cat "$argument" > "${background}"; fi
  previous="$argument"
done
echo "cwd=$(pwd)" >> "${log}"
case "$1" in
  version) echo "OpenCodeReview 9.9.9" ;;
  llm) echo "llm connection ok" ;;
  review) echo '{"findings":[]}' ;;
esac
exit 0
`
}

async function logged(file: string) {
  return await readFile(file, "utf8").catch(() => "")
}


describe("open-code-review V2 registration", () => {
  test("registers exactly ocr_review and ocr_health with their V1 schemas", () => {
    expect([...tools.keys()]).toEqual(["ocr_review", "ocr_health"])
    const review = tool("ocr_review")
    const health = tool("ocr_health")
    expect(review.options).toEqual({ codemode: false })
    expect(health.options).toEqual({ codemode: false })
    expect(review.description).toStartWith("Run OpenCodeReview on workspace changes")
    expect(review.description).toContain("Pass repo when the session directory is not inside the target git repository.")
    expect(health.description).toBe(
      "Check the installed OpenCodeReview version and verify its configured LLM connection.",
    )
    // Every V1 `reviewArgs` name survives the zod -> JSON-schema move.
    expect(Object.keys(review.input.properties).sort()).toEqual(
      [
        "background",
        "backgroundFile",
        "commit",
        "concurrency",
        "exclude",
        "from",
        "maxGitProcesses",
        "maxTools",
        "model",
        "overallTimeoutMinutes",
        "preview",
        "repo",
        "resume",
        "timeoutMinutes",
        "to",
      ],
    )
    expect(review.input.type).toBe("object")
    expect(review.input.required).toEqual([])
    expect(review.input.additionalProperties).toBe(false)
    expect(review.input.properties.concurrency).toEqual({
      type: "integer",
      minimum: 1,
      description: "Maximum concurrent file reviews.",
    })
    expect(health.input.properties).toEqual({ repo: review.input.properties.repo })
    expect(health.input.additionalProperties).toBe(false)
  })

  test("registers the ocr-review and ocr-health commands with the V1 templates", async () => {
    expect(commands.map((command) => command.name)).toEqual(["ocr-review", "ocr-health"])
    prompts.length = 0
    await commands[0]!.execute({
      sessionID: "ses_ocr",
      prompt: { text: "the working tree" },
      delivery: "queue",
    })
    expect(prompts).toEqual([
      {
        sessionID: "ses_ocr",
        text:
          "Use the ocr_review tool to review the requested target. " +
          "Treat the following text as review intent, target details, and business context:" +
          "the working tree" +
          ". If no target is specified, review the current workspace changes. " +
          "Report findings by severity with exact file and line references.",
        delivery: "queue",
      },
    ])
    await commands[1]!.execute({ sessionID: "ses_ocr", prompt: {}, delivery: "queue" })
    expect(prompts[1]).toEqual({
      sessionID: "ses_ocr",
      text: "Use the ocr_health tool and explain any configuration problem concisely.",
      delivery: "queue",
    })
  })
})

describe("open-code-review tool execution", () => {
  test("ocr_health reports the version and LLM checks on success", async () => {
    const directory = await temporary()
    const file = await shim(directory, healthyShim(path.join(directory, "argv.log"), path.join(directory, "bg.md")))
    context.location.directory = directory
    const result = await withPath(directory, () => tool("ocr_health").execute({}, toolContext()))
    expect(result.content).toBe("OpenCodeReview 9.9.9\nllm connection ok")
    expect(await logged(path.join(directory, "argv.log"))).toContain("cwd=" + directory)
  })

  test("ocr_review defaults the repo to the plugin location directory", async () => {
    const directory = await temporary()
    await shim(directory, healthyShim(path.join(directory, "argv.log"), path.join(directory, "bg.md")))
    context.location.directory = directory
    const result = await withPath(directory, () => tool("ocr_review").execute({}, toolContext()))
    expect(result.content).toBe('{"findings":[]}')
    const log = await logged(path.join(directory, "argv.log"))
    expect(log).toContain(`cwd=${directory}`)
    expect(log).toContain(`arg=${directory}`)
    expect(log).toContain("arg=--repo")
    expect(log).toContain("arg=--format")
    expect(log).toContain("arg=json")
  })

  test("the repo argument overrides the location directory for the spawned command", async () => {
    const directory = await temporary()
    const target = path.join(directory, "sub", "repo")
    await mkdir(target, { recursive: true })
    await shim(directory, healthyShim(path.join(directory, "argv.log"), path.join(directory, "bg.md")))
    context.location.directory = directory
    const result = await withPath(directory, () =>
      tool("ocr_review").execute({ repo: "sub/repo", preview: true }, toolContext()),
    )
    // preview keeps stdout verbatim and drops --format json, as in V1.
    expect(result.content).toBe('{"findings":[]}')
    const args = (await logged(path.join(directory, "argv.log"))).split("\n")
    expect(args).toContain(`cwd=${target}`)
    expect(args).toContain(`arg=${target}`)
    expect(args).toContain("arg=--repo")
    expect(args).toContain("arg=--preview")
    expect(args).not.toContain("arg=--format")
  })

  test("an inline background becomes a trimmed temporary --background-file", async () => {
    const directory = await temporary()
    const background = path.join(directory, "bg.md")
    await shim(directory, healthyShim(path.join(directory, "argv.log"), background))
    context.location.directory = directory
    await withPath(directory, () =>
      tool("ocr_review").execute({ background: "  ship the vendored port  " }, toolContext()),
    )
    const args = (await logged(path.join(directory, "argv.log"))).split("\n")
    expect(args).toContain("arg=--background-file")
    expect(args).not.toContain("arg=--background")
    expect(await logged(background)).toBe("ship the vendored port")
  })

  test("a missing ocr on PATH reports the install hint", async () => {
    const directory = await temporary()
    const empty = await temporary()
    context.location.directory = directory
    // PATH holds no `ocr`: spawn fails with ENOENT before any OCR runs.
    const previous = process.env.PATH
    process.env.PATH = empty
    try {
      // ocr_review surfaces the spawn failure as a tool error...
      const failure = await tool("ocr_review").execute({}, toolContext()).catch((error: unknown) => error)
      expect(message(failure)).toBe(
        "OpenCodeReview is not installed or 'ocr' is not on PATH. Install it with: npm install -g @alibaba-group/open-code-review",
      )
      // ...while ocr_health reports each failed check inside its text result, as in V1.
      const health = await tool("ocr_health").execute({}, toolContext())
      expect(health.content).toBe(
        "Version check failed: OpenCodeReview is not installed or 'ocr' is not on PATH. " +
          "Install it with: npm install -g @alibaba-group/open-code-review\n" +
          "LLM connection check failed: OpenCodeReview is not installed or 'ocr' is not on PATH. " +
          "Install it with: npm install -g @alibaba-group/open-code-review",
      )
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })

  test("a not-a-git-repository failure tells the caller to pass repo", async () => {
    const directory = await temporary()
    await shim(directory, "#!/bin/sh\necho 'Error: / is not a git repository' >&2\nexit 1\n")
    context.location.directory = directory
    const failure = await withPath(directory, () =>
      tool("ocr_review").execute({}, toolContext()).catch((error: unknown) => error),
    )
    expect(message(failure)).toContain("not a git repository")
    expect(message(failure)).toContain("'repo' tool argument")
  })

  test("the abort signal kills the spawned ocr", async () => {
    const directory = await temporary()
    const pidFile = path.join(directory, "pid")
    const finished = path.join(directory, "finished")
    // The shim takes 2 s of `sleep`; a cancelled run must never get past it.
    await shim(directory, `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 2\necho finished > "${finished}"\n`)
    context.location.directory = directory
    const controller = new AbortController()
    const started = Date.now()
    const running = withPath(directory, () =>
      tool("ocr_review").execute({}, toolContext(controller.signal)).catch((error: unknown) => error),
    )
    // Wait for the child to exist, then cancel it mid-run.
    for (let attempt = 0; attempt < 40 && (await logged(pidFile)) === ""; attempt++) await Bun.sleep(25)
    const pid = Number(await logged(pidFile))
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    const failure = await running
    expect(message(failure)).toContain("OpenCodeReview was cancelled by OpenCode.")
    expect(Date.now() - started).toBeLessThan(5_000)
    // The shell it was about to run would have written the marker; a terminated
    // child never does. SIGTERM goes to the child's process group (detached
    // spawn), so the shim and its `sleep` both die.
    await Bun.sleep(3_000)
    expect(await logged(finished)).toBe("")
  })
})

// The V1 test's direct helper battery: the plugin file's pure seams stay
// reachable without a host, which is also how the V1 source was exercised.
describe("open-code-review helpers", () => {
  test("resolveRepoDir defaults to the session directory", () => {
    expect(resolveRepoDir("/home/eric", undefined)).toBe("/home/eric")
    expect(resolveRepoDir("/home/eric", "")).toBe("/home/eric")
  })

  test("resolveRepoDir resolves a relative repo against the session directory", () => {
    expect(resolveRepoDir("/home/eric", "Documents/repo")).toBe("/home/eric/Documents/repo")
  })

  test("resolveRepoDir uses an absolute repo as given", () => {
    expect(resolveRepoDir("/", "/tmp/opencode/somewhere")).toBe("/tmp/opencode/somewhere")
  })

  test("buildReviewArgs forwards --repo to OCR", () => {
    const args = buildReviewArgs({ commit: "abc" }, "/tmp/opencode/somewhere")
    expect(args).toContain("--repo")
    expect(args[args.indexOf("--repo") + 1]).toBe("/tmp/opencode/somewhere")
  })

  test("buildReviewArgs keeps the V1 argument validation", () => {
    expect(() => buildReviewArgs({ from: "main" }, "/repo")).toThrow(
      "Both 'from' and 'to' are required for a branch comparison.",
    )
    expect(() => buildReviewArgs({ commit: "abc", from: "main", to: "dev" }, "/repo")).toThrow(
      "Use either 'commit' or a 'from'/'to' range, not both.",
    )
    expect(() => buildReviewArgs({ resume: "id", commit: "abc" }, "/repo")).toThrow(
      "'resume' cannot be combined with 'commit' or a 'from'/'to' range.",
    )
    expect(() => buildReviewArgs({ resume: "id", preview: true }, "/repo")).toThrow(
      "'preview' and 'resume' cannot be used together.",
    )
    expect(() => buildReviewArgs({ background: "x", backgroundFile: "y.md" }, "/repo")).toThrow(
      "Use either 'background' or 'backgroundFile', not both.",
    )
    // `preview` drops the JSON format flag and appends --preview last.
    expect(buildReviewArgs({ preview: true, maxTools: 50 }, "/repo")).toEqual([
      "review",
      "--audience",
      "agent",
      "--repo",
      "/repo",
      "--max-tools",
      "50",
      "--preview",
    ])
  })

  test("the not-a-git-repository hint is added by runOcr itself", async () => {
    const directory = await temporary()
    const script = await shim(directory, "#!/bin/sh\necho 'Error: / is not a git repository' >&2\nexit 1\n")
    const failure = await runOcr(["review"], {
      cwd: directory,
      invocation: { command: script, prefixArgs: [] },
      timeoutMs: 10_000,
    }).catch((error: unknown) => error)
    expect(message(failure)).toContain("not a git repository")
    expect(message(failure)).toContain("'repo' tool argument")
  })

  test("other runOcr failures carry no repo hint", async () => {
    const directory = await temporary()
    const script = await shim(directory, "#!/bin/sh\necho 'boom' >&2\nexit 1\n")
    const failure = await runOcr(["review"], {
      cwd: directory,
      invocation: { command: script, prefixArgs: [] },
      timeoutMs: 10_000,
    }).catch((error: unknown) => error)
    expect(message(failure)).toContain("boom")
    expect(message(failure)).not.toContain("'repo' tool argument")
  })
})
