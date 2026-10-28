import type { Library, Soul } from '../types'
import { defaultSettings, type LlmSettings } from './llm'
import { normalizeSoul, seedSouls } from './soul'

const LIBRARY_KEY = 'soulforge.library.v1'
const SETTINGS_KEY = 'soulforge.settings.v1'

function freshLibrary(): Library {
  const souls = seedSouls()
  return { version: 1, souls, selectedId: souls[0].id }
}

export function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const candidate = parsed as { souls?: unknown; selectedId?: unknown }
        if (Array.isArray(candidate.souls)) {
          const souls = candidate.souls
            .map(normalizeSoul)
            .filter((soul): soul is Soul => soul !== null)
          if (souls.length > 0) {
            const selectedId =
              typeof candidate.selectedId === 'string' &&
              souls.some((soul) => soul.id === candidate.selectedId)
                ? candidate.selectedId
                : souls[0].id
            return { version: 1, souls, selectedId }
          }
        }
      }
    }
  } catch {
    // Unreadable storage falls back to the starter library.
  }
  return freshLibrary()
}

export function saveLibrary(library: Library): boolean {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library))
    return true
  } catch {
    return false
  }
}

export function loadSettings(): LlmSettings {
  const base = defaultSettings()
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return base
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return base
    const candidate = parsed as Partial<LlmSettings>
    return {
      preset:
        candidate.preset === 'openai' ||
        candidate.preset === 'custom' ||
        candidate.preset === 'omniroute'
          ? candidate.preset
          : 'omniroute',
      baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : base.baseUrl,
      apiKey: typeof candidate.apiKey === 'string' ? candidate.apiKey : '',
      model: typeof candidate.model === 'string' ? candidate.model : base.model,
    }
  } catch {
    return base
  }
}

export function saveSettings(settings: LlmSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}
