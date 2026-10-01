import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "@/provider/error"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRetry } from "@/session/retry"
import { MessageV2 } from "@/session/message-v2"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})

// Body shape recorded from a real Bailian rejection: an SSE error event whose
// message embeds the DashScope error JSON.
const moderationBody = [
  "event:error",
  `data:${JSON.stringify({
    request_id: "71aa6449-aa1b-42b3-8eb6-56e5f5650500",
    code: "InvalidParameter",
    message: `data: ${JSON.stringify({
      error: {
        code: "data_inspection_failed",
        param: null,
        message: "Input text data may contain inappropriate content.",
        type: "data_inspection_failed",
      },
      id: "chatcmpl-93461777-c630-4a5f-a5f0-cd5778bbbcce",
    })}`,
  })}`,
].join("\n")

describe("provider moderation rejections", () => {
  const providerID = ProviderV2.ID.make("bailian")

  test("maps Bailian data_inspection_failed to a non-retryable error with recovery guidance", () => {
    const error = new APICallError({
      message: "Bad Request",
      url: "https://example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: moderationBody,
      isRetryable: false,
    })
    const parsed = ProviderError.parseAPICallError({ providerID, error })

    expect(parsed).toMatchObject({
      type: "api_error",
      statusCode: 400,
      isRetryable: false,
      metadata: { code: "data_inspection_failed" },
    })
    expect(parsed.message).toContain("/undo")
    expect(parsed.message).toContain("/compact")
  })

  test("never schedules a retry, even when a request ID looks like a status code", () => {
    // The request ID above ends in 500, which the generic patterns treat as retryable.
    const error = MessageV2.fromError(
      new APICallError({
        message: "Bad Request",
        url: "https://example.com/v1/messages",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: moderationBody,
        isRetryable: false,
      }),
      { providerID },
    )

    expect(SessionRetry.retryable(error, providerID)).toBeUndefined()
  })

  test("maps an in-stream moderation error the same way", () => {
    const parsed = ProviderError.parseStreamError({
      type: "error",
      error: { code: "data_inspection_failed", message: "Input text data may contain inappropriate content." },
    })

    expect(parsed).toMatchObject({ type: "api_error", isRetryable: false })
    expect(parsed?.message).toBe(ProviderError.MODERATION_MESSAGE)
  })
})

describe("provider context overflow", () => {
  test("detects Zhipu code 1261 from the body even when the message is generic", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
      error: new APICallError({
        message: "Bad Request",
        url: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "1261", message: "Bad request" } }),
        isRetryable: false,
      }),
    })
    expect(parsed.type).toBe("context_overflow")
  })

  test("detects in-stream Zhipu and DashScope overflow errors", () => {
    expect(
      ProviderError.parseStreamError({ type: "error", error: { code: 1261, message: "Prompt exceeds max length" } }),
    ).toMatchObject({ type: "context_overflow", message: "Prompt exceeds max length" })
    expect(
      ProviderError.parseStreamError({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]",
        },
      }),
    ).toMatchObject({ type: "context_overflow" })
  })
})
