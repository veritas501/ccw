# ccw — Claude Code Workflow Wrapper

A lightweight CLI wrapper for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that spawns `claude` in non-interactive mode and renders streaming JSON output with a clean, REPL-like terminal UI.

## Features

- Real-time streaming text with colored output
- Multi-phase spinner: thinking → talking → tool-input → tool-use
- Markdown rendering with ANSI styling (headings, bold, code, tables, etc.)
- Collapsible tool call groups (Read/Grep/Glob auto-collapse)
- Tool calls rendered individually with input summary and result preview
- Session result summary (duration, turns, cost, tokens)
- Typed SDK message handling (no `as any`)
- Pipe-friendly: accepts prompt from stdin or CLI args

## Requirements

- [Bun](https://bun.sh/) >= 1.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` command available in PATH)

## Install

### From source (recommended)

```bash
# Clone and install dependencies
git clone <repo-url> && cd claude_code_workflow_wrapper
bun install

# Build native ELF binary and install to ~/.local/bin
bun run install
```

### Development mode

```bash
bun run dev -- "your prompt"
```

## Uninstall

```bash
bun run uninstall
```

## Usage

```bash
# Basic usage
ccw "explain this codebase"

# Pipe prompt from stdin
echo "list all TODOs" | ccw

# Pass additional claude flags
ccw "refactor auth module" --model sonnet --max-turns 5

# All claude -p flags are forwarded
ccw "fix the bug" --allowedTools Bash,Edit,Read
```

### Default flags

`ccw` automatically appends:

| Flag | Purpose |
|---|---|
| `-p` | Non-interactive (pipe) mode |
| `--output-format stream-json` | NDJSON streaming output |
| `--verbose` | Include system/tool messages |
| `--include-partial-messages` | Enable real-time streaming |
| `--max-turns 0` | Unlimited turns (override with `--max-turns N`) |

## Build

```bash
# Compile to native binary (output: dist/ccw)
bun run build

# Run directly without compiling
bun run start -- "prompt"
```

## Project Structure

```
src/
  index.ts      — Entry point, CLI arg parsing, child process management
  types.ts      — TypeScript definitions for Claude stream-json protocol
  parser.ts     — NDJSON line parser with partial-line buffering
  renderer.ts   — Terminal renderer with spinner, tool groups, colored output
  markdown.ts   — Streaming markdown-to-ANSI renderer (using marked lexer + chalk)
  utils.ts      — Shared utilities (stripAnsi)
```

## License

MIT
