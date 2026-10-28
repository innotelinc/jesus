import { describe, expect, it } from 'vitest'
import {
  compilePrompt,
  createSnapshot,
  createSoul,
  estimateTokens,
  normalizeSoul,
  restoreSnapshot,
  soulPrompt,
  soulToMarkdown,
  voiceDescriptor,
  wordCount,
} from '../src/lib/soul'

function sampleSoul() {
  return createSoul({
    name: 'Atlas',
    role: 'research analyst',
    mission: 'Turn messy questions into short briefs.',
    audience: 'product leads',
    voice: { warmth: 80, directness: 20, verbosity: 50, humor: 90 },
    principles: ['Evidence first.'],
    boundaries: ['Never invent sources.'],
    rules: ['Open with the answer.'],
    format: { length: 'concise', markdown: true, language: 'English', banned: ['delve'] },
    capabilities: 'You cannot browse.',
    notes: 'House style applies.',
  })
}

describe('compilePrompt', () => {
  it('compiles every populated section in order', () => {
    const prompt = compilePrompt(sampleSoul())
    const headings = [
      '# Identity',
      '# Voice',
      '# Principles',
      '# Boundaries',
      '# Operating rules',
      '# Response style',
      '# Capabilities',
      '# Additional context',
    ]

    let cursor = -1
    for (const heading of headings) {
      const at = prompt.indexOf(heading)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }

    expect(prompt).toContain('You are Atlas, research analyst.')
    expect(prompt).toContain('Mission: Turn messy questions into short briefs.')
    expect(prompt).toContain('You are talking with: product leads')
    expect(prompt).toContain('Evidence first.')
    expect(prompt).toContain('Never invent sources.')
    expect(prompt).toContain('Avoid these words and phrases: “delve”.')
    expect(prompt).toContain('Length: concise —')
    expect(prompt).toContain('You cannot browse.')
  })

  it('describes voice dials with banded language', () => {
    const prompt = compilePrompt(sampleSoul())
    expect(prompt).toContain('Warmth 80/100 — warm and encouraging')
    expect(prompt).toContain('Directness 20/100 — diplomatic')
    expect(prompt).toContain('Humor 90/100 — playful')
    expect(voiceDescriptor('verbosity', 10)).toContain('terse')
    expect(voiceDescriptor('verbosity', 50)).toContain('balanced')
    expect(voiceDescriptor('verbosity', 100)).toContain('thorough')
  })

  it('omits empty sections and respects section toggles', () => {
    const soul = sampleSoul()
    soul.principles = []
    soul.sections.boundaries = false
    const prompt = compilePrompt(soul)
    expect(prompt).not.toContain('# Principles')
    expect(prompt).not.toContain('# Boundaries')
    expect(prompt).toContain('# Operating rules')
  })

  it('prefers a manual prompt override', () => {
    const soul = sampleSoul()
    soul.promptOverride = 'You are a custom agent.'
    expect(soulPrompt(soul)).toBe('You are a custom agent.')
    expect(compilePrompt(soul)).toContain('# Identity')
  })

  it('writes markdown with frontmatter from the effective prompt', () => {
    const soul = sampleSoul()
    soul.promptOverride = 'Just this.'
    const markdown = soulToMarkdown(soul)
    expect(markdown.startsWith('---\nname: Atlas\nrole: research analyst\n')).toBe(true)
    expect(markdown).toContain('Just this.')
  })
})

describe('snapshots', () => {
  it('captures soul fields and restores them without losing history', () => {
    const soul = sampleSoul()
    const snapshot = createSnapshot(soul)
    expect(snapshot.prompt).toContain('# Identity')
    expect('history' in snapshot.soul).toBe(false)

    soul.name = 'Changed'
    soul.voice.warmth = 5
    const snapshotHistory = [{ ...snapshot, id: 'old' }]
    soul.history = snapshotHistory

    const restored = restoreSnapshot(soul, snapshot)
    expect(restored.name).toBe('Atlas')
    expect(restored.voice.warmth).toBe(80)
    expect(restored.id).toBe(soul.id)
    expect(restored.history).toBe(snapshotHistory)
  })
})

describe('normalizeSoul', () => {
  it('rejects non-objects', () => {
    expect(normalizeSoul(null)).toBeNull()
    expect(normalizeSoul('nope')).toBeNull()
    expect(normalizeSoul(42)).toBeNull()
  })

  it('coerces untrusted fields and clamps dials', () => {
    const soul = normalizeSoul({
      name: '  Echo  ',
      voice: { warmth: 900, directness: -3, humor: 'lots' },
      principles: ['  one  ', 4, '', 'two'],
      format: { length: 'epic', markdown: 'yes', banned: ['delve'] },
      model: { temperature: 7, maxTokens: 1 },
      sections: { notes: false, identity: 'nope' },
      promptOverride: 42,
    })

    expect(soul).not.toBeNull()
    expect(soul?.name).toBe('Echo')
    expect(soul?.voice.warmth).toBe(100)
    expect(soul?.voice.directness).toBe(0)
    expect(soul?.voice.humor).toBe(25)
    expect(soul?.principles).toEqual(['one', 'two'])
    expect(soul?.format.length).toBe('balanced')
    expect(soul?.format.markdown).toBe(true)
    expect(soul?.model.temperature).toBe(2)
    expect(soul?.model.maxTokens).toBe(64)
    expect(soul?.sections.notes).toBe(false)
    expect(soul?.sections.identity).toBe(true)
    expect(soul?.promptOverride).toBeNull()
  })

  it('drops malformed history entries', () => {
    const soul = normalizeSoul({ name: 'X', history: [{ label: 'bad' }, { prompt: 'keep', soul: { name: 'Y' } }] })
    expect(soul?.history).toHaveLength(1)
    expect(soul?.history[0].prompt).toBe('keep')
  })
})

describe('measurement', () => {
  it('counts words and estimates tokens', () => {
    expect(wordCount('  one two   three ')).toBe(3)
    expect(wordCount('')).toBe(0)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('one two three four')).toBeGreaterThan(0)
  })
})
