import { expect, test } from "bun:test"
import { permissionPresentation } from "../../src/util/permission"

const CLEAR = "\u001b[2J"
const OSC = "\u001b]52;c;QQ==\u0007"

test("drops control bytes from what the user is asked to approve", () => {
  const shell = permissionPresentation({
    action: "shell",
    resources: [],
    input: { command: `rm -rf /tmp${CLEAR} --no-preserve-root` },
  })

  expect(shell.lines).toEqual(["$ rm -rf /tmp --no-preserve-root"])
  expect(permissionPresentation({ action: "read", resources: [], input: { path: `a${OSC}b` } })).toMatchObject({
    title: "Read ab",
  })
})

test("preserves permission roots and self-contained metadata", () => {
  expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(
    "Access external directory /",
  )
  expect(permissionPresentation({ action: "external_directory", resources: ["C:/*"] }).title).toBe(
    "Access external directory C:/",
  )
  expect(
    permissionPresentation({ action: "webfetch", resources: [], metadata: { url: "https://example.com" } }),
  ).toMatchObject({
    title: "WebFetch https://example.com",
    lines: ["URL: https://example.com"],
  })
  expect(permissionPresentation({ action: "websearch", resources: [], metadata: { query: "releases" } })).toMatchObject(
    {
      title: 'Web Search "releases"',
      lines: ["Query: releases"],
    },
  )
})
