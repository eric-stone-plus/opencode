import { Credential } from "@opencode/core/credential"
import { CredentialPurge } from "@opencode/core/credential/purge"
import { Session } from "@opencode/core/session"
import { ConflictError, InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"

export const CredentialHandler = HttpApiBuilder.group(Api, "server.credential", (handlers) =>
  handlers
    .handle(
      "credential.list",
      Effect.fn(function* () {
        const credential = yield* Credential.Service
        return { data: entries(yield* credential.all()) }
      }),
    )
    .handle(
      "credential.create",
      Effect.fn(function* (ctx) {
        const credential = yield* Credential.Service
        if (ctx.payload.id && (yield* credential.get(ctx.payload.id)))
          return yield* new ConflictError({
            resource: ctx.payload.id,
            message: `Credential already exists: ${ctx.payload.id}`,
          })
        const created = yield* credential.create(ctx.payload)
        const entry = entries(yield* credential.list(created.integrationID)).find((item) => item.id === created.id)
        return { data: entry ?? { ...created, active: false } }
      }),
    )
    .handle(
      "credential.update",
      Effect.fn(function* (ctx) {
        const credential = yield* Credential.Service
        yield* credential.update(ctx.params.credentialID, { label: ctx.payload.label })
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "credential.activate",
      Effect.fn(function* (ctx) {
        const credential = yield* Credential.Service
        yield* credential.activate(ctx.params.credentialID)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "credential.remove",
      Effect.fn(function* (ctx) {
        const credential = yield* Credential.Service
        yield* credential.remove(ctx.params.credentialID)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "credential.purge",
      Effect.fn(function* (ctx) {
        const selected = (ctx.payload.integrationIDs?.length ?? 0) > 0
        if (selected === (ctx.payload.all === true))
          return yield* new InvalidRequestError({
            message: "Pass integrationIDs or all, not both and not neither",
            field: selected ? "all" : "integrationIDs",
          })
        const purge = yield* CredentialPurge.Service
        // Rewriting the database file blocks this server's event loop, which would stall running sessions.
        if (ctx.payload.compact === true && ctx.payload.dryRun !== true) {
          const session = yield* Session.Service
          const running = yield* session.active
          if (running.size > 0)
            return yield* new ConflictError({
              message: `Cannot compact the database while ${running.size} session(s) are running. Interrupt them, or stop the service and run the purge with --standalone.`,
            })
        }
        return { data: yield* purge.run(ctx.payload) }
      }),
    ),
)

// Credential listings order each integration's selected credential last.
function entries(credentials: Credential.Info[]) {
  const selected = new Map(credentials.map((item) => [item.integrationID, item.id]))
  return credentials.map((item) => ({
    id: item.id,
    integrationID: item.integrationID,
    label: item.label,
    active: selected.get(item.integrationID) === item.id,
    value: item.value,
  }))
}
