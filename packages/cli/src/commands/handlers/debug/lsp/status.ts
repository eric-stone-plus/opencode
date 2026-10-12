import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { lspClient } from "./shared"

export default Runtime.handler(
  Commands.commands.debug.commands.lsp.commands.status,
  Effect.fn("cli.debug.lsp.status")(function* () {
    const rpc = yield* lspClient()
    const statuses = yield* rpc.status({}, { location: { directory: process.cwd() } })
    process.stdout.write(JSON.stringify(statuses, null, 2) + EOL)
  }),
)
