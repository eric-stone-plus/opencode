import { describe, expect, test } from "bun:test"
import type { IntegrationInfo } from "@opencode/client"
import {
  connectionSummary,
  connectMethods,
  credentialConnections,
  integrationCategory,
  integrationOptions,
} from "../../../../src/component/dialog-integration"

const integration = (value: Partial<IntegrationInfo> & Pick<IntegrationInfo, "id" | "name">): IntegrationInfo => ({
  methods: [],
  connections: [],
  ...value,
})

describe("integrationOptions", () => {
  test("keeps the listed vendor first and sorts the rest alphabetically", () => {
    expect(
      integrationOptions([
        integration({ id: "mistral", name: "Mistral" }),
        integration({ id: "deepseek", name: "DeepSeek" }),
        integration({ id: "custom-z", name: "Zebra" }),
        integration({ id: "anthropic", name: "Anthropic" }),
      ]).map((item) => item.id),
    ).toEqual(["deepseek", "anthropic", "mistral", "custom-z"])
  })

  test("keeps MCP integrations above the listed vendor without relying on their IDs", () => {
    expect(
      integrationOptions([
        integration({ id: "deepseek", name: "DeepSeek" }),
        integration({ id: "linear", name: "Linear", metadata: { source: "mcp" } }),
        integration({ id: "github", name: "GitHub", metadata: { source: "mcp" } }),
      ]).map((item) => item.id),
    ).toEqual(["github", "linear", "deepseek"])
  })
})

describe("integrationCategory", () => {
  test("does not label an integration popular through the prototype chain", () => {
    expect(integrationCategory(integration({ id: "toString", name: "toString" }))).toBe("Services")
    expect(integrationCategory(integration({ id: "constructor", name: "constructor" }))).toBe("Services")
  })

  test("labels the listed vendor Popular, and MCP wins over it", () => {
    expect(integrationCategory(integration({ id: "deepseek", name: "DeepSeek" }))).toBe("Popular")
    expect(integrationCategory(integration({ id: "deepseek", name: "DeepSeek", metadata: { source: "mcp" } }))).toBe("MCP")
  })
})

describe("connectMethods", () => {
  test("offers key and OAuth methods but not environment discovery", () => {
    expect(
      connectMethods(
        integration({
          id: "example",
          name: "Example",
          methods: [
            { type: "env", names: ["EXAMPLE_KEY"] },
            { type: "key", label: "API key" },
            { type: "oauth", id: "account", label: "Account" },
          ],
        }),
      ).map((method) => method.type),
    ).toEqual(["oauth", "key"])
  })
})

describe("credentialConnections", () => {
  test("returns removable credential connections only", () => {
    expect(
      credentialConnections(
        integration({
          id: "example",
          name: "Example",
          connections: [
            { type: "env", name: "EXAMPLE_KEY" },
            { type: "credential", method: "key", id: "cred_1", label: "Work" },
          ],
        }),
      ),
    ).toEqual([{ type: "credential", method: "key", id: "cred_1", label: "Work" }])
  })
})

describe("connectionSummary", () => {
  test("counts several connections", () => {
    expect(
      connectionSummary(
        integration({
          id: "example",
          name: "Example",
          connections: [
            { type: "credential", method: "key", id: "cred_1", label: "Work" },
            { type: "env", name: "EXAMPLE_KEY" },
          ],
        }),
      ),
    ).toBe("2 connections")
  })
})
