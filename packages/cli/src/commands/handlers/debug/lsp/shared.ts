import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { OpenCode } from "@opencode/client/effect"
import { Service } from "@opencode/client/effect/service"
import { ForkLsp } from "@opencode/schema/fork-lsp"
import { ServerConnection } from "../../../../services/server-connection"

/** The `fork.lsp` RPC client for the server behind this CLI invocation. */
export const lspClient = Effect.fn("cli.debug.lsp.client")(function* () {
  const { endpoint } = yield* ServerConnection.resolve()
  const client = yield* OpenCode.make({ baseUrl: endpoint.url }).pipe(
    Effect.provideServiceEffect(
      HttpClient.HttpClient,
      HttpClient.HttpClient.pipe(
        Effect.map(HttpClient.mapRequest(HttpClientRequest.setHeaders(Service.headers(endpoint) ?? {}))),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  )
  return client.rpc(ForkLsp.Definition)
})
