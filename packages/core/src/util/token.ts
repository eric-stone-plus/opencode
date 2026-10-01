export * as Token from "./token"

const CHARS_PER_TOKEN = 4
const NON_LATIN = /[\u1100-\uffff]/

// CJK ideographs, kana, hangul and full-width forms run ~1 token per character,
// so chars/4 undercounts Chinese text 3-4x. Everything else stays chars/4.
export const estimate = (input: string) => {
  const first = input.search(NON_LATIN)
  if (first === -1) return Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))
  let wide = 0
  let other = first
  for (let i = first; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code < 0x1100) other++
    else if (
      code <= 0x11ff || // hangul jamo
      (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, punctuation, kana, ext A, unified ideographs
      (code >= 0xa960 && code <= 0xa97f) || // hangul jamo ext A
      (code >= 0xac00 && code <= 0xd7ff) || // hangul syllables + jamo ext B
      (code >= 0xf900 && code <= 0xfaff) || // compatibility ideographs
      (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
      (code >= 0xff00 && code <= 0xffef) // half/full-width forms
    )
      wide++
    else if (code >= 0xd840 && code <= 0xd87f) {
      // supplementary ideographs (ext B-F): one token per surrogate pair
      wide++
      i++
    } else other++
  }
  return Math.max(0, Math.round(wide + other / CHARS_PER_TOKEN))
}
