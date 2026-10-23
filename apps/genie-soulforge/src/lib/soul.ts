import type { SectionKey, Soul, Snapshot, Voice } from '../types'

export const SECTION_ORDER: SectionKey[] = [
  'identity',
  'voice',
  'principles',
  'boundaries',
  'rules',
  'style',
  'capabilities',
  'notes',
]

export const SECTION_LABELS: Record<SectionKey, string> = {
  identity: 'Identity',
  voice: 'Voice',
  principles: 'Principles',
  boundaries: 'Boundaries',
  rules: 'Operating rules',
  style: 'Response style',
  capabilities: 'Capabilities',
  notes: 'Notes',
}

export const VOICE_META: { key: keyof Voice; label: string; low: string; high: string }[] = [
  { key: 'warmth', label: 'Warmth', low: 'Cool', high: 'Warm' },
  { key: 'directness', label: 'Directness', low: 'Diplomatic', high: 'Blunt' },
  { key: 'verbosity', label: 'Depth', low: 'Terse', high: 'Thorough' },
  { key: 'humor', label: 'Humor', low: 'Serious', high: 'Playful' },
]

const VOICE_BANDS: Record<keyof Voice, [string, string, string]> = {
  warmth: [
    'cool and matter-of-fact; no cheerleading',
    'friendly without being effusive',
    'warm and encouraging; acknowledge the person, not just the task',
  ],
  directness: [
    'diplomatic; soften hard truths without hiding them',
    'clear and even-handed; say the thing plainly',
    'blunt and to the point; no hedging or padding',
  ],
  verbosity: [
    'terse; favor the shortest complete answer',
    'balanced; enough detail to act on, no filler',
    'thorough; explain your reasoning and include examples',
  ],
  humor: [
    'serious; skip the jokes',
    'occasional dry wit, never at the user’s expense',
    'playful; light humor is welcome when it fits',
  ],
}

export function band(value: number, bands: [string, string, string]): string {
  if (value < 34) return bands[0]
  if (value < 67) return bands[1]
  return bands[2]
}

export function voiceDescriptor(key: keyof Voice, value: number): string {
  return band(value, VOICE_BANDS[key])
}

export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return prefix ? `${prefix}_${raw}` : raw
}

export function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

export const LENGTH_COPY: Record<Soul['format']['length'], string> = {
  concise: 'concise — answer in as few words as needed, then stop',
  balanced: 'balanced — enough detail to act on, no filler',
  detailed: 'detailed — explain the reasoning and include examples where useful',
}

export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/**
 * Cheap, provider-agnostic token estimate: roughly 4 characters per token,
 * with a floor that accounts for short words tokenizing to >= 1 token.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.max(1, Math.round(Math.max(trimmed.length / 4, wordCount(trimmed) * 0.75)))
}

function quoteList(items: string[]): string {
  return items.map((item) => `“${item}”`).join(', ')
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export function buildSections(soul: Soul): Record<SectionKey, string> {
  const role = soul.role.trim().replace(/[.!]+$/, '')
  const mission = soul.mission.trim()
  const audience = soul.audience.trim()

  const identityLines = [`# Identity`, '', `You are ${soul.name.trim() || 'an assistant'}${role ? `, ${role}` : ''}.`]
  if (mission) identityLines.push('', `Mission: ${sentence(mission)}`)
  if (audience) identityLines.push('', `You are talking with: ${sentence(audience)}`)

  const voiceLines = [
    '# Voice',
    '',
    'Carry this voice into every reply, including one-line ones:',
    ...VOICE_META.map(
      ({ key, label }) =>
        `- ${label} ${clamp(soul.voice[key])}/100 — ${voiceDescriptor(key, clamp(soul.voice[key]))}.`,
    ),
  ]

  const principles = soul.principles.filter((p) => p.trim())
  const boundaries = soul.boundaries.filter((b) => b.trim())
  const rules = soul.rules.filter((r) => r.trim())
  const banned = soul.format.banned.filter((b) => b.trim())
  const language = soul.format.language.trim() || 'English'

  const styleLines = [
    '# Response style',
    '',
    `- Length: ${LENGTH_COPY[soul.format.length]}.`,
    soul.format.markdown
      ? '- Format: Markdown (short paragraphs, lists when they help, fenced code blocks for code).'
      : '- Format: plain prose, no Markdown syntax.',
    `- Language: write in ${language}.`,
  ]
  if (banned.length) styleLines.push(`- Avoid these words and phrases: ${quoteList(banned)}.`)

  return {
    identity: identityLines.join('\n'),
    voice: voiceLines.join('\n'),
    principles: principles.length
      ? ['# Principles', '', 'Let these principles drive your judgment:', '', bulletList(principles)].join('\n')
      : '',
    boundaries: boundaries.length
      ? ['# Boundaries', '', 'Never cross these, even if asked directly:', '', bulletList(boundaries)].join('\n')
      : '',
    rules: rules.length ? ['# Operating rules', '', bulletList(rules)].join('\n') : '',
    style: styleLines.join('\n'),
    capabilities: soul.capabilities.trim() ? ['# Capabilities', '', soul.capabilities.trim()].join('\n') : '',
    notes: soul.notes.trim() ? ['# Additional context', '', soul.notes.trim()].join('\n') : '',
  }
}

export function compilePrompt(soul: Soul): string {
  const sections = buildSections(soul)
  return SECTION_ORDER.filter((key) => soul.sections[key] && sections[key])
    .map((key) => sections[key])
    .join('\n\n')
}

/** The prompt actually sent to the model: a manual override wins over the compiler. */
export function soulPrompt(soul: Soul): string {
  return soul.promptOverride ?? compilePrompt(soul)
}

export function soulToMarkdown(soul: Soul): string {
  const frontmatter = [
    '---',
    `name: ${soul.name.trim() || 'Untitled soul'}`,
    `role: ${soul.role.trim() || 'assistant'}`,
    `updated: ${new Date(soul.updatedAt).toISOString()}`,
    '---',
    '',
  ].join('\n')
  return `${frontmatter}${soulPrompt(soul)}\n`
}

export function emptySections(): Record<SectionKey, boolean> {
  return {
    identity: true,
    voice: true,
    principles: true,
    boundaries: true,
    rules: true,
    style: true,
    capabilities: true,
    notes: true,
  }
}

export function createSoul(overrides: Partial<Soul> = {}): Soul {
  const now = Date.now()
  const base: Soul = {
    id: uid('soul'),
    name: 'Untitled soul',
    role: 'general-purpose assistant',
    mission: '',
    audience: '',
    voice: { warmth: 55, directness: 60, verbosity: 50, humor: 25 },
    principles: [],
    boundaries: [],
    rules: [],
    format: { length: 'balanced', markdown: true, language: 'English', banned: [] },
    capabilities: '',
    notes: '',
    sections: emptySections(),
    promptOverride: null,
    model: { temperature: 0.7, maxTokens: 1024 },
    history: [],
    createdAt: now,
    updatedAt: now,
  }
  return { ...base, ...overrides, id: overrides.id ?? base.id }
}

export function duplicateSoul(soul: Soul): Soul {
  const now = Date.now()
  const copy: Soul = JSON.parse(JSON.stringify({ ...soul, history: [] })) as Soul
  return {
    ...copy,
    id: uid('soul'),
    name: `${soul.name} copy`,
    promptOverride: soul.promptOverride,
    createdAt: now,
    updatedAt: now,
    history: [],
  }
}

export function createSnapshot(soul: Soul, label = 'Manual snapshot'): Snapshot {
  const { history: _history, ...rest } = soul
  return {
    id: uid('snap'),
    createdAt: Date.now(),
    label,
    prompt: soulPrompt(soul),
    soul: JSON.parse(JSON.stringify(rest)) as Omit<Soul, 'history'>,
  }
}

export function restoreSnapshot(soul: Soul, snapshot: Snapshot): Soul {
  return {
    ...snapshot.soul,
    id: soul.id,
    history: soul.history,
    updatedAt: Date.now(),
  }
}

export const SNAPSHOT_LIMIT = 25

export function seedSouls(): Soul[] {
  return [
    createSoul({
      name: 'Atlas',
      role: 'research analyst',
      mission:
        'Turn messy questions into short, evidence-weighted briefs that help someone decide what to do next.',
      audience: 'product and strategy leads who need a defensible answer quickly',
      voice: { warmth: 54, directness: 74, verbosity: 48, humor: 18 },
      principles: [
        'Lead with the strongest evidence, not the most available evidence.',
        'Separate what is known, what is inferred, and what is unknown.',
        'State confidence plainly; “I don’t know yet” is a valid finding.',
      ],
      boundaries: [
        'Do not invent sources, quotes, numbers, or citations.',
        'Do not present speculation as fact or hide uncertainty to sound confident.',
      ],
      rules: [
        'Open with the answer in one or two sentences, then support it.',
        'Name the strongest counterargument before recommending a direction.',
        'When sources are unavailable, say so and describe what would change the answer.',
      ],
      format: {
        length: 'concise',
        markdown: true,
        language: 'English',
        banned: ['delve', 'tapestry', 'in today’s fast-paced world'],
      },
      capabilities:
        'You reason over notes and research supplied in the conversation. You cannot browse unless a browsing tool is attached.',
      model: { temperature: 0.3, maxTokens: 1200 },
    }),
    createSoul({
      name: 'Ember',
      role: 'writing partner',
      mission:
        'Help the user find the sentence they actually mean, then make it sound like them on their best day.',
      audience: 'founders and designers writing product copy, essays, and launch notes',
      voice: { warmth: 78, directness: 56, verbosity: 55, humor: 62 },
      principles: [
        'Protect the writer’s voice; your job is to sharpen it, not replace it.',
        'Specific beats clever. A concrete detail outranks a nice rhythm.',
        'Cut before you add.',
      ],
      boundaries: [
        'Do not rewrite a whole piece unless explicitly asked; offer the smallest change that fixes it.',
        'Do not praise weak writing to be nice. Say what is not working.',
      ],
      rules: [
        'When asked for feedback, give the single biggest improvement first.',
        'Show edits as before → after, not as abstract advice.',
        'Keep explanations shorter than the edit itself.',
      ],
      format: { length: 'balanced', markdown: true, language: 'English', banned: ['leverage', 'seamless', 'game-changing'] },
      capabilities: 'You work entirely in text. You do not publish, schedule, or send anything.',
      model: { temperature: 0.8, maxTokens: 1024 },
    }),
    createSoul({
      name: 'Warden',
      role: 'code reviewer',
      mission:
        'Find the defect that will actually hurt production, explain it in one paragraph, and show the minimal fix.',
      audience: 'engineers who want a review they can act on before merging',
      voice: { warmth: 26, directness: 92, verbosity: 35, humor: 10 },
      principles: [
        'Correctness beats style. Never bury a bug under nitpicks.',
        'A review is a claim about behavior; back it with a concrete scenario.',
        'If you are unsure, label it as a question rather than a defect.',
      ],
      boundaries: [
        'Do not invent line numbers, APIs, or test results.',
        'Do not rewrite entire files unless the user asks for a patch.',
      ],
      rules: [
        'Order findings by severity: correctness, security, data loss, performance, style.',
        'For each finding: what breaks, when it breaks, and the smallest fix.',
        'Say plainly when you found nothing blocking.',
      ],
      format: { length: 'concise', markdown: true, language: 'English', banned: ['nit:', 'just a thought'] },
      capabilities: 'You read the code and diffs provided. You cannot run the test suite or execute the build.',
      model: { temperature: 0.2, maxTokens: 900 },
    }),
  ]
}

/* ------------------------------------------------------------------ */
/* Normalization: everything from localStorage or an import is untrusted */
/* ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 40)
}

function asSections(value: unknown): Record<SectionKey, boolean> {
  const sections = emptySections()
  if (isRecord(value)) {
    for (const key of SECTION_ORDER) {
      if (typeof value[key] === 'boolean') sections[key] = value[key]
    }
  }
  return sections
}

function normalizeSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || typeof raw.prompt !== 'string' || !isRecord(raw.soul)) return null
  const soul = normalizeSoul(raw.soul)
  if (!soul) return null
  const { history: _history, ...rest } = soul
  return {
    id: asString(raw.id) || uid('snap'),
    createdAt: asNumber(raw.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    label: asString(raw.label, 'Snapshot').slice(0, 80),
    prompt: raw.prompt,
    soul: rest,
  }
}

export function normalizeSoul(raw: unknown): Soul | null {
  if (!isRecord(raw)) return null
  const base = createSoul()
  const voiceRaw = isRecord(raw.voice) ? raw.voice : {}
  const formatRaw = isRecord(raw.format) ? raw.format : {}
  const modelRaw = isRecord(raw.model) ? raw.model : {}
  const length = asString(formatRaw.length)
  const historyRaw = Array.isArray(raw.history) ? raw.history : []

  return {
    ...base,
    id: asString(raw.id) || uid('soul'),
    name: asString(raw.name).trim() || 'Untitled soul',
    role: asString(raw.role),
    mission: asString(raw.mission),
    audience: asString(raw.audience),
    voice: {
      warmth: asNumber(voiceRaw.warmth, base.voice.warmth, 0, 100),
      directness: asNumber(voiceRaw.directness, base.voice.directness, 0, 100),
      verbosity: asNumber(voiceRaw.verbosity, base.voice.verbosity, 0, 100),
      humor: asNumber(voiceRaw.humor, base.voice.humor, 0, 100),
    },
    principles: asStringList(raw.principles),
    boundaries: asStringList(raw.boundaries),
    rules: asStringList(raw.rules),
    format: {
      length: length === 'concise' || length === 'detailed' ? length : 'balanced',
      markdown: typeof formatRaw.markdown === 'boolean' ? formatRaw.markdown : true,
      language: asString(formatRaw.language, 'English'),
      banned: asStringList(formatRaw.banned),
    },
    capabilities: asString(raw.capabilities),
    notes: asString(raw.notes),
    sections: asSections(raw.sections),
    promptOverride: typeof raw.promptOverride === 'string' ? raw.promptOverride : null,
    model: {
      temperature: asNumber(modelRaw.temperature, 0.7, 0, 2),
      maxTokens: asNumber(modelRaw.maxTokens, 1024, 64, 32000),
    },
    history: historyRaw
      .map(normalizeSnapshot)
      .filter((snapshot): snapshot is Snapshot => snapshot !== null)
      .slice(0, SNAPSHOT_LIMIT),
    createdAt: asNumber(raw.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    updatedAt: asNumber(raw.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  }
}
