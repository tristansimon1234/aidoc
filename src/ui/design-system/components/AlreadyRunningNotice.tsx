import { createPortal } from 'react-dom'
import { Button } from './Button.js'
import type { AlreadyRunningDetails } from '../../shared/api/client.js'
import styles from './ConfirmDialog.module.css'

interface AlreadyRunningNoticeProps {
  details: AlreadyRunningDetails
  /** Optional: called when the user wants to cancel the teammate's run via
   *  the existing JobTracker "Cancel" flow. If omitted, the dialog shows a
   *  single "OK" button instead. */
  onCancelPeer?: () => void
  onClose: () => void
}

const JOB_LABELS: Record<AlreadyRunningDetails['jobType'], { title: string; verb: string }> = {
  'exploration': {
    title: 'An exploration is already running',
    verb: 'is exploring this page',
  },
  'doc-gen': {
    title: 'A documentation generation is already running',
    verb: 'is generating the documentation',
  },
  'voiceover': {
    title: 'A voice-over generation is already running',
    verb: 'is generating the voice-over',
  },
  'try-doc-analysis': {
    title: 'A Try Doc analysis is already running',
    verb: 'is running a Try Doc analysis',
  },
  'index': {
    title: 'A re-index is already running',
    verb: 'is re-indexing this workspace',
  },
}

function timeAgo(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  if (delta < 30_000) return 'a few seconds ago'
  const mins = Math.round(delta / 60_000)
  if (mins < 1) return 'less than a minute ago'
  if (mins === 1) return '1 minute ago'
  return `${mins} minutes ago`
}

/**
 * Shared UI for the RUN_ALREADY_RUNNING 409. Surfaces WHO started the
 * blocking job and WHEN, so the second caller can either wait or ask
 * them to cancel. Previously each route rendered its own ad-hoc error
 * string; this keeps the language consistent (and translatable later).
 */
export function AlreadyRunningNotice({ details, onCancelPeer, onClose }: AlreadyRunningNoticeProps): React.ReactElement {
  const label = JOB_LABELS[details.jobType] ?? { title: 'An operation is already running', verb: 'is running an operation' }
  const who = details.triggeredByName ?? 'A teammate'
  const when = timeAgo(details.runningSince)

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{label.title}</h3>
        <p className={styles.message}>
          <strong>{who}</strong> {label.verb}, started {when}. Wait for it to finish{onCancelPeer ? ', or cancel theirs to take over' : ''}.
        </p>
        <div className={styles.actions}>
          {onCancelPeer && (
            <Button variant="danger" size="sm" onClick={onCancelPeer}>Cancel their run</Button>
          )}
          <Button variant="primary" size="sm" onClick={onClose}>OK</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
