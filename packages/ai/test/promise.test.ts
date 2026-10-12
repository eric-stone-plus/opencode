import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { AIError, LLMEvent } from "../src/index.js"
import { RequestExecutor } from "../src/route.js"
import { AI } from "../src/promise.js"
import { OpenAICompatible } from "../src/providers.js"
import { handlerLayer } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"

const openai = OpenAICompatible.configure({ apiKey: "test", baseURL: "https://openai.test/v1" })

const chatBody = sseEvents(
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { content: " world" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
)

/**
 * Executor layer that answers chat completions with SSE text, `slow.test` ones with one text delta that never
 * finishes, and everything under `missing.test` with a 404.
 */
const executor = (seen: Array<string>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      handlerLayer((input) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
          seen.push(web.url)
          if (web.url.startsWith("https://slow.test"))
            return input.respond(
              new ReadableStream({
                start: (controller) =>
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
                    ),
                  ),
              }),
              { headers: { "content-type": "text/event-stream" } },
            )
          if (web.url.endsWith("/chat/completions") && !web.url.startsWith("https://missing.test"))
            return input.respond(chatBody, { headers: { "content-type": "text/event-stream" } })
          return input.respond(JSON.stringify({ error: { message: "not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        }),
      ),
    ),
  )

describe("AI promise client", () => {
  test("generates and streams text over one managed runtime", async () => {
    const seen: Array<string> = []
    const ai = AI.make({ layer: executor(seen) })

    const request = ai.llm.request({ model: openai.model("gpt-4o-mini"), prompt: "Say hello." })
    const text = await ai.llm.generate(request)
    expect(text.text).toBe("Hello world")
    expect((await ai.llm.generate({ model: openai.model("gpt-4o-mini"), prompt: "Say hello." })).text).toBe(
      "Hello world",
    )

    const deltas: Array<string> = []
    for await (const event of ai.llm.stream(request)) {
      if (LLMEvent.is.textDelta(event)) deltas.push(event.text)
    }
    expect(deltas).toEqual(["Hello", " world"])
    const directDeltas: Array<string> = []
    for await (const event of ai.llm.stream({ model: openai.model("gpt-4o-mini"), prompt: "Say hello." })) {
      if (LLMEvent.is.textDelta(event)) directDeltas.push(event.text)
    }
    expect(directDeltas).toEqual(deltas)

    expect(seen).toEqual([
      "https://openai.test/v1/chat/completions",
      "https://openai.test/v1/chat/completions",
      "https://openai.test/v1/chat/completions",
      "https://openai.test/v1/chat/completions",
    ])

    await ai.dispose()
  })

  test("reads, writes, and decodes assets without leaving promises", async () => {
    const ai = AI.make({ layer: executor([]) })
    const dir = await mkdtemp(join(tmpdir(), "ai-promise-"))
    try {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      await Bun.write(join(dir, "source.bin"), png)

      const asset = await ai.file(join(dir, "source.bin"))
      expect(asset.mediaType).toBe("image/png")
      await ai.write(asset, join(dir, "copy.png"))
      expect(await ai.bytes(await ai.file(join(dir, "copy.png")))).toEqual(png)
    } finally {
      await rm(dir, { recursive: true })
      await ai.dispose()
    }
  })

  test("rethrows AIError unchanged and honors abort signals", async () => {
    const ai = AI.make({ layer: executor([]) })

    const missing = OpenAICompatible.configure({ apiKey: "test", baseURL: "https://missing.test/v1" })
    const failure = await ai.llm
      .generate(ai.llm.request({ model: missing.model("gpt-5"), prompt: "Hello" }))
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AIError)
    expect(failure instanceof AIError && failure.reason.http?.status).toBe(404)

    const invalidLLM = await ai.llm
      // @ts-expect-error Invalid input must reject with AIError instead of throwing synchronously.
      .generate({ model: openai.model("gpt-5"), messages: [{ role: "bogus" }] })
      .catch((error: unknown) => error)
    expect(invalidLLM instanceof AIError && invalidLLM.reason._tag).toBe("InvalidRequest")

    const controller = new AbortController()
    controller.abort()
    const aborted = await ai.llm
      .generate(ai.llm.request({ model: openai.model("gpt-4o-mini"), prompt: "Hello" }), { signal: controller.signal })
      .then(() => "completed")
      .catch(() => "aborted")
    expect(aborted).toBe("aborted")

    await ai.dispose()
  })

  test("aborted calls reject and aborted streams throw with the signal's reason", async () => {
    const ai = AI.make({ layer: executor([]) })
    const slow = OpenAICompatible.configure({ apiKey: "test", baseURL: "https://slow.test/v1" }).model("gpt-4o-mini")
    const aborted = new AbortController()
    aborted.abort()
    const reason = new Error("mine")

    const rejected = await ai.run(Effect.never, { signal: aborted.signal }).catch((error: unknown) => error)
    expect(rejected).toBe(aborted.signal.reason)
    expect(rejected).toMatchObject({ name: "AbortError" })

    const inFlight = new AbortController()
    setTimeout(() => inFlight.abort(reason), 10)
    expect(
      await ai.llm
        .generate({ model: slow, prompt: "Hello" }, { signal: inFlight.signal })
        .catch((error: unknown) => error),
    ).toBe(reason)

    const midStream = new AbortController()
    const deltas: Array<string> = []
    const midStreamFailure = await Array.fromAsync(
      ai.llm.stream({ model: slow, prompt: "Hello" }, { signal: midStream.signal }),
      (event) => {
        if (!LLMEvent.is.textDelta(event)) return
        deltas.push(event.text)
        midStream.abort()
      },
    ).catch((error: unknown) => error)
    expect(deltas).toEqual(["Hello"])
    expect(midStreamFailure).toBe(midStream.signal.reason)
    expect(midStreamFailure).toMatchObject({ name: "AbortError" })

    await ai.dispose()
  })

  test("breaking out of an abortable stream cleans up without throwing", async () => {
    const ai = AI.make({ layer: executor([]) })
    const slow = OpenAICompatible.configure({ apiKey: "test", baseURL: "https://slow.test/v1" }).model("gpt-4o-mini")
    const controller = new AbortController()
    const deltas: Array<string> = []
    for await (const event of ai.llm.stream({ model: slow, prompt: "Hello" }, { signal: controller.signal })) {
      if (!LLMEvent.is.textDelta(event)) continue
      deltas.push(event.text)
      break
    }
    controller.abort()
    expect(deltas).toEqual(["Hello"])
    await ai.dispose()
  })

  test("the default client is created lazily and can be disposed", async () => {
    expect(typeof AI.ai.llm.generate).toBe("function")
    await AI.ai.dispose()
  })
})
