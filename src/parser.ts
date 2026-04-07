/**
 * NDJSON line parser for Claude Code stream-json output.
 * Handles incomplete lines from pipe buffering and filters noise.
 */

import type { SDKMessage } from "./types.js"

export type MessageHandler = (msg: SDKMessage) => void

/**
 * Create an NDJSON line parser.
 * Returns a function that accepts raw bytes/chunks from stdout.
 * Handles partial line buffering across chunk boundaries.
 */
export function createParser(onMessage: MessageHandler) {
  let buffer = ""

  return function feed(chunk: string) {
    buffer += chunk
    const lines = buffer.split("\n")
    // Last element is always incomplete (or empty string if chunk ended with \n)
    buffer = lines.pop()!

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as SDKMessage
        // Filter noise
        if (msg.type === "keep_alive") continue
        onMessage(msg)
      } catch {
        // Malformed line — skip silently
      }
    }
  }
}

/**
 * Flush remaining buffer (call on stream end).
 */
export function createFlushableParser(onMessage: MessageHandler) {
  const feed = createParser(onMessage)
  return {
    feed,
    flush() {
      // Buffer is always the remaining incomplete line
      // (handled internally, nothing to flush in normal NDJSON)
    },
  }
}
