import type { Soul } from '../types'
import { formatFull } from '../lib/format'
import { estimateTokens, SNAPSHOT_LIMIT, wordCount } from '../lib/soul'
import { Icon } from './Icons'
import { Modal } from './Modal'

export function HistoryDialog({
  soul,
  onRestore,
  onDelete,
  onCompare,
  onSnapshot,
  onClose,
}: {
  soul: Soul
  onRestore: (snapshotId: string) => void
  onDelete: (snapshotId: string) => void
  onCompare: (snapshotId?: string) => void
  onSnapshot: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title="Version history"
      subtitle={`Snapshots of ${soul.name}. Restoring replaces the current soul fields; comparing shows any two prompts side by side.`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="modal-foot-note">
            {soul.history.length} of {SNAPSHOT_LIMIT} kept
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={soul.history.length === 0}
            onClick={() => onCompare()}
          >
            <Icon name="diff" size={14} /> Compare
          </button>
          <button type="button" className="btn primary" onClick={onSnapshot}>
            <Icon name="plus" size={14} /> Snapshot current
          </button>
        </>
      }
    >
      {soul.history.length === 0 ? (
        <div className="empty-state">
          <span className="empty-sigil">
            <Icon name="clock" size={20} />
          </span>
          <h3>No snapshots yet</h3>
          <p>
            Take a snapshot before a big rewrite. You can also press{' '}
            <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd> + <kbd>S</kbd> anywhere
            in the editor.
          </p>
        </div>
      ) : (
        <ul className="history-list">
          {soul.history.map((snapshot) => (
            <li key={snapshot.id}>
              <div className="history-meta">
                <strong>{snapshot.label}</strong>
                <span>{formatFull(snapshot.createdAt)}</span>
              </div>
              <p className="history-preview">{snapshot.prompt}</p>
              <div className="history-foot">
                <span className="pill">
                  {wordCount(snapshot.prompt)} words · ≈ {estimateTokens(snapshot.prompt)} tokens
                </span>
                <div className="history-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onCompare(snapshot.id)}
                  >
                    <Icon name="diff" size={13} /> Compare
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onRestore(snapshot.id)}
                  >
                    <Icon name="refresh" size={13} /> Restore
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm danger-text"
                    onClick={() => onDelete(snapshot.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
