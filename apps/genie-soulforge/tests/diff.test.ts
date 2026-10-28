import { describe, expect, it } from 'vitest'
import {
  collapseUnchanged,
  diffLines,
  diffStats,
  diffWords,
  sideBySide,
} from '../src/lib/diff'

describe('diffLines', () => {
  it('marks identical prompts as unchanged', () => {
    const rows = diffLines('one\ntwo', 'one\ntwo')
    expect(rows.map((row) => row.kind)).toEqual(['same', 'same'])
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0, unchanged: 2 })
  })

  it('detects added and removed lines with correct line numbers', () => {
    const rows = diffLines('one\ntwo\nthree', 'one\nthree\nfour')
    expect(rows).toEqual([
      { kind: 'same', text: 'one', beforeNo: 1, afterNo: 1 },
      { kind: 'remove', text: 'two', beforeNo: 2 },
      { kind: 'same', text: 'three', beforeNo: 3, afterNo: 2 },
      { kind: 'add', text: 'four', afterNo: 3 },
    ])
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1, unchanged: 2 })
  })

  it('ignores a single trailing newline and normalizes CRLF', () => {
    expect(diffLines('a\r\nb\n', 'a\nb').every((row) => row.kind === 'same')).toBe(true)
  })

  it('handles empty prompts', () => {
    expect(diffLines('', '')).toEqual([])
    expect(diffStats(diffLines('', 'new line'))).toEqual({
      added: 1,
      removed: 0,
      unchanged: 0,
    })
  })
})

describe('diffWords', () => {
  it('highlights only the words that changed', () => {
    const { before, after } = diffWords('You are Atlas, a research analyst.', 'You are Ember, a strict editor.')
    expect(before.filter((part) => part.changed).map((part) => part.text)).toEqual([
      'Atlas',
      'research',
      'analyst',
    ])
    expect(after.filter((part) => part.changed).map((part) => part.text)).toEqual([
      'Ember',
      'strict',
      'editor',
    ])
    expect(before.map((part) => part.text).join('')).toBe('You are Atlas, a research analyst.')
    expect(after.map((part) => part.text).join('')).toBe('You are Ember, a strict editor.')
  })

  it('merges adjacent unchanged tokens into single parts', () => {
    const { before } = diffWords('a b c', 'a b d')
    expect(before.filter((part) => !part.changed)).toHaveLength(1)
  })
})

describe('sideBySide', () => {
  it('pairs a replaced line into one row and word-diffs it', () => {
    const rows = sideBySide(diffLines('line one\nold value', 'line one\nnew value'))
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('same')
    expect(rows[1].kind).toBe('change')
    expect(rows[1].left?.text).toBe('old value')
    expect(rows[1].right?.text).toBe('new value')
    expect(rows[1].left?.parts?.some((part) => part.changed)).toBe(true)
    expect(rows[1].right?.parts?.some((part) => part.changed)).toBe(true)
  })

  it('keeps unpaired removals and additions on their own rows', () => {
    const rows = sideBySide(diffLines('gone one\ngone two', 'fresh'))
    expect(rows).toHaveLength(2)
    expect(rows[0].left?.text).toBe('gone one')
    expect(rows[0].right?.text).toBe('fresh')
    expect(rows[0].right?.parts?.every((part) => part.changed)).toBe(true)
    expect(rows[1].left?.text).toBe('gone two')
    expect(rows[1].right).toBeNull()
  })
})

describe('collapseUnchanged', () => {
  it('folds long unchanged runs and keeps context around changes', () => {
    const before = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'old', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'].join('\n')
    const after = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'new', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'].join('\n')
    const collapsed = collapseUnchanged(sideBySide(diffLines(before, after)), 2)
    const gaps = collapsed.filter((row) => row.kind === 'gap')
    expect(gaps).toHaveLength(2)
    expect(gaps[0].hidden).toBe(2)
    expect(gaps[1].hidden).toBe(3)
    expect(collapsed.filter((row) => row.kind === 'same')).toHaveLength(8)
  })

  it('leaves short runs untouched', () => {
    const rows = sideBySide(diffLines('a\nb\nold', 'a\nb\nnew'))
    expect(collapseUnchanged(rows, 3)).toEqual(rows)
  })
})
