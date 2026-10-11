import { describe, expect, test } from "bun:test"
import { LLM, LLMClient, Provider } from "@opencode-ai/llm"
import { Route, Protocol } from "@opencode-ai/llm/route"
import { Provider as ProviderSubpath } from "@opencode-ai/llm/provider"
import { Anthropic, OpenAICompatible } from "@opencode-ai/llm/providers"
import { OpenAIChat, OpenAICompatibleChat } from "@opencode-ai/llm/protocols"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"

describe("public exports", () => {
  test("root exposes app-facing runtime APIs", () => {
    expect(LLM.request).toBeFunction()
    expect(LLMClient.Service).toBeFunction()
    expect(LLMClient.layer).toBeDefined()
    expect(Provider.make).toBeFunction()
    expect(ProviderSubpath.make).toBe(Provider.make)
  })

  test("route barrel exposes route-authoring APIs", () => {
    expect(Route.make).toBeFunction()
    expect(Protocol.make).toBeFunction()
  })

  test("provider barrels expose user-facing facades", () => {
    expect(Anthropic.model).toBeFunction()
    expect(Anthropic.provider.model).toBe(Anthropic.model)
    expect(Anthropic.configure({ apiKey: "fixture" }).model("claude-haiku").route.id).toBe("anthropic-messages")
    expect(OpenAICompatible.deepseek.model).toBeFunction()
    expect(OpenAICompatible.deepseek.configure({ apiKey: "fixture" }).model("deepseek-chat").route.id).toBe(
      "openai-compatible-chat",
    )
  })

  test("protocol barrels expose supported low-level routes", () => {
    expect(OpenAIChat.route.id).toBe("openai-chat")
    expect(OpenAICompatibleChat.route.id).toBe("openai-compatible-chat")
    expect(AnthropicMessages.route.id).toBe("anthropic-messages")
  })
})
