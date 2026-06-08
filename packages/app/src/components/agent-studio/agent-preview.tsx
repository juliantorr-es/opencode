import { Button } from "@tribunus/ui/button"
import { Icon } from "@tribunus/ui/icon"
import { createSignal, type ComponentProps, Show, splitProps } from "solid-js"
import type { AgentStudioConfig } from "./types"
import { ROLE_COLORS } from "./types"

export interface AgentPreviewProps {
  agent: AgentStudioConfig
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const MOCK_MESSAGES = [
  { role: "user" as const, content: "Write a function to calculate fibonacci numbers" },
  { role: "agent" as const, content: "I'll create an efficient fibonacci function with memoization." },
  { role: "tool" as const, content: "Reading fibonacci.ts... found existing implementation skeleton" },
]

export function AgentPreview(raw: AgentPreviewProps) {
  const [props, rest] = splitProps(raw, ["agent", "class", "classList"])
  const [input, setInput] = createSignal("")
  const [thinking, setThinking] = createSignal(false)

  const roleColor = () => ROLE_COLORS[props.agent.role] ?? ROLE_COLORS.custom

  const handleSend = () => {
    if (!input().trim() || thinking()) return
    setThinking(true)
    // Simulate a response after a short delay
    setTimeout(() => {
      setThinking(false)
    }, 1500)
    setInput("")
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div
      {...rest}
      data-component="agent-studio-preview"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
    >
      {/* Header */}
      <div data-slot="preview-header">
        <div data-slot="preview-agent-info">
          <div
            data-slot="preview-dot"
            style={{ "background-color": roleColor() }}
          />
          <span data-slot="preview-agent-name">{props.agent.name}</span>
          <span data-slot="preview-status" data-ready>Ready</span>
        </div>
        <div data-slot="preview-model-badge">
          {props.agent.model || "No model"}
        </div>
      </div>

      {/* Chat area */}
      <div data-slot="preview-chat">
        {MOCK_MESSAGES.map((msg, i) => (
          <div data-slot="preview-message" data-role={msg.role}>
            <div data-slot="preview-message-avatar">
              {msg.role === "user" ? (
                <Icon name="bubble-5" size="small" />
              ) : msg.role === "agent" ? (
                <div
                  data-slot="preview-avatar-dot"
                  style={{ "background-color": roleColor() }}
                />
              ) : (
                <Icon name="terminal" size="small" />
              )}
            </div>
            <div data-slot="preview-message-content">
              <span data-slot="preview-message-label">
                {msg.role === "user" ? "User" : msg.role === "agent" ? props.agent.name : "Tool Call"}
              </span>
              {msg.role === "tool" ? (
                <code data-slot="preview-code">{msg.content}</code>
              ) : (
                <p data-slot="preview-text">{msg.content}</p>
              )}
            </div>
          </div>
        ))}

        {/* Thinking indicator */}
        <Show when={thinking()}>
          <div data-slot="preview-message" data-role="agent">
            <div data-slot="preview-message-avatar">
              <div
                data-slot="preview-avatar-dot"
                style={{ "background-color": roleColor() }}
              />
            </div>
            <div data-slot="preview-message-content">
              <span data-slot="preview-message-label">{props.agent.name}</span>
              <div data-slot="preview-thinking">
                <span data-slot="thinking-dot" />
                <span data-slot="thinking-dot" />
                <span data-slot="thinking-dot" />
              </div>
            </div>
          </div>
        </Show>
      </div>

      {/* Input area */}
      <div data-slot="preview-input-area">
        <input
          type="text"
          data-slot="preview-input"
          placeholder="Try it out — type a message..."
          value={input()}
          onInput={(e: Event) => setInput((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          variant="primary"
          size="small"
          icon="arrow-up"
          onClick={handleSend}
          disabled={!input().trim() || thinking()}
          aria-label="Send"
        />
      </div>
    </div>
  )
}
