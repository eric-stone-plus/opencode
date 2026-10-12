import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { lspClient } from "./shared"

export default Runtime.handler(
  Commands.commands.debug.commands.lsp.commands.diagnostics,
  Effect.fn("cli.debug.lsp.diagnostics")(function* (input) {
    const rpc = yield* lspClient()
    const diagnostics = yield* rpc.diagnostics({ path: input.file }, { location: { directory: process.cwd() } })
    process.stdout.write(JSON.stringify(diagnostics, null, 2) + EOL)
  }),
)
