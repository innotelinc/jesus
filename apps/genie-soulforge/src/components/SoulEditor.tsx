import { useState, type ReactNode } from 'react'
import type { Soul, Voice } from '../types'
import { clamp, LENGTH_COPY, VOICE_META, voiceDescriptor } from '../lib/soul'
import { Icon } from './Icons'

type Updater = (soul: Soul) => Soul

function Card({
  title,
  hint,
  children,
  action,
}: {
  title: string
  hint: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <p>{hint}</p>
        </div>
        {action}
      </div>
      <div className="card-body">{children}</div>
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

function ListEditor({
  items,
  onChange,
  placeholder,
  addLabel,
}: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
  addLabel: string
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (!value) return
    onChange([...items, value])
    setDraft('')
  }

  return (
    <div className="list-editor">
      {items.length > 0 ? (
        <ul className="list-items">
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>
              <span>{item}</span>
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <Icon name="close" size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="list-add">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          aria-label={placeholder}
        />
        <button type="button" className="btn ghost sm" onClick={add} disabled={!draft.trim()}>
          <Icon name="plus" size={14} /> {addLabel}
        </button>
      </div>
    </div>
  )
}

function Dial({
  voiceKey,
  label,
  low,
  high,
  value,
  onChange,
}: {
  voiceKey: keyof Voice
  label: string
  low: string
  high: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="dial">
      <div className="dial-head">
        <span className="field-label">{label}</span>
        <span className="dial-value">{value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="dial-scale">
        <span>{low}</span>
        <span>{high}</span>
      </div>
      <p className="dial-desc">{voiceDescriptor(voiceKey, value)}</p>
    </div>
  )
}

export function SoulEditor({
  soul,
  onChange,
}: {
  soul: Soul
  onChange: (updater: Updater) => void
}) {
  const patch = (value: Partial<Soul>) => onChange((current) => ({ ...current, ...value }))
  const setVoice = (key: keyof Voice, value: number) =>
    onChange((current) => ({
      ...current,
      voice: { ...current.voice, [key]: clamp(value) },
    }))
  const setFormat = (value: Partial<Soul['format']>) =>
    onChange((current) => ({ ...current, format: { ...current.format, ...value } }))
  const setModel = (value: Partial<Soul['model']>) =>
    onChange((current) => ({ ...current, model: { ...current.model, ...value } }))

  return (
    <div className="editor-scroll">
      <div className="editor-intro">
        <h2>The soul</h2>
        <p>
          The character behind the prompt. Describe who this agent is; the system prompt is written
          from these fields.
        </p>
      </div>

      <Card title="Identity" hint="Who the agent is and what it is here to do.">
        <div className="field-grid">
          <Field label="Name">
            <input
              value={soul.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="Atlas"
              spellCheck={false}
            />
          </Field>
          <Field label="Role">
            <input
              value={soul.role}
              onChange={(event) => patch({ role: event.target.value })}
              placeholder="research analyst"
            />
          </Field>
        </div>
        <Field label="Mission" hint="One or two sentences. What is this agent for?">
          <textarea
            rows={2}
            value={soul.mission}
            onChange={(event) => patch({ mission: event.target.value })}
            placeholder="Turn messy questions into decisions people can act on."
          />
        </Field>
        <Field label="Who it talks to" hint="Audience shapes vocabulary, assumptions, and depth.">
          <input
            value={soul.audience}
            onChange={(event) => patch({ audience: event.target.value })}
            placeholder="product leads who need a defensible answer quickly"
          />
        </Field>
      </Card>

      <Card title="Voice" hint="Set the dials; the compiler turns them into tone instructions.">
        <div className="dial-grid">
          {VOICE_META.map((meta) => (
            <Dial
              key={meta.key}
              voiceKey={meta.key}
              label={meta.label}
              low={meta.low}
              high={meta.high}
              value={soul.voice[meta.key]}
              onChange={(value) => setVoice(meta.key, value)}
            />
          ))}
        </div>
      </Card>

      <Card title="Principles" hint="What the agent optimizes for when trade-offs appear.">
        <ListEditor
          items={soul.principles}
          onChange={(principles) => patch({ principles })}
          placeholder="Lead with evidence, not narrative"
          addLabel="Add"
        />
      </Card>

      <Card title="Boundaries" hint="Hard limits. These survive direct requests to break them.">
        <ListEditor
          items={soul.boundaries}
          onChange={(boundaries) => patch({ boundaries })}
          placeholder="Never invent sources or citations"
          addLabel="Add"
        />
      </Card>

      <Card title="Operating rules" hint="Habits and procedures the agent should follow every time.">
        <ListEditor
          items={soul.rules}
          onChange={(rules) => patch({ rules })}
          placeholder="Open with the answer, then support it"
          addLabel="Add"
        />
      </Card>

      <Card title="Response style" hint="Shape of the output, not the personality.">
        <div className="field">
          <span className="field-label">Default length</span>
          <div className="segmented" role="group" aria-label="Default response length">
            {(['concise', 'balanced', 'detailed'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={soul.format.length === option ? 'is-on' : ''}
                aria-pressed={soul.format.length === option}
                onClick={() => setFormat({ length: option })}
              >
                {option}
              </button>
            ))}
          </div>
          <span className="field-hint">{LENGTH_COPY[soul.format.length]}</span>
        </div>
        <div className="field-grid">
          <Field label="Language">
            <input
              value={soul.format.language}
              onChange={(event) => setFormat({ language: event.target.value })}
              placeholder="English"
            />
          </Field>
          <div className="field">
            <span className="field-label">Formatting</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={soul.format.markdown}
                onChange={(event) => setFormat({ markdown: event.target.checked })}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
              <span className="switch-text">Use Markdown in replies</span>
            </label>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Banned words and phrases</span>
          <ListEditor
            items={soul.format.banned}
            onChange={(banned) => setFormat({ banned })}
            placeholder="delve"
            addLabel="Ban"
          />
        </div>
      </Card>

      <Card title="Capabilities" hint="What the agent can actually do, and what it must not claim.">
        <textarea
          rows={3}
          value={soul.capabilities}
          onChange={(event) => patch({ capabilities: event.target.value })}
          placeholder="You can read supplied documents. You cannot browse, run code, or send email."
        />
      </Card>

      <Card title="Additional context" hint="Anything else the prompt should know about this agent.">
        <textarea
          rows={3}
          value={soul.notes}
          onChange={(event) => patch({ notes: event.target.value })}
          placeholder="House style, domain vocabulary, recurring edge cases…"
        />
      </Card>

      <Card title="Model behavior" hint="Applied by the playground on every request.">
        <div className="field-grid">
          <Field label={`Temperature — ${soul.model.temperature.toFixed(2)}`} hint="Lower is steadier; higher is more varied.">
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={soul.model.temperature}
              onChange={(event) => setModel({ temperature: Number(event.target.value) })}
            />
          </Field>
          <Field label="Max tokens" hint="Ceiling for each reply.">
            <input
              type="number"
              min={64}
              max={32000}
              step={1}
              value={soul.model.maxTokens}
              onChange={(event) => {
                const next = Number(event.target.value)
                setModel({ maxTokens: Number.isFinite(next) ? clamp(next, 64, 32000) : 1024 })
              }}
            />
          </Field>
        </div>
      </Card>
    </div>
  )
}
