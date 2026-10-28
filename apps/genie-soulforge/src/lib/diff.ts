export type LineChange = 'same' | 'add' | 'remove'

export interface LineRow {
  kind: LineChange
  text: string
  beforeNo?: number
  afterNo?: number
}

export interface DiffStats {
  added: number
  removed: number
  unchanged: number
}

export interface WordPart {
  text: string
  changed: boolean
}

export interface SideCell {
  no: number
  text: string
  parts?: WordPart[]
}

export type SideKind = 'same' | 'change' | 'gap'

export interface SideRow {
  kind: SideKind
  left: SideCell | null
  right: SideCell | null
  /** For gap rows: how many unchanged lines were folded away. */
  hidden?: number
}

const MAX_LINES = 4000

function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.slice(0, MAX_LINES)
}

/**
 * Longest-common-subsequence table over two token lists, used for both line
 * and word diffs. Returned as a full table so the caller can backtrack in
 * order and emit removals before additions inside a change hunk.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

export function diffLines(before: string, after: string): LineRow[] {
  const a = toLines(before)
  const b = toLines(after)
  const table = lcsTable(a, b)
  const rows: LineRow[] = []
  let i = 0
  let j = 0
  let beforeNo = 1
  let afterNo = 1

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i], beforeNo: beforeNo++, afterNo: afterNo++ })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: 'remove', text: a[i], beforeNo: beforeNo++ })
      i += 1
    } else {
      rows.push({ kind: 'add', text: b[j], afterNo: afterNo++ })
      j += 1
    }
  }

  while (i < a.length) rows.push({ kind: 'remove', text: a[i++], beforeNo: beforeNo++ })
  while (j < b.length) rows.push({ kind: 'add', text: b[j++], afterNo: afterNo++ })

  return rows
}

export function diffStats(rows: LineRow[]): DiffStats {
  return rows.reduce<DiffStats>(
    (stats, row) => {
      if (row.kind === 'add') stats.added += 1
      else if (row.kind === 'remove') stats.removed += 1
      else stats.unchanged += 1
      return stats
    },
    { added: 0, removed: 0, unchanged: 0 },
  )
}

function tokenize(text: string): string[] {
  return text.split(/(\s+|[.,;:!?()[\]{}"“”‘’…—–])/).filter((token) => token !== '')
}

function pushPart(parts: WordPart[], text: string, changed: boolean) {
  if (!text) return
  const last = parts[parts.length - 1]
  if (last && last.changed === changed) last.text += text
  else parts.push({ text, changed })
}

/** Word-level comparison of one changed line pair, used for inline highlights. */
export function diffWords(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const a = tokenize(before)
  const b = tokenize(after)
  const table = lcsTable(a, b)
  const beforeParts: WordPart[] = []
  const afterParts: WordPart[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushPart(beforeParts, a[i], false)
      pushPart(afterParts, b[j], false)
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      pushPart(beforeParts, a[i], true)
      i += 1
    } else {
      pushPart(afterParts, b[j], true)
      j += 1
    }
  }
  while (i < a.length) pushPart(beforeParts, a[i++], true)
  while (j < b.length) pushPart(afterParts, b[j++], true)

  return { before: beforeParts, after: afterParts }
}

/** Pair removals with additions so a replacement occupies one visual row. */
export function sideBySide(rows: LineRow[]): SideRow[] {
  const sideRows: SideRow[] = []
  let index = 0

  while (index < rows.length) {
    const row = rows[index]
    if (row.kind === 'same') {
      sideRows.push({
        kind: 'same',
        left: { no: row.beforeNo ?? 0, text: row.text },
        right: { no: row.afterNo ?? 0, text: row.text },
      })
      index += 1
      continue
    }

    const removed: LineRow[] = []
    const added: LineRow[] = []
    while (index < rows.length && rows[index].kind !== 'same') {
      const changed = rows[index]
      if (changed.kind === 'remove') removed.push(changed)
      else added.push(changed)
      index += 1
    }

    const height = Math.max(removed.length, added.length)
    for (let offset = 0; offset < height; offset += 1) {
      const leftRow = removed[offset]
      const rightRow = added[offset]
      const words =
        leftRow && rightRow ? diffWords(leftRow.text, rightRow.text) : null
      sideRows.push({
        kind: 'change',
        left: leftRow
          ? {
              no: leftRow.beforeNo ?? 0,
              text: leftRow.text,
              parts: words?.before,
            }
          : null,
        right: rightRow
          ? {
              no: rightRow.afterNo ?? 0,
              text: rightRow.text,
              parts: words?.after,
            }
          : null,
      })
    }
  }

  return sideRows
}

/** Fold long stretches of unchanged lines down to `context` lines on each edge. */
export function collapseUnchanged(rows: SideRow[], context = 3): SideRow[] {
  if (context < 0) return rows
  const out: SideRow[] = []
  let index = 0

  while (index < rows.length) {
    if (rows[index].kind !== 'same') {
      out.push(rows[index])
      index += 1
      continue
    }
    let end = index
    while (end < rows.length && rows[end].kind === 'same') end += 1
    const run = rows.slice(index, end)
    if (run.length > context * 2 + 1) {
      out.push(
        ...run.slice(0, context),
        { kind: 'gap', left: null, right: null, hidden: run.length - context * 2 },
        ...run.slice(run.length - context),
      )
    } else {
      out.push(...run)
    }
    index = end
  }

  return out
}
