import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button.js'
import styles from './ConfirmDialog.module.css'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}

function DialogOverlay({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', variant = 'danger', onConfirm, onCancel }: ConfirmDialogProps): React.ReactElement {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return createPortal(
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={variant} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'primary'
}

/** Hook: returns { dialog, confirm } — render dialog in JSX, call confirm() which returns a Promise<boolean> */
export function useConfirmDialog(): {
  dialog: React.ReactNode
  confirm: (opts: ConfirmOptions) => Promise<boolean>
} {
  const [pending, setPending] = useState<{ opts: ConfirmDialogProps } | null>(null)

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({
          opts: {
            ...opts,
            onConfirm: () => { setPending(null); resolve(true) },
            onCancel: () => { setPending(null); resolve(false) },
          },
        })
      }),
    [],
  )

  const dialog = pending ? <DialogOverlay {...pending.opts} /> : null

  return { dialog, confirm }
}
