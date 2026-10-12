import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart } from "../../src/index.js"
import { OpenAIChat } from "../../src/protocols/openai-chat.js"
import { Auth } from "../../src/route/auth.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

const tool = { name: "lookup", description: "Look up a value", inputSchema: { type: "object", properties: {} } }

for (const route of [OpenAIChat.route]) {
  const model = route
    .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, auth: Auth.bearer("test") })
    .model({ id: "gpt-4.1-mini" })

  for (const choice of [
    { type: "auto" },
    { type: "none" },
    { type: "required" },
    { type: "tool", name: "lookup" },
  ] as const) {
    it.effect(`${route.id} omits ${choice.type} tool choice without active tools`, () =>
      Effect.gen(function* () {
        for (const messages of [
          [Message.user("Say OK.")],
          [
            Message.user("Look up the value."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            Message.tool({ id: "call_1", name: "lookup", result: "OK", resultType: "text" }),
          ],
        ]) {
          const prepared = yield* compileRequest(
            LLM.request({ model, messages, tools: [], toolChoice: choice, cache: "none" }),
          )
          expect(prepared.body.tool_choice).toBeUndefined()
        }
      }),
    )

    it.effect(`${route.id} preserves ${choice.type} tool choice with active tools`, () =>
      Effect.gen(function* () {
        const prepared = yield* compileRequest(
          LLM.request({ model, prompt: "Look up the value.", tools: [tool], toolChoice: choice }),
        )
        expect(prepared.body.tool_choice).toEqual(
          choice.type !== "tool" ? choice.type : { type: "function", function: { name: "lookup" } },
        )
      }),
    )
  }
}
