import { EOL } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { lspClient } from "./shared"

export default Runtime.handler(
  Commands.commands.debug.commands.lsp.commands.symbols,
  Effect.fn("cli.debug.lsp.symbols")(function* (input) {
    const rpc = yield* lspClient()
    const file = Option.getOrUndefined(input.file)
    const symbols = yield* rpc.workspaceSymbols(
      { query: input.query, ...(file === undefined ? {} : { path: file }) },
      { location: { directory: process.cwd() } },
    )
    process.stdout.write(JSON.stringify(symbols, null, 2) + EOL)
  }),
)
