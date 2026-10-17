import { describe, expect } from "bun:test"
import { AbsolutePath } from "@opencode/core/schema"
import { Credential } from "@opencode/core/credential"
import { Image } from "@opencode/core/image"
import { Permission } from "@opencode/core/permission"
import { ForkWebFetchPlugin } from "@opencode/core/plugin/fork/webfetch"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { WebFetchTool } from "@opencode/core/tool/plugin/webfetch"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { testEffect } from "../../lib/effect"
import { imagePassthrough } from "../../lib/image"
import { permissionLayer } from "../../lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "../../lib/tool"
import { host } from "../host"

const location = { directory: AbsolutePath.make("/workspace") }
const sessionID = Session.ID.make("ses_webfetch_wrapper_test")
const assertions: Permission.AssertInput[] = []
const requests: string[] = []

let deepseek: () => Response = () =>
  new Response(JSON.stringify({ title: "Example", content: "# DeepSeek" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    requests.push(request.url)
    const response = request.url.startsWith("https://api.deepseek.com/v1/tools/fetch")
      ? deepseek()
      : new Response("direct", { headers: { "content-type": "text/plain" } })
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  }),
)

const overrides = {
  permission: {
    ...host().permission,
    assert: (input: Permission.AssertInput) => Effect.sync(() => assertions.push(input)),
  },
  provider: {
    ...host().provider,
    list: () =>
      Effect.succeed({
        location,
        data: [
          {
            id: "deepseek",
            name: "DeepSeek",
            activation: "enabled",
            package: "@ai-sdk/openai-compatible",
            integrationID: "deepseek",
            settings: { baseURL: "https://api.deepseek.com" },
          } as any,
        ],
      }),
  },
  integration: {
    ...host().integration,
    connection: {
      ...host().integration.connection,
      active: () => Effect.succeed({ type: "credential", id: "cred", label: "key", method: "key" } as any),
      resolve: () => Effect.succeed(Credential.Key.make({ type: "key", key: "secret" })),
    },
  },
}

const node = makeLocationNode({
  name: "test/webfetch-wrapper",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* registerToolPlugin(WebFetchTool.Plugin, overrides)
      yield* ForkWebFetchPlugin.Plugin.effect(
        host({
          ...overrides,
          tool: {
            transform: tools.transform,
            reload: tools.reload,
            list: tools.list,
            hook: () => Effect.die("unused tool hook"),
          },
        }),
      )
    }),
  ),
  deps: [Tool.node, Permission.node, LayerNodePlatform.httpClient],
})

const toolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, node]), [
  Permission.node.replace(permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) })),
  Image.node.replace(imagePassthrough),
  LayerNodePlatform.httpClient.replace(http),
])

const it = testEffect(toolLayer)

const reset = () => {
  requests.length = 0
  assertions.length = 0
  deepseek = () =>
    new Response(JSON.stringify({ title: "Example", content: "# DeepSeek" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
}

const call = (format: "markdown" | "text") => ({
  sessionID,
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id: "call-webfetch",
    name: "webfetch",
    input: { url: "https://example.com/page", format },
  },
})

describe("ForkWebFetchPlugin", () => {
  it.effect("uses DeepSeek Fetch for Markdown and reports its source", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call("markdown"))).toMatchObject({
        status: "completed",
        output: {
          url: "https://example.com/page",
          contentType: "text/markdown",
          format: "markdown",
          output: "# DeepSeek",
        },
        metadata: { contentType: "text/markdown", source: "deepseek" },
      })
      expect(requests).toEqual(["https://api.deepseek.com/v1/tools/fetch"])
      expect(assertions).toHaveLength(1)
    }),
  )

  it.effect("leaves non-Markdown formats on the direct path", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call("text"))).toMatchObject({
        status: "completed",
        output: { contentType: "text/plain", format: "text", output: "direct" },
      })
      expect(requests).toEqual(["https://example.com/page"])
    }),
  )

  it.effect("falls back to the direct tool when DeepSeek Fetch fails", () =>
    Effect.gen(function* () {
      reset()
      deepseek = () => new Response("nope", { status: 400 })
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call("markdown"))).toMatchObject({
        status: "completed",
        output: { contentType: "text/plain", format: "markdown", output: "direct" },
      })
      expect(requests).toEqual(["https://api.deepseek.com/v1/tools/fetch", "https://example.com/page"])
      expect(assertions).toHaveLength(2)
    }),
  )
})
