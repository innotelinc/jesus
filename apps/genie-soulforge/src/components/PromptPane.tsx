import type { SectionKey, Soul } from '../types'
import {
  buildSections,
  compilePrompt,
  estimateTokens,
  SECTION_LABELS,
  SECTION_ORDER,
  soulPrompt,
  wordCount,
} from '../lib/soul'
import { Icon } from './Icons'

export function PromptPane({
  soul,
  onChange,
  onCopy,
  onDownload,
}: {
  soul: Soul
  onChange: (updater: (soul: Soul) => Soul) => void
  onCopy: () => void
  onDownload: () => void
}) {
  const compiled = compilePrompt(soul)
  const prompt = soulPrompt(soul)
  const sections = buildSections(soul)
  const tokens = estimateTokens(prompt)
  const words = wordCount(prompt)
  const included = SECTION_ORDER.filter((key) => soul.sections[key] && sections[key]).length
  const isOverride = soul.promptOverride !== null

  const toggleSection = (key: SectionKey) =>
    onChange((current) => ({
      ...current,
      sections: { ...current.sections, [key]: !current.sections[key] },
    }))

  return (
    <div className="prompt-pane">
      <div className="pane-head">
        <div>
          <h2>System prompt</h2>
          <p>
            {isOverride ? 'Hand-edited — detached from the soul' : 'Compiled live from the soul'} ·{' '}
            {tokens.toLocaleString()} tokens
          </p>
        </div>
        <div className="pane-actions">
          <button type="button" className="btn ghost sm" onClick={onCopy}>
            <Icon name="copy" size={14} /> Copy
          </button>
          <button type="button" className="btn ghost sm" onClick={onDownload}>
            <Icon name="file" size={14} /> .md
          </button>
        </div>
      </div>

      <div className="section-chips" role="group" aria-label="Prompt sections">
        {SECTION_ORDER.map((key) => {
          const hasContent = Boolean(sections[key])
          const on = soul.sections[key]
          return (
            <button
              key={key}
              type="button"
              className={`chip${on && hasContent ? ' is-on' : ''}${!hasContent ? ' is-empty' : ''}`}
              aria-pressed={on}
              disabled={!hasContent}
              title={hasContent ? `Toggle ${SECTION_LABELS[key]}` : 'This section is empty'}
              onClick={() => toggleSection(key)}
            >
              {SECTION_LABELS[key]}
            </button>
          )
        })}
      </div>

      {isOverride ? (
        <div className="banner">
          <div>
            <strong>Manual edits</strong>
            <span>This prompt will not change when you edit the soul.</span>
          </div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onChange((current) => ({ ...current, promptOverride: null }))}
          >
            <Icon name="refresh" size={14} /> Regenerate
          </button>
        </div>
      ) : null}

      <textarea
        className="prompt-editor"
        value={prompt}
        spellCheck={false}
        aria-label="System prompt"
        onChange={(event) =>
          onChange((current) => ({ ...current, promptOverride: event.target.value }))
        }
      />

      <div className="prompt-foot">
        <span>{words.toLocaleString()} words</span>
        <span>≈ {tokens.toLocaleString()} tokens</span>
        <span>{prompt.length.toLocaleString()} chars</span>
        <span className="spacer" />
        <span>
          {included} of {SECTION_ORDER.length} sections
        </span>
      </div>

      {compiled !== prompt ? (
        <p className="pane-note">
          Regenerate to rebuild the prompt from the soul. Token counts are estimates, not billing.
        </p>
      ) : (
        <p className="pane-note">Token counts are estimates, not billing.</p>
      )}
    </div>
  )
}
