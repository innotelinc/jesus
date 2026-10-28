export type SectionKey =
  | 'identity'
  | 'voice'
  | 'principles'
  | 'boundaries'
  | 'rules'
  | 'style'
  | 'capabilities'
  | 'notes'

export interface Voice {
  warmth: number
  directness: number
  verbosity: number
  humor: number
}

export type ResponseLength = 'concise' | 'balanced' | 'detailed'

export interface FormatRules {
  length: ResponseLength
  markdown: boolean
  language: string
  banned: string[]
}

export interface ModelSettings {
  temperature: number
  maxTokens: number
}

export interface Soul {
  id: string
  name: string
  role: string
  mission: string
  audience: string
  voice: Voice
  principles: string[]
  boundaries: string[]
  rules: string[]
  format: FormatRules
  capabilities: string
  notes: string
  sections: Record<SectionKey, boolean>
  /** When set, the system prompt is edited by hand instead of compiled. */
  promptOverride: string | null
  model: ModelSettings
  history: Snapshot[]
  createdAt: number
  updatedAt: number
}

export interface Snapshot {
  id: string
  createdAt: number
  label: string
  prompt: string
  soul: Omit<Soul, 'history'>
}

export interface Library {
  version: 1
  souls: Soul[]
  selectedId: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}
