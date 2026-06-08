import type { Component } from "solid-js"
import type {
  AgentPart,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@tribunus/sdk/v2"
import type { IconProps } from "../icon"

export interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  actions?: UserActions
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }

export type HighlightSegment = { text: string; type?: "file" | "agent" }

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

export const emptyInput: Record<string, any> = {}
export const emptyMetadata: Record<string, any> = {}
export const emptyParts: PartType[] = []
export const emptyTools: ToolPart[] = []

export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
export const HIDDEN_TOOLS = new Set(["todowrite"])
