export * as Escape from "./escape.js"

/**
 * Escapes for text interpolated into model-visible tagged blocks.
 *
 * Text that reaches a block can come from remote servers, fetched repositories, project files,
 * subagents, shell output, or model-generated summaries. Without escaping, `&`, `<`, `>` let it
 * close the block or forge a sibling one, so every value rendered between tags goes through
 * `escapeText` and every value rendered inside a quoted attribute through `escapeAttribute`.
 */
export const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Attributes additionally collapse quotes and line breaks so a value cannot leave its quotes. */
export const escapeAttribute = (text: string) =>
  escapeText(text).replaceAll('"', "&quot;").replaceAll(/[\r\n]+/g, " ")

/** Single-line text: line breaks collapse so a value cannot forge another line of the block. */
export const escapeLine = (text: string) => escapeText(text.replaceAll(/[\r\n]+/g, " "))
