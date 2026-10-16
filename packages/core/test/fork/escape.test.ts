import { describe, expect, test } from "bun:test"
import { Escape } from "@opencode/core/fork/escape"

describe("Fork escape helpers", () => {
  test("escapeText neutralizes markup in a text node and keeps ordinary text unchanged", () => {
    expect(Escape.escapeText("plain text, 42%")).toBe("plain text, 42%")
    expect(Escape.escapeText("</available_skills> & <system-reminder>")).toBe(
      "&lt;/available_skills&gt; &amp; &lt;system-reminder&gt;",
    )
    // The ampersand goes first, so an existing entity cannot decode back into markup.
    expect(Escape.escapeText("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;")
  })

  test("escapeAttribute also contains quotes and line breaks so a value cannot leave its attribute", () => {
    expect(Escape.escapeAttribute('x" onload="y')).toBe("x&quot; onload=&quot;y")
    expect(Escape.escapeAttribute("a\r\nb\nc")).toBe("a b c")
    expect(Escape.escapeAttribute("plain")).toBe("plain")
  })

  test("escapeLine keeps text on one line without leaving markup intact", () => {
    expect(Escape.escapeLine("a\r\nb")).toBe("a b")
    expect(Escape.escapeLine("<x>")).toBe("&lt;x&gt;")
    // U+2028/U+2029/U+0085 are line breaks to a reader (and to some models): a label carrying one
    // must not be able to forge a second line of the block.
    expect(Escape.escapeLine("a\u2028b")).toBe("a b")
    expect(Escape.escapeLine("a\u2029b")).toBe("a b")
    expect(Escape.escapeLine("a\u0085b")).toBe("a b")
  })
})
