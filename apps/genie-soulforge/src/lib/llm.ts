import type { ChatMessage } from '../types'

export type ProviderPreset = 'openrouter' | 'omniroute' | 'openai' | 'custom'

export interface LlmSettings {
  preset: ProviderPreset
  baseUrl: string
  apiKey: string
  model: string
}

export const PROVIDERS: Record<
  ProviderPreset,
  { label: string; blurb: string; baseUrl: string; model: string; keyHint: string }
> = {
  openrouter: {
    label: 'OpenRouter',
    blurb: 'One key, many models. Browser requests work through the Soulforge proxy.',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyHint: 'sk-or-v1-…',
  },
  omniroute: {
    label: 'OmniRoute',
    blurb: 'Innotel OmniRoute gateway — many upstream models behind one key. Proxied by Soulforge.',
    baseUrl: 'https://gateway.innotel.us/v1',
    model: 'auto/best-chat',
    keyHint: 'sk-…',
  },
  openai: {
    label: 'OpenAI',
    blurb: 'Proxied by Soulforge so the browser can reach the API.',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'sk-…',
  },
  custom: {
    label: 'Custom',
    blurb: 'Any OpenAI-compatible /chat/completions endpoint.',
    baseUrl: '',
    model: '',
    keyHint: 'API key',
  },
}

export const MODEL_SUGGESTIONS = [
  'auto/best-chat',
  'auto/best-coding',
  'auto/best-reasoning',
  'auto/fast',
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
]

export function defaultSettings(): LlmSettings {
  return {
    preset: 'omniroute',
    baseUrl: PROVIDERS.omniroute.baseUrl,
    apiKey: '',
    model: PROVIDERS.omniroute.model,
  }
}

/** Maps known providers onto the dev proxy paths declared in vite.config.ts. */
export function endpointFor(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (!clean) return ''
  if (clean.includes('gateway.innotel.us')) return '/llm/omniroute/chat/completions'
  if (clean.includes('openrouter.ai')) return '/llm/openrouter/chat/completions'
  if (clean.includes('api.openai.com')) return '/llm/openai/chat/completions'
  if (/\/chat\/completions$/.test(clean)) return clean
  return `${clean}/chat/completions`
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function buildTurns(
  systemPrompt: string,
  messages: Pick<ChatMessage, 'role' | 'content'>[],
): ChatTurn[] {
  const turns: ChatTurn[] = []
  if (systemPrompt.trim()) turns.push({ role: 'system', content: systemPrompt })
  for (const message of messages) turns.push({ role: message.role, content: message.content })
  return turns
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractDelta(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return ''
  const choice = payload.choices[0]
  if (!isRecord(choice) || !isRecord(choice.delta)) return ''
  const content = choice.delta.content
  return typeof content === 'string' ? content : ''
}

async function providerError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        detail = parsed.error.message
      } else if (isRecord(parsed) && typeof parsed.message === 'string') {
        detail = parsed.message
      } else {
        detail = text
      }
    } catch {
      detail = text
    }
  } catch {
    // Body already consumed or unavailable; status alone is still useful.
  }

  const hint =
    response.status === 401 || response.status === 403
      ? ' Check the API key in Settings.'
      : response.status === 429
        ? ' The provider is rate limiting — wait a moment and retry.'
        : ''
  const status = `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''})`
  const cleanDetail = detail.trim().replace(/[.\s]+$/, '').slice(0, 400)
  return new Error(`${status}${cleanDetail ? `: ${cleanDetail}` : ''}.${hint}`)
}

export interface StreamOptions {
  endpoint: string
  apiKey: string
  model: string
  messages: ChatTurn[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** Yields text deltas from an OpenAI-compatible streaming chat completion. */
export async function* streamChat(options: StreamOptions): AsyncGenerator<string, void, unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Title': 'Soulforge',
  }
  if (options.apiKey.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`

  const response = await fetch(options.endpoint, {
    method: 'POST',
    headers,
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    }),
  })

  if (!response.ok) throw await providerError(response)
  if (!response.body) throw new Error('The provider returned an empty response body.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        if (isRecord(parsed) && isRecord(parsed.error)) {
          throw new Error(
            typeof parsed.error.message === 'string'
              ? parsed.error.message
              : 'The provider returned an error mid-stream.',
          )
        }

        const delta = extractDelta(parsed)
        if (delta) yield delta
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Stopped.'
  if (error instanceof TypeError) {
    return 'Could not reach the endpoint. Check the base URL and connection — some providers block direct browser requests (CORS).'
  }
  return error instanceof Error ? error.message : 'Something went wrong while contacting the model.'
}
