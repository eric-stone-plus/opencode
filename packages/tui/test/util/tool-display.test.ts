import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import {
  canonicalToolName,
  executeCallSummary,
  finiteNumber,
  primitiveInputSummary,
  toolDisplayContent,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "subagent",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("relay")).toBe("Web Search via Relay")
    expect(webSearchProviderLabel("axis")).toBe("Web Search via Axis")
    expect(webSearchProviderLabel("navigator")).toBe("Web Search via Navigator")
    expect(webSearchProviderLabel("vector")).toBe("Web Search via Vector")
    expect(webSearchProviderLabel("opencode")).toBe("Web Search via OpenCode")
  })

  test("labels providers dynamically", () => {
    expect(webSearchProviderLabel("other")).toBe("Web Search via Other")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an empty string", ""],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns tool metadata for non-pending states", () => {
    const metadata = { provider: "relay", numResults: 3 }

    // Sanitizing projects the metadata into a copy; callers read it by name, so identity is not part of
    // the contract.
    expect(toolDisplayMetadata({ status: "running", metadata })).toEqual(metadata)
    expect(toolDisplayMetadata({ status: "completed", metadata })).toEqual(metadata)
    expect(toolDisplayMetadata({ status: "error", metadata })).toEqual(metadata)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", metadata: { provider: "axis" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})

describe("sanitized projections", () => {
  test("primitiveInputSummary drops control bytes from keys and values", () => {
    expect(primitiveInputSummary({ [`a${CLEAR}b`]: `v${OSC}w`, keep: 1 })).toBe("[ab=vw, keep=1]")
  })

  test("executeCallSummary drops control bytes from the tool name", () => {
    expect(executeCallSummary({ tool: `mcp${CLEAR}tool`, status: "completed", input: {} })).toBe("mcptool")
  })

  test("toolDisplayMetadata drops control bytes from nested metadata", () => {
    const metadata = { path: `a${CLEAR}`, files: [{ patch: `x${OSC}y` }] }

    expect(toolDisplayMetadata({ status: "completed", metadata })).toEqual({ path: "a", files: [{ patch: "xy" }] })
  })

  test("toolDisplayContent drops control bytes from text content", () => {
    const state: SessionMessageAssistantTool["state"] = {
      status: "completed",
      input: {},
      content: [{ type: "text", text: `out${CLEAR}put` }],
    }

    expect(toolDisplayContent(state)).toEqual([{ type: "text", text: "output" }])
  })
})
