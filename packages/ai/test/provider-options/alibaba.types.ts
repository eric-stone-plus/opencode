import { LLM } from "../../src/index.js"
import { Alibaba } from "../../src/providers.js"

const provider = Alibaba.configure({ region: "ap-southeast-1" })
Alibaba.configure({ baseURL: "https://gateway.example/v1" })
Alibaba.configure({ region: "eu-central-1", workspaceID: "llm-workspace" })
LLM.request({
  model: provider.chat("qwen3.8-max"),
  providerOptions: { reasoningEffort: "future", enableThinking: true, preserveThinking: false, toolStream: true },
})
LLM.request({
  model: provider.messages("qwen3.8-max"),
  providerOptions: { effort: "xhigh", thinking: { type: "enabled" } },
})
LLM.request({
  model: provider.messages("qwen3.7-plus"),
  providerOptions: { thinking: { type: "enabled", budgetTokens: 512 } },
})
// @ts-expect-error Region or complete base URL is required.
Alibaba.configure({ apiKey: "fixture" })
LLM.request({
  model: provider.chat("qwen3.8-max"),
  // @ts-expect-error Thinking toggle is a boolean.
  providerOptions: { enableThinking: "true" },
})
LLM.request({
  model: provider.messages("qwen3.8-max"),
  // @ts-expect-error Messages uses effort.
  providerOptions: { reasoningEffort: "high" },
})
