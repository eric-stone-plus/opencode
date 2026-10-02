import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const managed = [
  "tools/planning.ts",
  "tools/drawio.ts",
  "tools/marker.ts",
  "lib/local-tools.ts",
  "lib/drawio.py",
  "skills/planning-with-files/SKILL.md",
  "skills/drawio/SKILL.md",
  "skills/marker/SKILL.md",
] as const

export async function installLocalTools(destination = path.join(homedir(), ".config", "opencode")) {
  const source = fileURLToPath(new URL("../dotfiles/opencode/", import.meta.url))
  const parsed: unknown = await Bun.file(path.join(destination, "local-tools-manifest.json")).json().catch(() => ({}))
  const previous = parsed && typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {}
  const content = await Promise.all(managed.map(async (file) => {
    const value = await readFile(path.join(source, file))
    const current = await readFile(path.join(destination, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    const hash = Bun.CryptoHasher.hash("sha256", value, "hex")
    if (current && !current.equals(value) && Bun.CryptoHasher.hash("sha256", current, "hex") !== previous[file]) {
      throw new Error(`Locally edited file needs review before install: ${path.join(destination, file)}`)
    }
    return { file, value, hash }
  }))
  for (const item of content) {
    const file = path.join(destination, item.file)
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.install-${crypto.randomUUID()}`
    try {
      await writeFile(temporary, item.value, { flag: "wx", mode: 0o644 })
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  await writeFile(path.join(destination, "local-tools-manifest.json"), JSON.stringify(Object.fromEntries(content.map((item) => [item.file, item.hash])), null, 2) + "\n")
  return content.map((item) => path.join(destination, item.file))
}

if (import.meta.main) {
  for (const file of await installLocalTools(process.argv[2])) console.log(`installed ${file}`)
  console.log("Open a new OpenCode session/process to discover the tools and skills. The runtime binary was not changed.")
}
