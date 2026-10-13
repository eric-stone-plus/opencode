export * as TodoWriteTool from "./todowrite.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { SessionTodo } from "../../session/todo.js"

export const name = "todowrite"

export const description =
  "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current."

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

export const Plugin = {
  id: "opencode.tool.todowrite",
  effect: Effect.fn("TodoWriteTool.Plugin")(function* (ctx: Context) {
    const todos = yield* SessionTodo.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: todowrite", error })),
                Effect.andThen(todos.update({ sessionID: context.sessionID, todos: input.todos }).pipe(Effect.orDie)),
                Effect.map(() => ({ output: { todos: input.todos }, content: toModelOutput({ todos: input.todos }) })),
              ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
