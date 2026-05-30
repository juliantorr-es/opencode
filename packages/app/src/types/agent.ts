export type AgentDef = {
  id: string
  name: string
  prompt: string
  description?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  color?: string
  steps?: number
}
