import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { lspClient } from "./shared"

export default Runtime.handler(
  Commands.commands.debug.commands.lsp.commands["document-symbols"],
  Effect.fn("cli.debug.lsp.documentSymbols")(function* (input) {
    const rpc = yield* lspClient()
    const symbols = yield* rpc.documentSymbols({ path: input.file }, { location: { directory: process.cwd() } })
    process.stdout.write(JSON.stringify(symbols, null, 2) + EOL)
  }),
)
