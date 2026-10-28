import { useMemo, useState } from 'react'
import type { Soul } from '../types'
import { Icon } from './Icons'

export function Sidebar({
  souls,
  selectedId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
}: {
  souls: Soul[]
  selectedId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return souls
    return souls.filter((soul) => `${soul.name} ${soul.role}`.toLowerCase().includes(q))
  }, [souls, query])

  return (
    <aside className="sidebar" aria-label="Soul library">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="spark" size={18} />
        </span>
        <div>
          <div className="brand-name">Soulforge</div>
          <div className="brand-sub">Soul &amp; prompt editor</div>
        </div>
      </div>

      <label className="search">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search souls"
          aria-label="Search souls"
          spellCheck={false}
        />
        {query ? (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </label>

      <div className="rail-label">
        Souls <span>{souls.length}</span>
      </div>

      <div className="soul-list">
        {visible.map((soul) => {
          const active = soul.id === selectedId
          return (
            <div key={soul.id} className={`soul-row${active ? ' is-active' : ''}`}>
              <button
                type="button"
                className="soul-main"
                onClick={() => onSelect(soul.id)}
                aria-current={active ? 'true' : undefined}
              >
                <span className="avatar">{(soul.name.trim()[0] ?? '?').toUpperCase()}</span>
                <span className="soul-text">
                  <span className="soul-name">{soul.name || 'Untitled soul'}</span>
                  <span className="soul-role-sm">{soul.role || 'assistant'}</span>
                </span>
              </button>

              {confirmId === soul.id ? (
                <div className="soul-confirm">
                  <span>Delete?</span>
                  <button
                    type="button"
                    className="mini danger"
                    disabled={souls.length <= 1}
                    onClick={() => {
                      onDelete(soul.id)
                      setConfirmId(null)
                    }}
                  >
                    Yes
                  </button>
                  <button type="button" className="mini" onClick={() => setConfirmId(null)}>
                    No
                  </button>
                </div>
              ) : (
                <div className="soul-actions">
                  <button
                    type="button"
                    className="mini icon"
                    title="Duplicate soul"
                    aria-label={`Duplicate ${soul.name}`}
                    onClick={() => onDuplicate(soul.id)}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                  <button
                    type="button"
                    className="mini icon"
                    title={souls.length <= 1 ? 'Keep at least one soul' : 'Delete soul'}
                    aria-label={`Delete ${soul.name}`}
                    onClick={() => setConfirmId(soul.id)}
                    disabled={souls.length <= 1}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {visible.length === 0 ? <p className="rail-empty">No souls match “{query}”.</p> : null}
      </div>

      <div className="sidebar-foot">
        <button type="button" className="btn primary block" onClick={onCreate}>
          <Icon name="plus" size={15} /> New soul
        </button>
        <p className="rail-note">Autosaved in this browser</p>
      </div>
    </aside>
  )
}
