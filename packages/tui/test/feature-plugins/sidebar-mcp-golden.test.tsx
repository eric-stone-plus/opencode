/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarMcp } from "../../src/feature-plugins/sidebar/mcp"
import { goldenFrames } from "../util/golden"

type McpStatus = "connected" | "pending" | "failed" | "disabled" | "needs_auth"

function context(servers: Array<{ name: string; status: McpStatus }>) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: {
          success: { base: color },
          error: { base: color },
          warning: { base: color },
        },
      },
    },
    storage: { store: () => [{ open: true }, async () => {}] },
    data: {
      session: { get: () => ({ location: { directory: "/workspace" } }) },
      location: {
        mcp: {
          server: {
            list: () => servers.map((server) => ({ name: server.name, status: { status: server.status } })),
          },
        },
      },
    },
    ui: { dialog: { show: () => {} } },
  } as unknown as Context
}

test("golden: the MCP sidebar with one server per status", async () => {
  expect(
    await goldenFrames(() => (
      <SidebarMcp
        context={context([
          { name: "github", status: "connected" },
          { name: "linear", status: "needs_auth" },
          { name: "sentry", status: "failed" },
          { name: "jira", status: "disabled" },
        ])}
        sessionID="session"
      />
    )),
  ).toMatchSnapshot()
})

test("golden: the collapsed MCP summary above two servers", async () => {
  expect(
    await goldenFrames(() => (
      <SidebarMcp
        context={context([
          { name: "github", status: "connected" },
          { name: "sentry", status: "failed" },
          { name: "linear", status: "failed" },
        ])}
        sessionID="session"
      />
    )),
  ).toMatchSnapshot()
})
