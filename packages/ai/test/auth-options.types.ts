import { Config } from "effect"
import { Auth } from "../src/route.js"
import type { LanguageModelFactory } from "../src/route/auth-options.js"
import * as OpenAIChat from "../src/protocols/openai-chat.js"
import * as Anthropic from "../src/providers/anthropic.js"
import * as AnthropicCompatible from "../src/providers/anthropic-compatible.js"
import { DeepSeek } from "../src/providers/deepseek.js"
import * as OpenAICompatible from "../src/providers/openai-compatible.js"

type BaseOptions = {
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

type LanguageModel = {
  readonly id: string
}

declare const auth: Auth.Definition
declare const optionalAuthModel: LanguageModelFactory<BaseOptions, "optional", LanguageModel>
declare const requiredAuthModel: LanguageModelFactory<BaseOptions, "required", LanguageModel>
const configApiKey = Config.Redacted("DEEPSEEK_API_KEY")

OpenAIChat.route.model({ id: "gpt-4.1-mini" })

// @ts-expect-error route model selection does not configure endpoints.
OpenAIChat.route.model({ id: "gpt-4.1-mini", baseURL: "https://gateway.example.com/v1" })

// @ts-expect-error route model selection does not configure query params.
OpenAIChat.route.model({ id: "gpt-4.1-mini", queryParams: { debug: "1" } })

// @ts-expect-error route model selection does not configure auth.
OpenAIChat.route.model({ id: "gpt-4.1-mini", auth })

// @ts-expect-error route model selection does not configure api keys.
OpenAIChat.route.model({ id: "gpt-4.1-mini", apiKey: "sk-test" })

optionalAuthModel("gpt-4.1-mini")
optionalAuthModel("gpt-4.1-mini", {})
optionalAuthModel("gpt-4.1-mini", { apiKey: "sk-test" })
optionalAuthModel("gpt-4.1-mini", { apiKey: configApiKey })
optionalAuthModel("gpt-4.1-mini", { auth })
optionalAuthModel("gpt-4.1-mini", { auth, baseURL: "https://gateway.example.com/v1" })
optionalAuthModel("gpt-4.1-mini", { apiKey: "sk-test", headers: { "x-source": "test" } })

// @ts-expect-error auth is an override, so apiKey cannot be supplied with it.
optionalAuthModel("gpt-4.1-mini", { apiKey: "sk-test", auth })

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

OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1" }).model("deepseek-chat")
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", apiKey: "sk-test" }).model("deepseek-chat")
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", apiKey: configApiKey }).model("deepseek-chat")
OpenAICompatible.configure({
  baseURL: "https://gateway.example.com/v1",
  auth: Auth.bearer("oauth-token"),
}).model("deepseek-chat")
OpenAICompatible.configure({
  baseURL: "https://gateway.example.com/v1",
  auth: Auth.headers({ authorization: "Bearer gateway" }),
}).model("deepseek-chat")
OpenAICompatible.configure({
  baseURL: "https://gateway.example.com/v1",
  generation: { maxTokens: 100 },
  providerOptions: { store: false },
}).model("deepseek-chat")

// @ts-expect-error OpenAI-compatible model selectors only accept model ids.
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", apiKey: "sk-test" }).model("deepseek-chat", {})

// @ts-expect-error OpenAI-compatible providers require a base URL.
OpenAICompatible.configure({ apiKey: "sk-test" })

// @ts-expect-error apiKey only accepts string, Redacted<string>, or Config<string | Redacted<string>>.
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", apiKey: 123 })

// @ts-expect-error provider helpers reject unknown top-level options.
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", bogus: true })

// @ts-expect-error common generation options remain typed.
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", generation: { maxTokens: "many" } })

// @ts-expect-error provider-native options remain typed.
OpenAICompatible.configure({ baseURL: "https://gateway.example.com/v1", providerOptions: { store: "false" } })

// @ts-expect-error auth is an override, so OpenAI-compatible rejects apiKey with auth.
OpenAICompatible.configure({
  baseURL: "https://gateway.example.com/v1",
  apiKey: "sk-test",
  auth: Auth.bearer("oauth-token"),
})

Anthropic.configure({ apiKey: "anthropic-key" }).model("claude-haiku")
Anthropic.configure({
  apiKey: "anthropic-key",
  providerOptions: {
    thinking: { type: "enabled", budgetTokens: 1_024 },
    effort: "high",
  },
}).model("claude-haiku")
// @ts-expect-error Anthropic model selectors only accept model ids.
Anthropic.configure({ apiKey: "anthropic-key" }).model("claude-haiku", {})
// @ts-expect-error Anthropic package settings accept only one auth source.
Anthropic.model("claude-sonnet-4-6", { apiKey: "anthropic-key", authToken: "anthropic-token" })
// @ts-expect-error Enabled Anthropic thinking requires a token budget.
Anthropic.configure({ providerOptions: { thinking: { type: "enabled" } } })
// @ts-expect-error Anthropic thinking budgets must be numbers.
Anthropic.configure({ providerOptions: { thinking: { type: "enabled", budgetTokens: "large" } } })

AnthropicCompatible.configure({
  apiKey: "messages-key",
  baseURL: "https://messages.example.com/v1",
  provider: "example",
  providerOptions: { thinking: { type: "disabled" } },
}).model("compatible-model")
// @ts-expect-error Anthropic-compatible providers require a base URL.
AnthropicCompatible.configure({ apiKey: "messages-key" })
// @ts-expect-error Anthropic-compatible model selectors only accept model ids.
AnthropicCompatible.configure({ baseURL: "https://messages.example.com/v1" }).model("compatible-model", {})
// @ts-expect-error Anthropic-compatible package settings accept only one auth source.
AnthropicCompatible.model("compatible-model", {
  apiKey: "messages-key",
  authToken: "messages-token",
  baseURL: "https://messages.example.com/v1",
})

DeepSeek.configure({ apiKey: "deepseek-key" }).model("deepseek-chat")
// @ts-expect-error OpenAI-compatible family selectors only accept model ids.
DeepSeek.configure({ apiKey: "deepseek-key" }).model("deepseek-chat", {})
