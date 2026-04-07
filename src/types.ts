/**
 * Stream-JSON message type definitions for Claude Code SDK protocol.
 * Based on the NDJSON output of `claude -p --output-format stream-json --verbose`.
 */

// ─── Anthropic SDK content blocks ───

export interface TextBlock {
  type: "text"
  text: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | ToolResultBlock

// ─── Anthropic SDK stream events ───

export interface MessageStartEvent {
  type: "message_start"
  message: {
    id: string
    model: string
    role: "assistant"
    content: ContentBlock[]
  }
}

export interface ContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block: ContentBlock
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta: {
    type: "text_delta" | "thinking_delta" | "input_json_delta"
    text?: string
    thinking?: string
    partial_json?: string
  }
}

export interface ContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface MessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason: string | null
    stop_sequence: string | null
  }
  usage: {
    output_tokens: number
  }
}

export interface MessageStopEvent {
  type: "message_stop"
}

export type RawStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent

// ─── SDK message types (NDJSON lines) ───

export interface SDKAssistantMessage {
  type: "assistant"
  message: {
    id: string
    role: "assistant"
    model: string
    content: ContentBlock[]
    stop_reason: string | null
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  uuid: string
  session_id: string
  parent_tool_use_id: string | null
}

export interface SDKUserMessage {
  type: "user"
  message: {
    role: "user"
    content: string | ContentBlock[]
  }
  uuid: string
  session_id: string
  parent_tool_use_id: string | null
}

export interface SDKResultSuccessMessage {
  type: "result"
  subtype: "success"
  duration_ms: number
  duration_api_ms: number
  is_error: false
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  uuid: string
  session_id: string
}

export interface SDKResultErrorMessage {
  type: "result"
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries"
  duration_ms: number
  duration_api_ms: number
  is_error: true
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  errors: string[]
  uuid: string
  session_id: string
}

export type SDKResultMessage = SDKResultSuccessMessage | SDKResultErrorMessage

export interface SDKStreamEventMessage {
  type: "stream_event"
  event: RawStreamEvent
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export interface SDKToolProgressMessage {
  type: "tool_progress"
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  uuid: string
  session_id: string
}

export interface SDKSystemInitMessage {
  type: "system"
  subtype: "init"
  tools: Array<{ name: string }>
  model: string
  permission_mode: string
  session_id: string
  uuid: string
}

export interface SDKSystemStatusMessage {
  type: "system"
  subtype: "status"
  status: "compacting" | null
  uuid: string
  session_id: string
}

export interface SDKSystemSessionStateMessage {
  type: "system"
  subtype: "session_state_changed"
  state: "idle" | "running" | "requires_action"
  uuid: string
  session_id: string
}

export interface SDKSystemTaskStartedMessage {
  type: "system"
  subtype: "task_started"
  task_id: string
  description: string
  uuid: string
  session_id: string
}

export interface SDKSystemTaskProgressMessage {
  type: "system"
  subtype: "task_progress"
  task_id: string
  summary?: string
  uuid: string
  session_id: string
}

export interface SDKSystemTaskNotificationMessage {
  type: "system"
  subtype: "task_notification"
  task_id: string
  status: string
  summary?: string
  uuid: string
  session_id: string
}

export type SDKSystemMessage =
  | SDKSystemInitMessage
  | SDKSystemStatusMessage
  | SDKSystemSessionStateMessage
  | SDKSystemTaskStartedMessage
  | SDKSystemTaskProgressMessage
  | SDKSystemTaskNotificationMessage

export interface SDKControlRequestMessage {
  type: "control_request"
  request_id: string
  request: {
    subtype: string
    [key: string]: unknown
  }
}

export interface SDKControlResponseMessage {
  type: "control_response"
  response: {
    subtype: "success" | "error"
    request_id: string
    response?: Record<string, unknown>
    error?: string
  }
}

export interface SDKKeepAliveMessage {
  type: "keep_alive"
}

// Union of all possible stdout messages
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKStreamEventMessage
  | SDKToolProgressMessage
  | SDKSystemMessage
  | SDKControlRequestMessage
  | SDKControlResponseMessage
  | SDKKeepAliveMessage
