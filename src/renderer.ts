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
import { stripAnsi } from "./utils.js"
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultSuccessMessage,
  SDKStreamEventMessage,
  SDKToolProgressMessage,
  SDKSystemMessage,
  SDKSystemInitMessage,
  SDKSystemStatusMessage,
  SDKSystemTaskStartedMessage,
  SDKSystemTaskNotificationMessage,
  SDKControlRequestMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  MessageDeltaEvent,
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

/** Tools that collapse into a summary when multiple appear in one group. */
const COLLAPSIBLE_TOOLS = new Set(["Read", "Grep", "Glob"])


// ─── State ───

interface ToolOp {
  id: string
  name: string
  inputJson: string   // accumulated from input_json_delta
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

type SpinnerMode = "thinking" | "talking" | "tool-input" | "tool-use"

let toolGroup: ToolOp[] = []
let toolById = new Map<string, ToolOp>()
let activeToolId = ""
let textStarted = false
let textLineBuf = ""
let spinnerActive = false
let turnStartMs = 0
let outputTokens = 0
let spinnerTimer: ReturnType<typeof setInterval> | null = null
let spinnerMode: SpinnerMode = "thinking"
let spinnerToolName = ""

export function resetState() {
  toolGroup = []
  toolById.clear()
  activeToolId = ""
  textStarted = false
  textLineBuf = ""
  spinnerActive = false
  turnStartMs = 0
  outputTokens = 0
  spinFrame = 0
  spinnerMode = "thinking"
  spinnerToolName = ""
  stopSpinner()
}

// ─── Spinner ───

function startSpinner(mode: SpinnerMode = "thinking", toolName = "") {
  spinnerMode = mode
  spinnerToolName = toolName
  if (spinnerTimer) return
  turnStartMs = Date.now()
  outputTokens = 0
  spinnerTimer = setInterval(drawSpinner, 100)
  drawSpinner()
}

function updateSpinnerMode(mode: SpinnerMode, toolName = "") {
  if (spinnerMode === mode && spinnerToolName === toolName && spinnerTimer) return
  spinnerMode = mode
  spinnerToolName = toolName
  if (spinnerTimer) {
    drawSpinner()
  } else {
    startSpinner(mode, toolName)
  }
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

  let label: string
  switch (spinnerMode) {
    case "thinking":
      label = "thinking"
      break
    case "talking":
      label = "talking"
      break
    case "tool-input":
      label = spinnerToolName ? `${spinnerToolName}` : "tool input"
      break
    case "tool-use":
      label = spinnerToolName ? `Running ${spinnerToolName}` : "running tools"
      break
  }

  const line = C.dim(`${frame} ${label} · ${elapsed}s${tokens}`)
  process.stderr.write(`\r\x1b[2K${line}\r`)
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
  if (spinnerActive) clearSpinnerLine()
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
  const counts = new Map<string, number>()

  for (const op of toolGroup) {
    if (COLLAPSIBLE_TOOLS.has(op.name)) {
      collapsible.push(op)
      counts.set(op.name, (counts.get(op.name) ?? 0) + 1)
    } else {
      individual.push(op)
    }
  }

  // Render Bash and other tools individually (always visible)
  for (const op of individual) {
    renderSingleToolOp(op)
  }

  // Collapse Read/Grep/Glob when more than one
  if (collapsible.length > 1) {
    const parts: string[] = []
    const searches = counts.get("Grep") ?? 0
    const reads    = counts.get("Read") ?? 0
    const lists    = counts.get("Glob") ?? 0
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
  writeLine(`${dotColor(DOT)} ${namePart}${detailPart}`)

  if (op.result !== undefined) {
    const summary = summarizeResult(op.name, op.result, op.isError)
    if (summary) {
      for (const line of summary.split("\n")) {
        writeLine(C.dim(`${INDENT}⎿  ${line}`))
      }
    }
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
      const initMsg = msg as SDKSystemInitMessage
      const model = stripAnsi(initMsg.model ?? "unknown")
      writeLine(C.dim(`Model: ${model}  Session: ${initMsg.session_id}`))
      break
    }
    case "status":
      if ((msg as SDKSystemStatusMessage).status === "compacting") {
        writeLine(C.dim(`${INDENT}Compacting context...`))
      }
      break
    case "task_started": {
      const tsMsg = msg as SDKSystemTaskStartedMessage
      writeLine(C.dim(`${INDENT}◷ Task: ${tsMsg.description?.slice(0, 80) ?? "..."}`))
      break
    }
    case "task_notification": {
      const tn = msg as SDKSystemTaskNotificationMessage
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
      // Defensive: flush stale toolGroup from a previous interrupted turn
      if (toolGroup.length > 0) flushToolGroup()
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
        updateSpinnerMode("tool-input", toolDisplayName(tool.name))
      } else if (block.type === "text") {
        // Text starting — switch to talking spinner, flush accumulated tool group from prev turn
        updateSpinnerMode("talking")
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
        updateSpinnerMode("talking")
        textLineBuf += delta.text
        flushTextParagraphs()
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
      const deltaEvent = event as MessageDeltaEvent
      if (deltaEvent.usage?.output_tokens) {
        outputTokens = deltaEvent.usage.output_tokens
      }
      break
    }

    case "message_stop": {
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
      // If tools are pending execution, switch spinner to "tool-use" mode
      const pendingTools = toolGroup.filter(o => o.result === undefined)
      if (pendingTools.length > 0) {
        const names = [...new Set(pendingTools.map(o => toolDisplayName(o.name)))]
        updateSpinnerMode("tool-use", names.join(", "))
      } else {
        stopSpinner()
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
  if (!COLLAPSIBLE_TOOLS.has(name)) {
    const elapsed = formatDuration(msg.elapsed_time_seconds * 1000)
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

  const usage = msg.subtype === "success" ? (msg as SDKResultSuccessMessage).usage : undefined
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
  writeLine(C.dim(`  Session: ${msg.session_id}`))
}

function renderControlRequest(msg: SDKControlRequestMessage) {
  if (msg.request.subtype === "can_use_tool") {
    const toolName = String(msg.request.tool_name ?? "Tool")
    const input = (msg.request.input ?? {}) as Record<string, unknown>
    writeLine(C.warning(`${INDENT}⚠ Permission: ${C.bold(toolName)} ${formatToolInput(toolName, input)}`))
  }
}

// ─── Formatting helpers ───

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Bash: "Bash", Read: "Read", Edit: "Edit", Write: "Write",
  Glob: "Search", Grep: "Search", Agent: "Agent", WebFetch: "Fetch",
  TodoWrite: "Todo", TaskCreate: "Task", TaskUpdate: "Task",
  TaskList: "Task", TaskGet: "Task",
}

function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name
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
    case "Read":
    case "Write": {
      const fp = relativePath(String(input.file_path ?? ""))
      return `(${fp})`
    }
    case "Edit": {
      const fp = relativePath(String(input.file_path ?? ""))
      return input.old_string === "" ? `(creating ${fp})` : `(${fp})`
    }
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
    case "TodoWrite": {
      const todos = input.todos
      if (!Array.isArray(todos) || todos.length === 0) return ""
      const summary = todos.map((t: Record<string, unknown>) => {
        const status = t.status === "completed" ? "✓" : t.status === "in_progress" ? "⧖" : "○"
        const content = String(t.content ?? "").slice(0, 40)
        return `${status} ${content}`
      })
      return `(${todos.length} items: ${summary.join(", ").slice(0, 120)})`
    }
    case "TaskCreate": {
      const subject = String(input.subject ?? "")
      return `(${subject.slice(0, 80)})`
    }
    case "TaskUpdate": {
      const id = String(input.taskId ?? "")
      const status = input.status ? ` → ${input.status}` : ""
      return `(#${id}${status})`
    }
    default: {
      const keys = Object.keys(input)
      if (keys.length === 0) return ""
      const v = input[keys[0]]
      const val = (typeof v === "object" && v !== null) ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)
      return `(${keys[0]}: ${val})`
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

function getToolResultText(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n")
  }
  return ""
}

const cachedCwd = process.cwd() + "/"

function relativePath(p: string): string {
  return p.startsWith(cachedCwd) ? p.slice(cachedCwd.length) : p
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
