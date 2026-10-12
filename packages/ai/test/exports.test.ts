import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  AIClient,
  AIError,
  Generation,
  Image,
  ImageClient,
  LanguageModel,
  LLM,
  LLMClient,
  Media,
  Provider,
  Speech,
  SpeechClient,
  SpeechEvent,
  TranscriptionClient,
  Video,
  VideoClient,
} from "@opencode/ai"
import { Route, Protocol, RequestExecutor, WebSocketTransport } from "@opencode/ai/route"
import { Provider as ProviderSubpath } from "@opencode/ai/provider"
import {
  Alibaba,
  Anthropic,
  AnthropicCompatible,
  DeepSeek,
  OpenAICompatible,
  ZAI,
  ZAICodingPlan,
} from "@opencode/ai/providers"
import { AnthropicMessages, OpenAIChat, OpenAICompatibleChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"

describe("public exports", () => {
  test("modality, provider, and protocol entrypoints load first in a fresh process", async () => {
    const results = await Promise.all(
      ["image", "video", "speech", "transcription", "providers", "protocols"].map(async (entry) => {
        const child = Bun.spawn(
          [process.execPath, "-e", `await import(${JSON.stringify(`${import.meta.dir}/../src/${entry}.ts`)})`],
          { stderr: "pipe" },
        )
        return { entry, exitCode: await child.exited, stderr: await new Response(child.stderr).text() }
      }),
    )
    expect(results.filter((result) => result.exitCode !== 0)).toEqual([])
  })

  test("root exposes app-facing runtime APIs", () => {
    expect(LLM.request).toBeFunction()
    expect(LLMClient.Service).toBeFunction()
    expect(LLMClient.layer).toBeDefined()
    expect(AIError).toBeFunction()
    expect(LanguageModel.make).toBeFunction()
    expect(Media.bytes).toBeFunction()
    expect(Image.generate).toBeFunction()
    expect(Video.start).toBeFunction()
    expect(Video.resume).toBeFunction()
    expect(VideoClient.layer).toBeDefined()
    expect(Speech.generate).toBeFunction()
    expect(Speech.stream).toBeFunction()
    expect(SpeechClient.layer).toBeDefined()
    expect(SpeechEvent.is.audioDelta).toBeFunction()
    expect(Generation).toBeFunction()
    expect(Provider.make).toBeFunction()
    expect(ProviderSubpath.make).toBe(Provider.make)
    expect(TestLLM.layer).toBeFunction()
    expect(TestLLM.testLayer).toBeFunction()
    expect(TestLLM.Test.of).toBeFunction()
  })

  test("AIClient.layerWith shares one executor across every client", async () => {
    let built = 0
    const counting = Layer.effect(
      RequestExecutor.Service,
      Effect.sync(() => {
        built++
        return RequestExecutor.Service.of({ execute: () => Effect.die("unexpected request") })
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* LLMClient.Service
        yield* ImageClient.Service
        yield* VideoClient.Service
        yield* SpeechClient.Service
        yield* TranscriptionClient.Service
        yield* RequestExecutor.Service
      }).pipe(Effect.provide(AIClient.layerWith(counting))),
    )
    expect(built).toBe(1)
  })

  test("route barrel exposes route-authoring APIs", () => {
    expect(Route.make).toBeFunction()
    expect(Protocol.make).toBeFunction()
    expect(WebSocketTransport.makeDirect).toBeFunction()
  })

  test("provider barrels expose user-facing facades", () => {
    for (const provider of [Alibaba, Anthropic, AnthropicCompatible, DeepSeek, OpenAICompatible, ZAI, ZAICodingPlan]) {
      expect(provider.configure).toBeFunction()
      expect(provider.model).toBeFunction()
    }
    expect(Alibaba.configure({ region: "ap-southeast-1", apiKey: "fixture" }).messages).toBeFunction()
    expect(ZAI.provider.model).toBe(ZAI.provider.chat)
    expect(ZAICodingPlan.provider.messages).toBe(ZAICodingPlan.messages)
    expect(ZAICodingPlan.configure({ apiKey: "fixture" }).chat("glm-5.3").route.id).toBe("zai-coding-chat")
    expect(DeepSeek.configure({ apiKey: "fixture" }).model("deepseek-chat").route.id).toBe("deepseek-chat")
    expect(OpenAICompatible.configure({ baseURL: "https://compatible.test/v1" }).model("fixture").route.id).toBe(
      "openai-compatible-chat",
    )
  })

  test("only the supported vendors ship a provider facade", async () => {
    expect(Object.keys(await import("@opencode/ai/providers")).toSorted()).toEqual([
      "Alibaba",
      "Anthropic",
      "AnthropicCompatible",
      "DeepSeek",
      "OpenAICompatible",
      "ZAI",
      "ZAICodingPlan",
    ])
  })

  test("protocol barrels expose supported low-level routes", () => {
    expect(OpenAIChat.route.id).toBe("openai-chat")
    expect(OpenAICompatibleChat.route.id).toBe("openai-compatible-chat")
    expect(AnthropicMessages.route.id).toBe("anthropic-messages")
  })
})
