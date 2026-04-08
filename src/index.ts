/**
 * Claude Code Workflow Wrapper
 *
 * Spawns `claude -p --output-format stream-json --verbose` as a child process,
 * parses NDJSON output, and renders messages in REPL-like terminal style.
 *
 * Usage:
 *   ccw "your prompt" [--model sonnet] [--max-turns 5] [...any claude flags]
 *   echo "prompt" | ccw
 */

import { spawn } from "child_process"
import { createParser } from "./parser.js"
import { render, resetState, printFinalSummary } from "./renderer.js"

// ─── CLI args ───

const argv = process.argv.slice(2)

if (argv.length === 0 && process.stdin.isTTY) {
  console.log("Usage: ccw <prompt> [...claude flags]")
  console.log("       echo <prompt> | ccw [...claude flags]")
  process.exit(1)
}

// ─── Build claude command ───

const claudeArgs = [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--max-turns", "0",
  ...argv,
]

resetState()

// ─── Spawn claude ───

const child = spawn("claude", claudeArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
})

const feed = createParser((msg) => {
  render(msg)
})

// Pipe stdout → parser
child.stdout.on("data", (chunk: Buffer) => {
  feed(chunk.toString("utf-8"))
})

// Forward stderr (debug logs, warnings)
child.stderr.on("data", (chunk: Buffer) => {
  process.stderr.write(chunk)
})

// Forward stdin if piped; otherwise close child stdin immediately
// to avoid Claude's "no stdin data received in 3s" warning
if (!process.stdin.isTTY) {
  process.stdin.pipe(child.stdin)
} else {
  child.stdin!.end()
}

// Handle child exit
child.on("close", (code) => {
  printFinalSummary()
  process.exit(code ?? 0)
})

// Forward signals
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    child.kill(sig)
  })
}
