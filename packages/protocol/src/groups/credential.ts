import { Credential } from "@opencode/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, InvalidRequestError } from "../errors.js"

export const CredentialGroup = HttpApiGroup.make("server.credential")
  .add(
    HttpApiEndpoint.get("credential.list", "/api/credential", {
      success: Schema.Struct({ data: Schema.Array(Credential.Entry) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.list",
        summary: "List credentials",
        description: "List every stored integration credential, including its secret value.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("credential.create", "/api/credential", {
      payload: Credential.CreateInput,
      success: Schema.Struct({ data: Credential.Entry }),
      error: ConflictError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.create",
        summary: "Create credential",
        description:
          "Store an integration credential. It becomes the integration's active credential unless activate is false and the integration already has one. Fails with a conflict when the requested ID already exists.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("credential.update", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.update",
          summary: "Update credential",
          description: "Update a stored credential label.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "credential" }))
  .add(
    HttpApiEndpoint.post("credential.activate", "/api/credential/:credentialID/activate", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.activate",
          summary: "Activate credential",
          description: "Activate a stored integration credential.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("credential.remove", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.remove",
          summary: "Remove credential",
          description: "Remove a stored integration credential.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("credential.purge", "/api/credential/purge", {
      payload: Credential.PurgeInput,
      success: Schema.Struct({ data: Credential.PurgeResult }),
      error: [InvalidRequestError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "credential.purge",
        summary: "Purge credentials",
        description:
          "Remove every stored credential of the listed integrations, or of all integrations, and optionally sweep other copies of the removed secret values from the server host's credential files, environment, session history, saved tool output, and logs. Reports counts and locations, never secret values. Fails with an invalid request when neither integrationIDs nor all is given, or when both are, and with a conflict when compact is requested while sessions are running.",
      }),
    ),
  )
