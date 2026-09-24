import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginDisabled, signOut } from '../../supabase'
import styles from './AvatarMenu.module.css'

export function AvatarMenu({ email }: { email: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Ferme le menu au clic extérieur ou sur Échap.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        className={styles.avatar}
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
      >
        {(email[0] ?? '?').toUpperCase()}
      </button>

      {open && (
        <div ref={menuRef} className={styles.menu} role="menu">
          <div className={styles.header}>{email}</div>

          <button className={styles.item} role="menuitem" onClick={() => go('/credits')}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
            </svg>
            <span>Credits and invoices</span>
          </button>

          {!loginDisabled && (
            <>
              <div className={styles.divider} />

              <button className={styles.item} role="menuitem" onClick={() => void signOut()}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                <span>Sign out</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
