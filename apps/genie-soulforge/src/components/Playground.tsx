import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, Soul } from '../types'
import { buildTurns, endpointFor, friendlyError, streamChat, type LlmSettings } from '../lib/llm'
import { estimateTokens, uid } from '../lib/soul'
import { Icon } from './Icons'
import { Markdownish } from './Markdownish'

const SUGGESTIONS = [
  'Introduce yourself in two sentences.',
  'What are you best at, and what should I not ask you?',
  'Show me what a typical reply from you looks like.',
]

export function Playground({
  soul,
  systemPrompt,
  settings,
  onOpenSettings,
}: {
  soul: Soul
  systemPrompt: string
  settings: LlmSettings
  onOpenSettings: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  const ready = Boolean(
    settings.apiKey.trim() && settings.model.trim() && settings.baseUrl.trim(),
  )
  const tokens = estimateTokens(systemPrompt)
  const initial = (soul.name.trim()[0] ?? '?').toUpperCase()

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [messages, streaming])

  useEffect(() => () => abortRef.current?.abort(), [])

  async function send(raw: string) {
    const content = raw.trim()
    if (!content || streaming || !ready) return

    const userMessage: ChatMessage = { id: uid('msg'), role: 'user', content }
    const assistantId = uid('msg')
    const history = [...messages, userMessage]
    setMessages([...history, { id: assistantId, role: 'assistant', content: '' }])
    setInput('')
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      let accumulated = ''
      const turns = buildTurns(
        systemPrompt,
        history.filter((message) => !message.error),
      )
      const stream = streamChat({
        endpoint: endpointFor(settings.baseUrl),
        apiKey: settings.apiKey,
        model: settings.model,
        messages: turns,
        temperature: soul.model.temperature,
        maxTokens: soul.model.maxTokens,
        signal: controller.signal,
      })

      for await (const delta of stream) {
        accumulated += delta
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId ? { ...message, content: accumulated } : message,
          ),
        )
      }

      if (!accumulated.trim()) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, content: 'The model returned an empty reply.', error: true }
              : message,
          ),
        )
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      if (aborted) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId && !message.content
              ? { ...message, content: 'Stopped before any text arrived.' }
              : message,
          ),
        )
      } else {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, content: friendlyError(error), error: true }
              : message,
          ),
        )
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function reset() {
    abortRef.current?.abort()
    setMessages([])
    setInput('')
  }

  return (
    <div className="playground">
      <div className="pane-head">
        <div>
          <h2>Playground</h2>
          <p>
            Talk to {soul.name || 'this soul'} through the system prompt as it stands right now.
          </p>
        </div>
        <div className="pane-actions">
          <button type="button" className="btn ghost sm model-btn" onClick={onOpenSettings}>
            <Icon name="sliders" size={14} />
            <span>{settings.model.trim() || 'Choose a model'}</span>
          </button>
          {messages.length > 0 ? (
            <button type="button" className="btn ghost sm" onClick={reset}>
              <Icon name="refresh" size={14} /> Reset
            </button>
          ) : null}
        </div>
      </div>

      {!ready ? (
        <div className="setup-note">
          <div>
            <strong>Connect a model to test this soul</strong>
            <span>Add an OpenAI-compatible API key and model in settings. The key stays in this browser.</span>
          </div>
          <button type="button" className="btn primary sm" onClick={onOpenSettings}>
            Open settings
          </button>
        </div>
      ) : null}

      <details className="sys-details">
        <summary>
          <span>System prompt in effect</span>
          <span className="pill">≈ {tokens.toLocaleString()} tokens</span>
          <Icon name="chevron" size={14} className="summary-chevron" />
        </summary>
        <pre>{systemPrompt || 'No system prompt yet.'}</pre>
      </details>

      <div className="chat" ref={scrollerRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <span className="chat-sigil">
              <Icon name="spark" size={22} />
            </span>
            <h3>Try {soul.name || 'this soul'}</h3>
            <p>
              Replies use the compiled prompt{soul.promptOverride !== null ? ' (with your manual edits)' : ''}.
              Nothing is stored; the conversation disappears when you switch souls.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  disabled={!ready}
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) => {
            const last = index === messages.length - 1
            if (message.role === 'user') {
              return (
                <div className="msg user" key={message.id}>
                  <div className="bubble">{message.content}</div>
                </div>
              )
            }
            return (
              <div className={`msg assistant${message.error ? ' is-error' : ''}`} key={message.id}>
                <span className="msg-avatar">{initial}</span>
                <div className="bubble">
                  {message.content ? (
                    <Markdownish text={message.content} />
                  ) : (
                    <span className="typing" aria-label="Waiting for the model">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {streaming && last && message.content ? <span className="caret" /> : null}
                </div>
              </div>
            )
          })
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send(input)
        }}
      >
        <textarea
          rows={2}
          value={input}
          placeholder={ready ? `Message ${soul.name || 'the agent'}…` : 'Add an API key in settings first'}
          aria-label="Message"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send(input)
            }
          }}
        />
        {streaming ? (
          <button type="button" className="btn stop" onClick={stop}>
            <Icon name="stop" size={14} /> Stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!input.trim() || !ready}>
            <Icon name="send" size={14} /> Send
          </button>
        )}
      </form>
      <p className="composer-hint">
        Enter to send · Shift+Enter for a new line · temperature {soul.model.temperature.toFixed(2)} ·
        max {soul.model.maxTokens.toLocaleString()} tokens
      </p>
    </div>
  )
}
