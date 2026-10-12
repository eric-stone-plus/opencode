import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildReviewArgs,
  resolveRepoDir,
  runOcr,
} from "../bootstrap/plugin/open-code-review"

// Local-mod seams of the vendored OCR plugin (see the header's "Local
// modifications" list): the explicit `repo` tool argument and the
// "not a git repository" hint. The plugin file is loaded by the config-dir
// plugin loader at runtime; here we test the pure helpers directly.

describe("open-code-review plugin repo handling", () => {
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
})

describe("open-code-review runOcr failure hints", () => {
  test("a not-a-git-repository failure tells the caller to pass repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocr-plugin-test-"))
    try {
      const script = join(dir, "fake-ocr.sh")
      await writeFile(
        script,
        "#!/bin/sh\necho 'Error: / is not a git repository' >&2\nexit 1\n",
        "utf8",
      )
      await chmod(script, 0o700)
      let message = ""
      try {
        await runOcr(["review"], {
          cwd: dir,
          invocation: { command: script, prefixArgs: [] },
          timeoutMs: 10_000,
        })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain("not a git repository")
      expect(message).toContain("'repo' tool argument")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("other failures carry no repo hint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocr-plugin-test-"))
    try {
      const script = join(dir, "fake-ocr.sh")
      await writeFile(script, "#!/bin/sh\necho 'boom' >&2\nexit 1\n", "utf8")
      await chmod(script, 0o700)
      let message = ""
      try {
        await runOcr(["review"], {
          cwd: dir,
          invocation: { command: script, prefixArgs: [] },
          timeoutMs: 10_000,
        })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain("boom")
      expect(message).not.toContain("'repo' tool argument")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
