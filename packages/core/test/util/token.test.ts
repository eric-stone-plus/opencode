import { describe, expect, it } from "bun:test"
import { Token } from "@opencode/core/util/token"

describe("Token.estimate", () => {
  it("keeps chars/4 for Latin text", () => {
    expect(Token.estimate("")).toBe(0)
    expect(Token.estimate("a".repeat(8))).toBe(2)
    expect(Token.estimate("hello world!")).toBe(3)
  })

  it("counts CJK ideographs at about one token per character", () => {
    // chars/4 would say 1; Chinese runs about one token per character.
    expect(Token.estimate("中文字符")).toBe(4)
  })

  it("mixes scripts: wide characters plus chars/4 for the rest", () => {
    // four Latin characters (1 token) plus two wide characters.
    expect(Token.estimate("abcd中文")).toBe(3)
  })

  it("counts hangul, kana and full-width forms as wide", () => {
    expect(Token.estimate("한국어")).toBe(3)
    expect(Token.estimate("ひらがな")).toBe(4)
    expect(Token.estimate("ＡＢ")).toBe(2)
  })

  it("counts a supplementary ideograph as one token", () => {
    // U+20000 is a surrogate pair; the pair is one token.
    expect(Token.estimate("\u{20000}")).toBe(1)
  })

  it("never returns a negative count", () => {
    expect(Token.estimate("")).toBe(0)
  })
})
