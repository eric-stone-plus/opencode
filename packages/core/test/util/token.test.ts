import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"

describe("Token.estimate", () => {
  test("keeps chars/4 for latin text", () => {
    expect(Token.estimate("")).toBe(0)
    expect(Token.estimate("abcd".repeat(100))).toBe(100)
    expect(Token.estimate("café ñ ü é".repeat(40))).toBe(100)
  })

  test("counts CJK, kana and hangul as one token per character", () => {
    expect(Token.estimate("你好世界")).toBe(4)
    expect(Token.estimate("こんにちは")).toBe(5)
    expect(Token.estimate("カタカナ")).toBe(4)
    expect(Token.estimate("안녕하세요")).toBe(5)
    expect(Token.estimate("，。！？（）")).toBe(6)
    // supplementary ideograph (surrogate pair) is one token, not two
    expect(Token.estimate("𠀀𠀁")).toBe(2)
  })

  test("mixes CJK and latin in one pass", () => {
    // 7 CJK chars + 17 ascii chars
    expect(Token.estimate("修复上下文溢出 fix overflow!!!!")).toBe(7 + 4)
    expect(Token.estimate("abcd" + "中".repeat(10) + "abcd")).toBe(12)
  })

  test("non-CJK supplementary characters stay chars/4", () => {
    expect(Token.estimate("😀😀")).toBe(1)
  })

  test("is fast on multi-megabyte strings", () => {
    const ascii = "x".repeat(8_000_000)
    const cjk = "中文内容".repeat(1_000_000)
    const start = performance.now()
    expect(Token.estimate(ascii)).toBe(2_000_000)
    expect(Token.estimate(cjk)).toBe(4_000_000)
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
