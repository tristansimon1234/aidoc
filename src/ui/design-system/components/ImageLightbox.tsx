import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './ImageLightbox.module.css'

interface ImageLightboxProps {
  src: string
  onClose: () => void
}

function LightboxOverlay({ src, onClose }: ImageLightboxProps): React.ReactElement {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <button className={styles.close} onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
      <img
        className={styles.image}
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  )
}

/** Hook that returns { lightbox, openLightbox } — render lightbox in your JSX, call openLightbox(src) on click */
export function useImageLightbox(): { lightbox: React.ReactNode; openLightbox: (src: string) => void } {
  const [src, setSrc] = useState<string | null>(null)
  const close = useCallback(() => setSrc(null), [])
  const lightbox = src ? <LightboxOverlay src={src} onClose={close} /> : null
  return { lightbox, openLightbox: setSrc }
}
