import * as Anthropic from "../../src/providers/anthropic"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import { describeRecordedGoldenScenarios } from "../recorded-golden"

const anthropic = Anthropic.configure({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "fixture",
})
const anthropicHaiku = anthropic.model("claude-haiku-4-5-20251001")
const anthropicOpus = anthropic.model("claude-opus-4-7")
const deepseek = OpenAICompatible.deepseek
  .configure({ apiKey: process.env.DEEPSEEK_API_KEY ?? "fixture" })
  .model("deepseek-chat")

describeRecordedGoldenScenarios([
  {
    name: "Anthropic Haiku 4.5",
    prefix: "anthropic-messages",
    model: anthropicHaiku,
    requires: ["ANTHROPIC_API_KEY"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Anthropic Opus 4.7",
    prefix: "anthropic-messages",
    model: anthropicOpus,
    requires: ["ANTHROPIC_API_KEY"],
    tags: ["flagship"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: [
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "DeepSeek Chat",
    prefix: "openai-compatible-chat",
    model: deepseek,
    requires: ["DEEPSEEK_API_KEY"],
    scenarios: ["text"],
  },
])
