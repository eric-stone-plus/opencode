import { Shell } from "@opencode/core/shell"
import { Location } from "@opencode/core/location"
import { Shell as ShellSchema } from "@opencode/schema/shell"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { ShellNotFoundError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { response } from "../location"

const missingShell = (id: ShellSchema.ID) =>
  new ShellNotFoundError({ id, message: `Shell command not found: ${id}` })

// Shell ids are location-scoped, not session-scoped. A session token may only observe shells
// whose metadata records its own session; foreign ids answer exactly like missing ids.
const ownedShell = (shell: Shell.Interface, id: ShellSchema.ID, access: ServerAuth.Access) =>
  Effect.gen(function* () {
    const info = yield* shell
      .get(id)
      .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.fail(missingShell(id))))
    if (access.kind === "session" && info.metadata.sessionID !== access.sessionID)
      return yield* missingShell(id)
    return info
  })

export const ShellHandler = HttpApiBuilder.group(Api, "server.shell", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "shell.list",
        Effect.fn(function* () {
          const shell = yield* Shell.Service
          const access = yield* ServerAuth.AccessService
          return yield* response(
            shell.list().pipe(
              Effect.map((items) =>
                access.kind === "session"
                  ? items.filter((item) => item.metadata.sessionID === access.sessionID)
                  : items,
              ),
            ),
          )
        }),
      )
      .handle(
        "shell.create",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const location = yield* Location.Service
          return yield* response(
            shell.create({ ...ctx.payload, cwd: ctx.payload.cwd || location.directory }).pipe(Effect.orDie),
          )
        }),
      )
      .handle(
        "shell.get",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const access = yield* ServerAuth.AccessService
          return yield* response(ownedShell(shell, ctx.params.id, access))
        }),
      )
      .handle(
        "shell.output",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const access = yield* ServerAuth.AccessService
          yield* ownedShell(shell, ctx.params.id, access)
          return yield* response(
            shell
              .output(ctx.params.id, { cursor: ctx.query.cursor, limit: ctx.query.limit })
              .pipe(
                Effect.catchTag(
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        "shell.remove",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          const access = yield* ServerAuth.AccessService
          const info = yield* shell.get(ctx.params.id).pipe(Effect.option)
          if (
            Option.isNone(info) ||
            (access.kind === "session" && info.value.metadata.sessionID !== access.sessionID)
          )
            return HttpApiSchema.NoContent.make()
          yield* shell.remove(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
