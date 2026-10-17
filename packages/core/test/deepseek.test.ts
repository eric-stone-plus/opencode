import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { DeepSeek } from "@opencode/core/deepseek"
import { it } from "./lib/effect"

const mock = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

describe("DeepSeek native tools", () => {
  test("hardcodes the native endpoint and the tuned search body", () => {
    expect(DeepSeek.BASE_URL).toBe("https://api.deepseek.com")
    expect(DeepSeek.MODELS_URL).toBe("https://api.deepseek.com/models")
    expect(DeepSeek.SEARCH_URL).toBe("https://api.deepseek.com/v1/tools/search")
    expect(DeepSeek.FETCH_URL).toBe("https://api.deepseek.com/v1/tools/fetch")
    expect(DeepSeek.searchBody("effect")).toEqual({ query: "effect", count: 5, need_content: false })
  })

  it.live("maps summaries and dates onto the WebSearch result shape", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; headers: Record<string, string> }> = []
      const http = mock((request) => {
        requests.push({ url: request.url, headers: request.headers })
        return json({
          results: [
            {
              url: "https://example.com/a",
              title: "A",
              summary: "Summary A",
              snippet: "Snippet A",
              date: "2026-10-17T00:00:00Z",
            },
            { url: "https://example.com/b", snippet: "Snippet B" },
          ],
        })
      })

      const results = yield* DeepSeek.searchWithKey(http, "secret", "effect")

      expect(requests[0]?.url).toBe(DeepSeek.SEARCH_URL)
      expect(requests[0]?.headers.authorization).toBe("Bearer secret")
      expect(results).toEqual([
        {
          url: "https://example.com/a",
          title: "A",
          content: "Summary A",
          time: { published: Date.parse("2026-10-17T00:00:00Z") },
        },
        { url: "https://example.com/b", title: undefined, content: "Snippet B", time: {} },
      ])
    }),
  )

  it.live("retries a 429 using retry-after", () =>
    Effect.gen(function* () {
      let count = 0
      const http = mock(() => {
        count += 1
        return count === 1
          ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
          : json({ results: [] })
      })

      const results = yield* DeepSeek.searchWithKey(http, "secret", "effect")

      expect(count).toBe(2)
      expect(results).toEqual([])
    }),
  )

  it.live("does not retry a 400", () =>
    Effect.gen(function* () {
      let count = 0
      const http = mock(() => {
        count += 1
        return new Response("bad request", { status: 400 })
      })

      const exit = yield* DeepSeek.searchWithKey(http, "secret", "effect").pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(count).toBe(1)
    }),
  )

  it.live("truncates an oversized summary", () =>
    Effect.gen(function* () {
      const http = mock(() =>
        json({
          results: [{ url: "https://example.com/long", summary: "x".repeat(3_000) }],
        }),
      )

      const results = yield* DeepSeek.searchWithKey(http, "secret", "effect")

      expect(results[0]?.content).toHaveLength(2_001)
      expect(results[0]?.content?.endsWith("…")).toBe(true)
    }),
  )

  it.live("does not split a surrogate pair when truncating", () =>
    Effect.gen(function* () {
      const http = mock(() =>
        json({
          results: [{ url: "https://example.com/emoji", summary: `${"x".repeat(1_999)}😀tail` }],
        }),
      )

      const results = yield* DeepSeek.searchWithKey(http, "secret", "effect")

      expect(results[0]?.content?.endsWith("😀…")).toBe(true)
      expect(results[0]?.content?.includes("\uFFFD")).toBe(false)
    }),
  )

  it.live("returns DeepSeek Fetch markdown", () =>
    Effect.gen(function* () {
      const http = mock(() => json({ title: "Example", content: "# Hello\n\nworld" }))

      const page = yield* DeepSeek.fetchWithKey(http, "secret", "https://example.com")

      expect(page).toEqual({ title: "Example", content: "# Hello\n\nworld" })
    }),
  )

  it.live("rejects an empty DeepSeek Fetch response", () =>
    Effect.gen(function* () {
      const http = mock(() => json({ title: "Empty", content: "   " }))

      const exit = yield* DeepSeek.fetchWithKey(http, "secret", "https://example.com").pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
