/**
 * Terminal renderer — mimics Claude Code REPL visual style.
 *
 * Key design decisions:
 * - Tool input is streamed via input_json_delta; accumulate before display
 * - Tool results arrive in user message AFTER message_stop; don't flush at message_stop
 * - Show collapsible tool summary after results arrive and next turn begins
 * - Real-time spinner: "⏺ thinking · 3.2s · 150 tokens"
 */

import chalk from "chalk"
import { renderMarkdown, renderMarkdownStreaming } from "./markdown.js"
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKStreamEventMessage,
  SDKToolProgressMessage,
  SDKSystemMessage,
  SDKControlRequestMessage,
  ContentBlock,
  ToolUseBlock,
} from "./types.js"

// ─── Theme (dark) ───

const C = {
  claude:   chalk.rgb(215, 119, 87),
  success:  chalk.rgb(78, 186, 101),
  error:    chalk.rgb(255, 107, 128),
  warning:  chalk.rgb(255, 193, 7),
  dim:      chalk.dim,
  bold:     chalk.bold,
  cyan:     chalk.cyan,
  gray:     chalk.gray,
}

const INDENT = "  "
const DOT = "●"
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

// ─── State ───

interface ToolOp {
  id: string
  name: string
  inputJson: string   // accumulated from input_json_delta
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

// All tool ops in the current group (one assistant turn's tool calls)
let toolGroup: ToolOp[] = []
// Map tool_use_id → ToolOp for result matching
let toolById = new Map<string, ToolOp>()
// id of the currently streaming tool (receiving input_json_delta)
let activeToolId = ""
// Whether we've displayed any text this session
let textStarted = false
// Line buffer for streaming text output
let textLineBuf = ""
// Whether the spinner line is currently drawn (needs clearing)
let spinnerActive = false
// Turn start time for elapsed display
let turnStartMs = 0
// Accumulated output tokens this turn
let outputTokens = 0
// Spinner interval handle
let spinnerTimer: ReturnType<typeof setInterval> | null = null

export function resetState() {
  toolGroup = []
  toolById.clear()
  activeToolId = ""
  textStarted = false
  textLineBuf = ""
  spinnerActive = false
  turnStartMs = 0
  outputTokens = 0
  stopSpinner()
}

// ─── Spinner ───

function startSpinner() {
  if (spinnerTimer) return
  turnStartMs = Date.now()
  outputTokens = 0
  spinnerTimer = setInterval(drawSpinner, 100)
  drawSpinner()
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = null
  }
  if (spinnerActive) {
    clearSpinnerLine()
  }
}

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
let spinFrame = 0

function drawSpinner() {
  spinFrame = (spinFrame + 1) % SPIN_FRAMES.length
  const frame = SPIN_FRAMES[spinFrame]
  const elapsed = ((Date.now() - turnStartMs) / 1000).toFixed(1)
  const tokens = outputTokens > 0 ? ` · ${outputTokens} tokens` : ""
  const line = C.dim(`${frame} thinking · ${elapsed}s${tokens}`)
  process.stderr.write(`\r${line}\r`)
  spinnerActive = true
}

function clearSpinnerLine() {
  process.stderr.write("\r\x1b[2K")
  spinnerActive = false
}

// ─── Output helpers ───

/**
 * Streaming flush: parse buffer, render completed tokens, keep last
 * (possibly incomplete) token in buffer.
 */
function flushTextParagraphs() {
  const { output, rest } = renderMarkdownStreaming(textLineBuf)
  if (output) {
    write(output)
  }
  textLineBuf = rest
}

function write(s: string) {
  process.stdout.write(s)
}

function writeLine(s: string = "") {
  write(s + "\n")
}

// ─── Flush collapsible tool group ───

/**
 * Render and clear the accumulated tool group.
 * Called when next text starts or result arrives.
 */
function flushToolGroup() {
  if (toolGroup.length === 0) return

  // Separate: Bash/others always render individually, Read/Grep/Glob can collapse
  const individual: ToolOp[] = []
  const collapsible: ToolOp[] = []
  let searches = 0, reads = 0, lists = 0

  for (const op of toolGroup) {
    switch (op.name) {
      case "Grep":   collapsible.push(op); searches++; break
      case "Glob":   collapsible.push(op); lists++;    break
      case "Read":   collapsible.push(op); reads++;    break
      default:       individual.push(op);              break
    }
  }

  // Render Bash and other tools individually (always visible)
  for (const op of individual) {
    renderSingleToolOp(op)
  }

  // Collapse Read/Grep/Glob when more than one
  if (collapsible.length > 1) {
    const parts: string[] = []
    if (searches > 0) parts.push(`Searched for ${searches} pattern${searches > 1 ? "s" : ""}`)
    if (reads > 0)    parts.push(`read ${reads} file${reads > 1 ? "s" : ""}`)
    if (lists > 0)    parts.push(`listed ${lists} director${lists > 1 ? "ies" : "y"}`)
    writeLine(C.dim(`${C.success(DOT)} ${parts.join(", ")}`))
  } else {
    for (const op of collapsible) {
      renderSingleToolOp(op)
    }
  }

  toolGroup = []
  toolById.clear()
}

function renderSingleToolOp(op: ToolOp) {
  const display = toolDisplayName(op.name)
  const details = formatToolInput(op.name, op.input)
  const namePart = C.bold(display)
  const detailPart = details ? ` ${C.gray(details)}` : ""

  const dotColor = op.isError ? C.error : C.success

  if (op.result !== undefined) {
    writeLine(`${dotColor(DOT)} ${namePart}${detailPart}`)
    const summary = summarizeResult(op.name, op.result, op.isError)
    if (summary) {
      const lines = summary.split("\n")
      for (const line of lines) {
        writeLine(C.dim(`${INDENT}⎿  ${line}`))
      }
    }
  } else {
    writeLine(`${dotColor(DOT)} ${namePart}${detailPart}`)
  }
}

// ─── Main dispatch ───

export function render(msg: SDKMessage): void {
  switch (msg.type) {
    case "system":        renderSystem(msg);         break
    case "stream_event":  renderStreamEvent(msg);    break
    case "assistant":     renderAssistant(msg);      break
    case "user":          renderUser(msg);           break
    case "tool_progress": renderToolProgress(msg);   break
    case "result":        renderResult(msg);         break
    case "control_request": renderControlRequest(msg); break
  }
}

// ─── Renderers ───

function renderSystem(msg: SDKSystemMessage) {
  switch (msg.subtype) {
    case "init": {
      const model = stripAnsi((msg as any).model ?? "unknown")
      writeLine(C.dim(`Model: ${model}`))
      break
    }
    case "status":
      if ((msg as any).status === "compacting") {
        writeLine(C.dim(`${INDENT}Compacting context...`))
      }
      break
    case "task_started":
      writeLine(C.dim(`${INDENT}◷ Task: ${(msg as any).description?.slice(0, 80) ?? "..."}`))
      break
    case "task_notification": {
      const tn = msg as any
      const icon = tn.status === "completed" ? "✓" : tn.status === "failed" ? "✗" : "○"
      const summary = tn.summary ? `: ${tn.summary.slice(0, 80)}` : ""
      writeLine(C.dim(`${INDENT}${icon} Task ${tn.task_id?.slice(0, 8) ?? ""}${summary}`))
      break
    }
  }
}

function renderStreamEvent(msg: SDKStreamEventMessage) {
  const event = msg.event

  switch (event.type) {
    case "message_start": {
      // New API turn starts — start spinner
      startSpinner()
      break
    }

    case "content_block_start": {
      const block = event.content_block
      if (block.type === "tool_use") {
        const tool = block as ToolUseBlock
        activeToolId = tool.id
        const op: ToolOp = { id: tool.id, name: tool.name, inputJson: "", input: {} }
        toolGroup.push(op)
        toolById.set(tool.id, op)
      } else if (block.type === "text") {
        // Text starting — stop spinner, flush accumulated tool group from prev turn
        stopSpinner()
        if (toolGroup.length > 0) {
          // Only flush if all ops have results (i.e. this is the response turn after tools)
          // If no results yet, defer to user message handling
          const allDone = toolGroup.every(o => o.result !== undefined)
          if (allDone) flushToolGroup()
        }
        if (textStarted) {
          // Second text block in same response: add spacing
          write("\n\n")
        }
        textStarted = true
      }
      break
    }

    case "content_block_delta": {
      const delta = event.delta
      if (delta.type === "text_delta" && delta.text) {
        stopSpinner()
        textLineBuf += delta.text
        // Flush on paragraph boundary (double newline)
        flushTextParagraphs()
      } else if (delta.type === "thinking_delta") {
        // Count thinking tokens for spinner display
        outputTokens++
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        // Accumulate tool input JSON
        const op = toolById.get(activeToolId)
        if (op) {
          op.inputJson += delta.partial_json
        }
      }
      break
    }

    case "content_block_stop": {
      // Tool input fully streamed — parse it
      const op = toolById.get(activeToolId)
      if (op && op.inputJson) {
        try {
          op.input = JSON.parse(op.inputJson)
        } catch {
          op.input = {}
        }
      }
      activeToolId = ""
      break
    }

    case "message_delta": {
      // Track output token count for spinner
      const usage = (event as any).usage
      if (usage?.output_tokens) {
        outputTokens = usage.output_tokens
      }
      break
    }

    case "message_stop": {
      stopSpinner()
      // Render remaining text as markdown
      if (textLineBuf) {
        const rendered = renderMarkdown(textLineBuf)
        if (rendered) {
          write(rendered)
        }
        textLineBuf = ""
      }
      if (textStarted) {
        write("\n")
        textStarted = false
      }
      break
    }
  }
}

function renderAssistant(msg: SDKAssistantMessage) {
  // With partial messages, tool_use blocks may arrive here before stream_event.
  // Register any tool IDs we haven't seen yet.
  for (const block of msg.message.content) {
    if (block.type === "tool_use") {
      const tool = block as ToolUseBlock
      if (!toolById.has(tool.id)) {
        const op: ToolOp = { id: tool.id, name: tool.name, inputJson: "", input: tool.input }
        toolGroup.push(op)
        toolById.set(tool.id, op)
      } else {
        // Update input if it was empty (streamed fully now)
        const op = toolById.get(tool.id)!
        if (op && Object.keys(op.input).length === 0) {
          op.input = tool.input
        }
      }
    }
  }
}

function renderUser(msg: SDKUserMessage) {
  const content = msg.message.content
  if (typeof content === "string") return

  let hasResults = false
  for (const block of (content as ContentBlock[])) {
    if (block.type === "tool_result") {
      const op = toolById.get(block.tool_use_id)
      if (op) {
        op.result = getToolResultText(block)
        op.isError = block.is_error
        hasResults = true
      }
    }
  }

  // After results arrive, check if all ops in the group are done
  if (hasResults) {
    const allDone = toolGroup.every(o => o.result !== undefined)
    if (allDone) {
      stopSpinner()
      flushToolGroup()
    }
  }
}

function renderToolProgress(msg: SDKToolProgressMessage) {
  // Only show for long-running non-collapsible tools
  const name = msg.tool_name
  if (!["Read", "Grep", "Glob"].includes(name)) {
    const elapsed = formatDuration(msg.elapsed_time_seconds * 1000)
    clearSpinnerLine()
    writeLine(C.dim(`${INDENT}${INDENT}↳ ${name} running... (${elapsed})`))
  }
}

function renderResult(msg: SDKResultMessage) {
  // Flush any remaining tools
  stopSpinner()
  if (toolGroup.length > 0) flushToolGroup()

  writeLine()

  if (msg.subtype === "success") {
    writeLine(C.success("● Done"))
  } else {
    writeLine(C.error(`● ${formatErrorSubtype(msg.subtype)}`))
    if ("errors" in msg && msg.errors) {
      for (const err of msg.errors) {
        writeLine(C.error(`  ${err}`))
      }
    }
  }

  const duration    = formatDuration(msg.duration_ms)
  const apiDuration = formatDuration(msg.duration_api_ms)
  const cost        = `$${msg.total_cost_usd.toFixed(4)}`

  // Token stats
  const usage = (msg as any).usage
  const input   = usage?.input_tokens ?? 0
  const output  = usage?.output_tokens ?? 0
  const cacheR  = usage?.cache_read_input_tokens ?? 0
  const cacheW  = usage?.cache_creation_input_tokens ?? 0

  const tokenParts: string[] = []
  tokenParts.push(`${formatTokenCount(input)} in`)
  tokenParts.push(`${formatTokenCount(output)} out`)
  if (cacheR > 0) tokenParts.push(`${formatTokenCount(cacheR)} cache read`)
  if (cacheW > 0) tokenParts.push(`${formatTokenCount(cacheW)} cache write`)

  writeLine(C.dim(`  ${duration} (API ${apiDuration}) · ${msg.num_turns} turns · ${cost}`))
  writeLine(C.dim(`  ${tokenParts.join(" · ")}`))
}

function renderControlRequest(msg: SDKControlRequestMessage) {
  if (msg.request.subtype === "can_use_tool") {
    const toolName = (msg.request as any).tool_name ?? "Tool"
    const input = (msg.request as any).input ?? {}
    clearSpinnerLine()
    writeLine(C.warning(`${INDENT}⚠ Permission: ${C.bold(toolName)} ${formatToolInput(toolName, input)}`))
  }
}

// ─── Formatting helpers ───

function toolDisplayName(name: string): string {
  const map: Record<string, string> = {
    Bash: "Bash", Read: "Read", Edit: "Edit", Write: "Write",
    Glob: "Search", Grep: "Search", Agent: "Agent", WebFetch: "Fetch",
  }
  return map[name] ?? name
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "")
      for (const line of cmd.split("\n")) {
        const t = line.trim()
        if (t.startsWith("# ")) return `(${t.slice(2).slice(0, 120)})`
      }
      return `(${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd})`
    }
    case "Read":  return `(${relativePath(String(input.file_path ?? ""))})`
    case "Edit": {
      const p = relativePath(String(input.file_path ?? ""))
      return input.old_string === "" ? `(creating ${p})` : `(${p})`
    }
    case "Write": return `(${relativePath(String(input.file_path ?? ""))})`
    case "Grep":
    case "Glob": {
      const pat = String(input.pattern ?? "")
      const loc = input.path ? ` in ${input.path}` : ""
      return `("${pat}"${loc})`
    }
    case "Agent": {
      const desc = String(input.description ?? input.prompt ?? "")
      return `(${desc.slice(0, 80)})`
    }
    default: {
      const keys = Object.keys(input)
      if (keys.length === 0) return ""
      const val = String(input[keys[0]])
      return `(${keys[0]}: ${val.slice(0, 80)})`
    }
  }
}

function summarizeResult(toolName: string, result: string, isError?: boolean): string {
  if (isError) return result.slice(0, 200)
  if (!result.trim()) return ""

  switch (toolName) {
    case "Read": {
      const lines = result.split("\n")
      const n = lines.length
      return `Read ${n} line${n > 1 ? "s" : ""}`
    }
    case "Grep":
    case "Glob": {
      const lines = result.trim().split("\n").filter(l => l.trim())
      if (!result.trim() || result.includes("No files found")) return "No files found"
      return `Found ${lines.length} file${lines.length > 1 ? "s" : ""}`
    }
    case "Bash": {
      const lines = result.trim().split("\n")
      if (!lines[0]?.trim()) return "(No output)"
      if (lines.length <= 2) return lines.join("\n")
      return `${lines.slice(0, 2).join("\n")}\n… +${lines.length - 2} lines`
    }
    case "Edit":  return "Updated file"
    case "Write": return "Wrote file"
    default:
      return result.length > 120 ? result.slice(0, 120) + "…" : result
  }
}

function getToolResultText(block: any): string {
  if (typeof block.content === "string") return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n")
  }
  return ""
}

function relativePath(p: string): string {
  const cwd = process.cwd() + "/"
  return p.startsWith(cwd) ? p.slice(cwd.length) : p
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatErrorSubtype(subtype: string): string {
  const map: Record<string, string> = {
    error_during_execution: "Execution error",
    error_max_turns: "Max turns reached",
    error_max_budget_usd: "Budget exceeded",
    error_max_structured_output_retries: "Structured output retries exceeded",
  }
  return map[subtype] ?? subtype
}
