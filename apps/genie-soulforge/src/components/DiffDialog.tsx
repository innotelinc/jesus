import { useMemo, useState } from 'react'
import {
  collapseUnchanged,
  diffLines,
  diffStats,
  sideBySide,
  type SideCell,
  type SideRow,
} from '../lib/diff'
import { formatFull } from '../lib/format'
import { estimateTokens, soulPrompt, wordCount } from '../lib/soul'
import type { Soul } from '../types'
import { Icon } from './Icons'
import { Modal } from './Modal'

const CURRENT = 'current'

interface Version {
  id: string
  label: string
  createdAt: number
  prompt: string
}

function DiffCell({ cell, side }: { cell: SideCell; side: 'left' | 'right' }) {
  return (
    <div className={`diff-cell is-${side}`} role="cell">
      {cell.parts
        ? cell.parts.map((part, index) =>
            part.changed ? (
              <mark className="diff-word" key={index}>
                {part.text}
              </mark>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )
        : cell.text}
    </div>
  )
}

function DiffRowView({ row }: { row: SideRow }) {
  return (
    <div className={`diff-row is-${row.kind}`} role="row">
      <span className="diff-no" aria-hidden="true">
        {row.left?.no ?? ''}
      </span>
      {row.left ? (
        <DiffCell cell={row.left} side="left" />
      ) : (
        <div className="diff-cell is-left is-blank" role="cell" />
      )}
      <span className="diff-no" aria-hidden="true">
        {row.right?.no ?? ''}
      </span>
      {row.right ? (
        <DiffCell cell={row.right} side="right" />
      ) : (
        <div className="diff-cell is-right is-blank" role="cell" />
      )}
    </div>
  )
}

export function DiffDialog({
  soul,
  initialSnapshotId,
  onClose,
}: {
  soul: Soul
  initialSnapshotId?: string
  onClose: () => void
}) {
  const versions = useMemo<Version[]>(
    () => [
      {
        id: CURRENT,
        label: 'Working copy',
        createdAt: soul.updatedAt,
        prompt: soulPrompt(soul),
      },
      ...soul.history.map((snapshot) => ({
        id: snapshot.id,
        label: snapshot.label,
        createdAt: snapshot.createdAt,
        prompt: snapshot.prompt,
      })),
    ],
    [soul],
  )

  const initialLeft =
    initialSnapshotId && versions.some((version) => version.id === initialSnapshotId)
      ? initialSnapshotId
      : (versions[1]?.id ?? CURRENT)
  const [leftId, setLeftId] = useState(initialLeft)
  const [rightId, setRightId] = useState(CURRENT)
  const [onlyChanges, setOnlyChanges] = useState(false)

  const left = versions.find((version) => version.id === leftId) ?? versions[0]
  const right = versions.find((version) => version.id === rightId) ?? versions[0]

  const lineRows = useMemo(() => diffLines(left.prompt, right.prompt), [left.prompt, right.prompt])
  const stats = useMemo(() => diffStats(lineRows), [lineRows])
  const rows = useMemo(
    () => (onlyChanges ? collapseUnchanged(sideBySide(lineRows), 3) : sideBySide(lineRows)),
    [lineRows, onlyChanges],
  )
  const identical = stats.added === 0 && stats.removed === 0

  function optionLabel(version: Version): string {
    return version.id === CURRENT
      ? `Working copy · ${formatFull(version.createdAt)}`
      : `${version.label} · ${formatFull(version.createdAt)}`
  }

  return (
    <Modal
      title="Compare versions"
      subtitle={`Side-by-side system prompts for ${soul.name}. The working copy reflects unsaved edits to the soul.`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className="modal-foot-note">
            {identical
              ? 'No differences between these versions'
              : `${stats.added} line${stats.added === 1 ? '' : 's'} added · ${stats.removed} removed`}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {soul.history.length === 0 ? (
        <div className="empty-state">
          <span className="empty-sigil">
            <Icon name="diff" size={20} />
          </span>
          <h3>Nothing to compare yet</h3>
          <p>Take a snapshot of this soul first, then compare it against later edits.</p>
        </div>
      ) : (
        <>
          <div className="diff-controls">
            <label className="diff-picker">
              <span className="field-label">A · baseline</span>
              <select value={leftId} onChange={(event) => setLeftId(event.target.value)}>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {optionLabel(version)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="btn ghost icon diff-swap"
              title="Swap sides"
              aria-label="Swap sides"
              onClick={() => {
                setLeftId(rightId)
                setRightId(leftId)
              }}
            >
              <Icon name="swap" size={15} />
            </button>

            <label className="diff-picker">
              <span className="field-label">B · comparison</span>
              <select value={rightId} onChange={(event) => setRightId(event.target.value)}>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {optionLabel(version)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="diff-toolbar">
            <div className="segmented" role="group" aria-label="Diff display">
              <button
                type="button"
                className={onlyChanges ? '' : 'is-on'}
                aria-pressed={!onlyChanges}
                onClick={() => setOnlyChanges(false)}
              >
                Full prompt
              </button>
              <button
                type="button"
                className={onlyChanges ? 'is-on' : ''}
                aria-pressed={onlyChanges}
                onClick={() => setOnlyChanges(true)}
              >
                Changes only
              </button>
            </div>

            <div className="diff-legend">
              <span className="diff-swatch is-removed" aria-hidden="true" /> Removed
              <span className="diff-swatch is-added" aria-hidden="true" /> Added
            </div>
          </div>

          {identical ? (
            <div className="empty-state">
              <span className="empty-sigil">
                <Icon name="check" size={20} />
              </span>
              <h3>These versions are identical</h3>
              <p>Pick a different version on either side, or edit the soul and compare again.</p>
            </div>
          ) : (
          <div className="diff-table" role="table" aria-label="Side-by-side prompt diff">
            <div className="diff-row diff-columns" role="row">
              <span className="diff-no" />
              <div className="diff-col-head" role="columnheader">
                <strong>{left.label}</strong>
                <span>
                  {wordCount(left.prompt)} words · ≈ {estimateTokens(left.prompt)} tokens
                </span>
              </div>
              <span className="diff-no" />
              <div className="diff-col-head" role="columnheader">
                <strong>{right.label}</strong>
                <span>
                  {wordCount(right.prompt)} words · ≈ {estimateTokens(right.prompt)} tokens
                </span>
              </div>
            </div>

            {rows.map((row, index) =>
              row.kind === 'gap' ? (
                <div className="diff-gap" key={`gap-${index}`}>
                  ⋯ {row.hidden} unchanged line{row.hidden === 1 ? '' : 's'}
                </div>
              ) : (
                <DiffRowView row={row} key={`${row.kind}-${index}`} />
              ),
            )}
          </div>
          )}
        </>
      )}
    </Modal>
  )
}
