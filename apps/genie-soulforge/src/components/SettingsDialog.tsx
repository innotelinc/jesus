import { useId, useState } from 'react'
import { endpointFor, MODEL_SUGGESTIONS, PROVIDERS, type LlmSettings, type ProviderPreset } from '../lib/llm'
import { Icon } from './Icons'
import { Modal } from './Modal'

export function SettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: LlmSettings
  onSave: (settings: LlmSettings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<LlmSettings>(settings)
  const [reveal, setReveal] = useState(false)
  const modelListId = useId()
  const provider = PROVIDERS[draft.preset]
  const endpoint = endpointFor(draft.baseUrl)

  const choosePreset = (preset: ProviderPreset) => {
    const details = PROVIDERS[preset]
    setDraft((current) => ({
      ...current,
      preset,
      baseUrl: preset === 'custom' ? '' : details.baseUrl,
      model: preset === 'custom' ? '' : details.model,
    }))
  }

  return (
    <Modal
      title="Model connection"
      subtitle="Bring your own key. It is sent only to the endpoint below and stored in this browser."
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn ghost modal-foot-note"
            onClick={() => setDraft((current) => ({ ...current, apiKey: '' }))}
          >
            Clear key
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!draft.baseUrl.trim()}
            onClick={() => onSave(draft)}
          >
            <Icon name="check" size={14} /> Save
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Provider</span>
        <div className="provider-grid">
          {(Object.keys(PROVIDERS) as ProviderPreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              className={`provider${draft.preset === preset ? ' is-on' : ''}`}
              aria-pressed={draft.preset === preset}
              onClick={() => choosePreset(preset)}
            >
              <strong>{PROVIDERS[preset].label}</strong>
              <span>{preset === 'custom' ? 'OpenAI-compatible' : 'Proxied locally'}</span>
            </button>
          ))}
        </div>
        <span className="field-hint">{provider.blurb}</span>
      </div>

      <label className="field">
        <span className="field-label">API key</span>
        <div className="input-row">
          <input
            type={reveal ? 'text' : 'password'}
            value={draft.apiKey}
            placeholder={provider.keyHint}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
          />
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setReveal((value) => !value)}
            aria-pressed={reveal}
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>

      <div className="field-grid">
        <label className="field">
          <span className="field-label">Model</span>
          <input
            list={modelListId}
            value={draft.model}
            placeholder="model id"
            spellCheck={false}
            onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
          />
          <datalist id={modelListId}>
            {MODEL_SUGGESTIONS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            value={draft.baseUrl}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
          />
        </label>
      </div>

      <div className="endpoint-preview">
        <span className="field-label">Request endpoint</span>
        <code>{endpoint || '—'}</code>
        <span className="field-hint">
          OpenRouter and OpenAI requests go through this dev server's proxy. Custom endpoints are
          called directly, so they must allow browser (CORS) requests.
        </span>
      </div>

      <p className="security-note">
        The key lives in localStorage, not in the project or in any server. Avoid saving a key on a
        shared machine.
      </p>
    </Modal>
  )
}
