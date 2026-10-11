import { Config } from "effect"
import type { Auth } from "../src/route/auth"
import type { ModelFactory } from "../src/route/auth-options"
import { Auth as RuntimeAuth } from "../src/route/auth"
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as Anthropic from "../src/providers/anthropic"
import * as OpenAICompatible from "../src/providers/openai-compatible"

type BaseOptions = {
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

type Model = {
  readonly id: string
}

declare const auth: Auth
declare const optionalAuthModel: ModelFactory<BaseOptions, "optional", Model>
declare const requiredAuthModel: ModelFactory<BaseOptions, "required", Model>
const configApiKey = Config.redacted("DEEPSEEK_API_KEY")

OpenAIChat.route.model({ id: "deepseek-chat" })

// @ts-expect-error route model selection does not configure endpoints.
OpenAIChat.route.model({ id: "deepseek-chat", baseURL: "https://gateway.example.com/v1" })

// @ts-expect-error route model selection does not configure query params.
OpenAIChat.route.model({ id: "deepseek-chat", queryParams: { debug: "1" } })

// @ts-expect-error route model selection does not configure auth.
OpenAIChat.route.model({ id: "deepseek-chat", auth })

// @ts-expect-error route model selection does not configure api keys.
OpenAIChat.route.model({ id: "deepseek-chat", apiKey: "sk-test" })

optionalAuthModel("deepseek-chat")
optionalAuthModel("deepseek-chat", {})
optionalAuthModel("deepseek-chat", { apiKey: "sk-test" })
optionalAuthModel("deepseek-chat", { apiKey: configApiKey })
optionalAuthModel("deepseek-chat", { auth })
optionalAuthModel("deepseek-chat", { auth, baseURL: "https://gateway.example.com/v1" })
optionalAuthModel("deepseek-chat", { apiKey: "sk-test", headers: { "x-source": "test" } })

// @ts-expect-error auth is an override, so apiKey cannot be supplied with it.
optionalAuthModel("deepseek-chat", { apiKey: "sk-test", auth })

requiredAuthModel("custom-model", { apiKey: "key" })
requiredAuthModel("custom-model", { apiKey: configApiKey })
requiredAuthModel("custom-model", { auth })
requiredAuthModel("custom-model", { auth, headers: { "x-tenant-id": "tenant" } })

// @ts-expect-error providers without config fallback need apiKey or auth.
requiredAuthModel("custom-model")

// @ts-expect-error providers without config fallback need apiKey or auth.
requiredAuthModel("custom-model", {})

// @ts-expect-error auth is an override, so apiKey cannot be supplied with it.
requiredAuthModel("custom-model", { apiKey: "key", auth })

OpenAICompatible.deepseek.model("deepseek-chat")
OpenAICompatible.deepseek.configure({}).model("deepseek-chat")
OpenAICompatible.deepseek.configure({ apiKey: "sk-test" }).model("deepseek-chat")
OpenAICompatible.deepseek.configure({ apiKey: configApiKey }).model("deepseek-chat")
OpenAICompatible.deepseek.configure({ auth: RuntimeAuth.bearer("oauth-token") }).model("deepseek-chat")
OpenAICompatible.deepseek
  .configure({
    auth: RuntimeAuth.headers({ authorization: "Bearer gateway" }),
    baseURL: "https://gateway.example.com/v1",
  })
  .model("deepseek-chat")
OpenAICompatible.deepseek.configure({ generation: { maxTokens: 100 } }).model("deepseek-chat")

// @ts-expect-error OpenAI-compatible family selectors only accept model ids.
OpenAICompatible.deepseek.configure({ apiKey: "sk-test" }).model("deepseek-chat", {})

// @ts-expect-error apiKey only accepts string, Redacted<string>, or Config<string | Redacted<string>>.
OpenAICompatible.deepseek.configure({ apiKey: 123 })

// @ts-expect-error provider helpers reject unknown top-level options.
OpenAICompatible.deepseek.configure({ bogus: true })

// @ts-expect-error common generation options remain typed.
OpenAICompatible.deepseek.configure({ generation: { maxTokens: "many" } })

// @ts-expect-error auth is an override, so the family helper rejects apiKey with auth.
OpenAICompatible.deepseek.configure({ apiKey: "sk-test", auth: RuntimeAuth.bearer("oauth-token") })

OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1" }).model("deepseek-chat")
OpenAICompatible.configure({ provider: "gateway", baseURL: "https://gateway.example.com/v1", apiKey: "sk-test" }).model(
  "deepseek-chat",
)

// @ts-expect-error generic OpenAI-compatible providers require a baseURL.
OpenAICompatible.configure({})

// @ts-expect-error generic OpenAI-compatible model selectors only accept model ids.
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1" }).model("deepseek-chat", {})

Anthropic.configure({ apiKey: "anthropic-key" }).model("claude-haiku")
Anthropic.configure({ apiKey: configApiKey }).model("claude-haiku")
Anthropic.configure({ auth: RuntimeAuth.bearer("oauth-token") }).model("claude-haiku")
// @ts-expect-error Anthropic model selectors only accept model ids.
Anthropic.configure({ apiKey: "anthropic-key" }).model("claude-haiku", {})
// @ts-expect-error auth is an override, so Anthropic rejects apiKey with auth.
Anthropic.configure({ apiKey: "anthropic-key", auth: RuntimeAuth.bearer("oauth-token") })
