import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Deploys the local-tools support files. The tools themselves are the V2 plugin
// bootstrap/plugin/local-tools.ts (installed by bootstrap/install.sh step 7);
// this script owns the pieces that plugin reads from the config tree: the drawio
// validator and the three skill files. A hash manifest makes later installs
// refuse locally modified managed files.
const managed = [
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
  console.log("Support files updated. The tools plugin itself is bootstrap/install.sh step 7; open a new OpenCode process to pick up changes.")
}
