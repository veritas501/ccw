/**
 * Lightweight terminal markdown renderer.
 * Uses `marked` as a lexer and chalk for ANSI styling.
 * Inspired by Claude Code's formatToken approach but stripped down
 * to essentials — no React, no Ink, no hyperlink detection.
 */

import chalk from "chalk"
import { marked, type Token, type Tokens } from "marked"

const EOL = "\n"

let configured = false

function configure() {
  if (configured) return
  configured = true
  // Disable strikethrough — model often uses ~ for "approximate"
  marked.use({
    tokenizer: {
      del() {
        return undefined
      },
    },
  })
}

/**
 * Render a markdown string to ANSI-styled terminal text.
 */
export function renderMarkdown(content: string): string {
  configure()
  return marked
    .lexer(content)
    .map(t => formatToken(t, 0, null, null))
    .join("")
    .trim()
}

/**
 * Streaming markdown renderer.
 * Parses the full buffer, renders all tokens except the last non-space one
 * (which may still be growing), and returns:
 *   - output: rendered ANSI string for completed tokens
 *   - rest: raw text of the last incomplete token to keep in buffer
 */
export function renderMarkdownStreaming(buffer: string): { output: string; rest: string } {
  configure()
  const tokens = marked.lexer(buffer)

  if (tokens.length === 0) {
    return { output: "", rest: buffer }
  }

  // Find the last non-space token (the one still growing)
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === "space") {
    lastContentIdx--
  }

  // If only one content token, it's still incomplete — keep everything
  if (lastContentIdx <= 0) {
    return { output: "", rest: buffer }
  }

  // Render all stable tokens (everything except the last content token and trailing spaces)
  const stable = tokens.slice(0, lastContentIdx)
  const output = stable
    .map(t => formatToken(t, 0, null, null))
    .join("")
    .trimStart()

  // Reconstruct the raw text of the unstable tail
  const lastToken = tokens[lastContentIdx]!
  const rest = buffer.slice((lastToken as any).raw ? getRawOffset(tokens, lastContentIdx, buffer) : 0)

  return { output, rest }
}

/**
 * Get the byte offset in the original string where token at `idx` starts.
 * We sum up the raw lengths of all preceding tokens.
 */
function getRawOffset(tokens: Token[], idx: number, _buffer: string): number {
  let offset = 0
  for (let i = 0; i < idx; i++) {
    offset += (tokens[i] as any).raw?.length ?? 0
  }
  return offset
}

function formatToken(
  token: Token,
  listDepth: number,
  orderedNum: number | null,
  parent: Token | null,
): string {
  switch (token.type) {
    case "blockquote": {
      const inner = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, null))
        .join("")
      const bar = chalk.dim("│")
      return inner
        .split(EOL)
        .map(line => (line.trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL)
    }

    case "code": {
      const lang = token.lang ? chalk.dim(` ${token.lang}`) : ""
      const border = chalk.dim("```") + lang
      return `${border}${EOL}${token.text}${EOL}${chalk.dim("```")}${EOL}`
    }

    case "codespan":
      return chalk.cyan(token.text)

    case "em":
      return chalk.italic(
        (token.tokens ?? [])
          .map(t => formatToken(t, 0, null, parent))
          .join(""),
      )

    case "strong":
      return chalk.underline(
        (token.tokens ?? [])
          .map(t => formatToken(t, 0, null, parent))
          .join(""),
      )

    case "heading": {
      const prefix = "#".repeat(token.depth)
      const text = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, null))
        .join("")
      return chalk.underline(`${prefix} ${text}`) + EOL
    }

    case "hr":
      return chalk.dim("─".repeat(40)) + EOL

    case "image":
      return token.href

    case "link": {
      const linkText = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, token))
        .join("")
      if (linkText && linkText !== token.href) {
        return `${linkText} ${chalk.dim(`(${token.href})`)}`
      }
      return chalk.underline(token.href)
    }

    case "list":
      return token.items
        .map((item: Token, i: number) =>
          formatToken(
            item,
            listDepth,
            token.ordered ? token.start + i : null,
            token,
          ),
        )
        .join("")

    case "list_item":
      return (token.tokens ?? [])
        .map(
          t =>
            `${"  ".repeat(listDepth)}${formatToken(t, listDepth + 1, orderedNum, token)}`,
        )
        .join("")

    case "paragraph":
      return (
        (token.tokens ?? [])
          .map(t => formatToken(t, 0, null, null))
          .join("") + EOL
      )

    case "space":
      return EOL

    case "br":
      return EOL

    case "text": {
      if (parent?.type === "list_item") {
        const bullet =
          orderedNum === null ? "-" : `${orderedNum}.`
        const inner = token.tokens
          ? token.tokens.map(t => formatToken(t, listDepth, orderedNum, token)).join("")
          : token.text
        return `${bullet} ${inner}${EOL}`
      }
      if (token.tokens) {
        return token.tokens
          .map(t => formatToken(t, listDepth, orderedNum, token))
          .join("")
      }
      return token.text
    }

    case "table": {
      const tableToken = token as Tokens.Table

      function getDisplayWidth(tokens: Token[] | undefined): number {
        const text = tokens
          ?.map(t => formatToken(t, 0, null, null))
          .join("") ?? ""
        return stripAnsi(text).length
      }

      // Column widths
      const colWidths = tableToken.header.map((h, i) => {
        let max = getDisplayWidth(h.tokens)
        for (const row of tableToken.rows) {
          max = Math.max(max, getDisplayWidth(row[i]?.tokens))
        }
        return Math.max(max, 3)
      })

      // Header
      let out = "| "
      tableToken.header.forEach((h, i) => {
        const content = h.tokens
          ?.map(t => formatToken(t, 0, null, null))
          .join("") ?? ""
        const w = getDisplayWidth(h.tokens)
        out += pad(content, w, colWidths[i]!) + " | "
      })
      out = out.trimEnd() + EOL

      // Separator
      out += "|"
      colWidths.forEach(w => {
        out += "-".repeat(w + 2) + "|"
      })
      out += EOL

      // Rows
      tableToken.rows.forEach(row => {
        out += "| "
        row.forEach((cell, i) => {
          const content = cell.tokens
            ?.map(t => formatToken(t, 0, null, null))
            .join("") ?? ""
          const w = getDisplayWidth(cell.tokens)
          out += pad(content, w, colWidths[i]!) + " | "
        })
        out = out.trimEnd() + EOL
      })

      return out + EOL
    }

    case "escape":
      return token.text

    case "def":
    case "del":
    case "html":
      return ""
  }

  return ""
}

// ─── Helpers ───

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

function pad(content: string, displayWidth: number, targetWidth: number): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  return content + " ".repeat(padding)
}
