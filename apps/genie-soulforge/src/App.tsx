import { useCallback, useEffect, useRef, useState } from 'react'
import { DiffDialog } from './components/DiffDialog'
import { HistoryDialog } from './components/HistoryDialog'
import { Icon } from './components/Icons'
import { Playground } from './components/Playground'
import { PromptPane } from './components/PromptPane'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SoulEditor } from './components/SoulEditor'
import type { LlmSettings } from './lib/llm'
import {
  createSnapshot,
  createSoul,
  duplicateSoul,
  estimateTokens,
  normalizeSoul,
  restoreSnapshot,
  SNAPSHOT_LIMIT,
  soulPrompt,
  soulToMarkdown,
  uid,
} from './lib/soul'
import { loadLibrary, loadSettings, saveLibrary, saveSettings } from './lib/storage'
import type { Library, Soul } from './types'

type Tab = 'soul' | 'prompt' | 'playground'

const TABS: { id: Tab; label: string }[] = [
  { id: 'soul', label: 'Soul' },
  { id: 'prompt', label: 'System prompt' },
  { id: 'playground', label: 'Playground' },
]

function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'soul'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractSouls(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.souls)) return parsed.souls
    if ('voice' in parsed) return [parsed]
  }
  return []
}

export default function App() {
  const [library, setLibrary] = useState<Library>(loadLibrary)
  const [settings, setSettings] = useState<LlmSettings>(loadSettings)
  const [tab, setTab] = useState<Tab>('soul')
  const [saved, setSaved] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [compare, setCompare] = useState<{ snapshotId?: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const importRef = useRef<HTMLInputElement | null>(null)

  const soul = library.souls.find((entry) => entry.id === library.selectedId) ?? library.souls[0]
  const prompt = soulPrompt(soul)
  const promptTokens = estimateTokens(prompt)

  const notify = useCallback((message: string) => {
    setToast({ id: Date.now(), message })
  }, [])

  const updateSoul = useCallback((updater: (current: Soul) => Soul) => {
    setLibrary((current) => ({
      ...current,
      souls: current.souls.map((entry) =>
        entry.id === current.selectedId
          ? { ...updater(entry), updatedAt: Date.now() }
          : entry,
      ),
    }))
  }, [])

  const takeSnapshot = useCallback(() => {
    setLibrary((current) => {
      const active = current.souls.find((entry) => entry.id === current.selectedId)
      if (!active) return current
      const snapshot = createSnapshot(active)
      return {
        ...current,
        souls: current.souls.map((entry) =>
          entry.id === active.id
            ? {
                ...entry,
                history: [snapshot, ...entry.history].slice(0, SNAPSHOT_LIMIT),
                updatedAt: Date.now(),
              }
            : entry,
        ),
      }
    })
    notify('Snapshot saved')
  }, [notify])

  useEffect(() => {
    setSaved(saveLibrary(library))
  }, [library])

  useEffect(() => {
    if (!toast) return
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(toastTimer.current)
  }, [toast])

  useEffect(() => {
    document.title = `${soul.name || 'Untitled soul'} — Soulforge`
  }, [soul.name])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        takeSnapshot()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [takeSnapshot])

  function selectSoul(id: string) {
    setLibrary((current) => ({ ...current, selectedId: id }))
  }

  function createNewSoul() {
    const fresh = createSoul({ name: 'Untitled soul' })
    setLibrary((current) => ({
      ...current,
      souls: [fresh, ...current.souls],
      selectedId: fresh.id,
    }))
    setTab('soul')
    notify('New soul created')
  }

  function duplicate(id: string) {
    setLibrary((current) => {
      const source = current.souls.find((entry) => entry.id === id)
      if (!source) return current
      const copy = duplicateSoul(source)
      const index = current.souls.findIndex((entry) => entry.id === id)
      const souls = [...current.souls]
      souls.splice(index + 1, 0, copy)
      return { ...current, souls, selectedId: copy.id }
    })
    notify('Soul duplicated')
  }

  function removeSoul(id: string) {
    setLibrary((current) => {
      if (current.souls.length <= 1) return current
      const index = current.souls.findIndex((entry) => entry.id === id)
      const souls = current.souls.filter((entry) => entry.id !== id)
      const selectedId =
        current.selectedId === id ? souls[Math.max(0, index - 1)].id : current.selectedId
      return { ...current, souls, selectedId }
    })
    notify('Soul deleted')
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt)
      notify('System prompt copied')
    } catch {
      notify('Could not access the clipboard')
    }
  }

  function downloadPrompt() {
    downloadFile(`${slug(soul.name)}.md`, soulToMarkdown(soul), 'text/markdown;charset=utf-8')
    notify('Markdown downloaded')
  }

  function exportLibrary() {
    downloadFile('soulforge-library.json', JSON.stringify(library, null, 2), 'application/json')
    notify('Library exported')
  }

  function importLibrary(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed: unknown = JSON.parse(String(reader.result))
        const souls = extractSouls(parsed)
          .map(normalizeSoul)
          .filter((entry): entry is Soul => entry !== null)
        if (souls.length === 0) {
          notify('No souls found in that file')
          return
        }
        setLibrary((current) => {
          const existing = new Set(current.souls.map((entry) => entry.id))
          const imported = souls.map((entry) =>
            existing.has(entry.id)
              ? { ...entry, id: uid('soul'), name: `${entry.name} (imported)` }
              : entry,
          )
          return {
            ...current,
            souls: [...imported, ...current.souls],
            selectedId: imported[0].id,
          }
        })
        setTab('soul')
        notify(`Imported ${souls.length} soul${souls.length === 1 ? '' : 's'}`)
      } catch {
        notify('That file is not valid Soulforge JSON')
      }
    }
    reader.readAsText(file)
  }

  function restoreFromHistory(snapshotId: string) {
    const snapshot = soul.history.find((entry) => entry.id === snapshotId)
    if (!snapshot) return
    updateSoul((current) => restoreSnapshot(current, snapshot))
    setHistoryOpen(false)
    notify('Snapshot restored')
  }

  function compareVersions(snapshotId?: string) {
    setHistoryOpen(false)
    setCompare({ snapshotId })
  }

  function deleteSnapshot(snapshotId: string) {
    updateSoul((current) => ({
      ...current,
      history: current.history.filter((entry) => entry.id !== snapshotId),
    }))
    notify('Snapshot deleted')
  }

  function saveModelSettings(next: LlmSettings) {
    setSettings(next)
    saveSettings(next)
    setSettingsOpen(false)
    notify('Model settings saved')
  }

  return (
    <div className="app">
      <Sidebar
        souls={library.souls}
        selectedId={soul.id}
        onSelect={selectSoul}
        onCreate={createNewSoul}
        onDuplicate={duplicate}
        onDelete={removeSoul}
      />

      <main className="workspace">
        <header className="topbar">
          <div className="title-block">
            <span className="crumb">Soul library</span>
            <div className="title-line">
              <h1>{soul.name || 'Untitled soul'}</h1>
              <span className="role-chip">{soul.role || 'assistant'}</span>
            </div>
          </div>

          <div className="topbar-actions">
            <span className={`save-state${saved ? '' : ' is-warn'}`}>
              {saved ? 'Saved locally' : 'Not saved'}
            </span>

            <button type="button" className="btn ghost" onClick={() => setHistoryOpen(true)}>
              <Icon name="clock" size={14} /> History
              {soul.history.length > 0 ? (
                <span className="count-badge">{soul.history.length}</span>
              ) : null}
            </button>

            <div className="menu-wrap">
              <button
                type="button"
                className="btn ghost"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Icon name="download" size={14} /> Export
              </button>
              {menuOpen ? (
                <>
                  <div className="menu-overlay" onClick={() => setMenuOpen(false)} />
                  <div className="menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        void copyPrompt()
                      }}
                    >
                      <Icon name="copy" size={14} /> Copy system prompt
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        downloadPrompt()
                      }}
                    >
                      <Icon name="file" size={14} /> Download soul (.md)
                    </button>
                    <div className="menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        importRef.current?.click()
                      }}
                    >
                      <Icon name="upload" size={14} /> Import library…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        exportLibrary()
                      }}
                    >
                      <Icon name="download" size={14} /> Export library (.json)
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            <button
              type="button"
              className="btn icon ghost"
              aria-label="Model connection settings"
              title="Model connection"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="sliders" size={16} />
            </button>
          </div>
        </header>

        <nav className="tabs" role="tablist" aria-label="Workspace views">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`tab-${entry.id}`}
              aria-controls={`pane-${entry.id}`}
              aria-selected={tab === entry.id}
              className={`tab${tab === entry.id ? ' is-on' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {entry.id === 'prompt' ? (
                <span className="tab-meta">≈ {promptTokens.toLocaleString()}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="panes">
          <section
            className="pane"
            id="pane-soul"
            role="tabpanel"
            aria-labelledby="tab-soul"
            hidden={tab !== 'soul'}
          >
            <SoulEditor soul={soul} onChange={updateSoul} />
          </section>

          <section
            className="pane"
            id="pane-prompt"
            role="tabpanel"
            aria-labelledby="tab-prompt"
            hidden={tab !== 'prompt'}
          >
            <PromptPane
              soul={soul}
              onChange={updateSoul}
              onCopy={() => void copyPrompt()}
              onDownload={downloadPrompt}
            />
          </section>

          <section
            className="pane"
            id="pane-playground"
            role="tabpanel"
            aria-labelledby="tab-playground"
            hidden={tab !== 'playground'}
          >
            <Playground
              key={soul.id}
              soul={soul}
              systemPrompt={prompt}
              settings={settings}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </section>
        </div>
      </main>

      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) importLibrary(file)
        }}
      />

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onSave={saveModelSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          soul={soul}
          onRestore={restoreFromHistory}
          onDelete={deleteSnapshot}
          onCompare={compareVersions}
          onSnapshot={takeSnapshot}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {compare ? (
        <DiffDialog
          soul={soul}
          initialSnapshotId={compare.snapshotId}
          onClose={() => setCompare(null)}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status" key={toast.id}>
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}
