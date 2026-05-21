import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './Modal.module.css'

interface ModalProps {
  title?: string
  /** Subtitle / context line under the title. */
  subtitle?: string
  /** Size variant. `lg` for action flows (Generate / Marketing video), `md` default. */
  size?: 'md' | 'lg' | 'xl'
  /** Disable backdrop close (e.g. while a job is firing). */
  dismissible?: boolean
  onClose: () => void
  children: React.ReactNode
  /** Optional footer slot (action buttons). */
  footer?: React.ReactNode
}

export function Modal({
  title,
  subtitle,
  size = 'md',
  dismissible = true,
  onClose,
  children,
  footer,
}: ModalProps): React.ReactElement {
  useEffect(() => {
    if (!dismissible) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dismissible, onClose])

  const sizeClass = size === 'xl' ? styles.dialogXl : size === 'lg' ? styles.dialogLg : styles.dialogMd

  return createPortal(
    <div
      className={styles.overlay}
      onClick={dismissible ? onClose : undefined}
    >
      <div
        className={`${styles.dialog} ${sizeClass}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {(title || dismissible) && (
          <div className={styles.header}>
            <div>
              {title && <h3 className={styles.title}>{title}</h3>}
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            {dismissible && (
              <button
                type="button"
                className={styles.close}
                onClick={onClose}
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
