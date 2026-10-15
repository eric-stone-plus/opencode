import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencode -s ses_123")
})

test("strips control characters from untrusted titles", () => {
  const epilogue = sessionEpilogue({ title: "evil\x1b]52;c;Y3VybCB8c2g=\x07", sessionID: "ses_123" })
  // No ESC-] (OSC) and no BEL survive: the payload stays inert printable text.
  expect(epilogue).not.toContain("\x1b]")
  expect(epilogue).not.toContain("\x07")
  expect(epilogue).toContain("evil ]52;c;Y3VybCB8c2g=")
})
