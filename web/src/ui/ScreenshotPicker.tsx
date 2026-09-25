import { useEffect, useMemo, useState, type DragEvent } from 'react'
import styles from './ScreenshotPicker.module.css'

/** Dépôt des captures du produit (vidéo marketing) : glisser-déposer ou sélection, aperçus, retrait. */
export function ScreenshotPicker({
  files,
  max,
  onChange,
}: {
  files: File[]
  max: number
  onChange: (files: File[]) => void
}) {
  const [dragging, setDragging] = useState(false)
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews])

  function add(list: FileList | null) {
    const images = Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
    if (images.length > 0) onChange([...files, ...images].slice(0, max))
  }

  function drop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    add(e.dataTransfer.files)
  }

  return (
    <div className={styles.picker}>
      {files.length < max && (
        <label
          className={`${styles.zone} ${dragging ? styles.dragging : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
          </svg>
          <span className={styles.zoneTitle}>Add screenshots of your product</span>
          <span className={styles.zoneHint}>
            PNG, JPG, WebP · up to {max} · drop them here or click
          </span>
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      )}

      {files.length > 0 && (
        <ul className={styles.grid}>
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`} className={styles.thumb}>
              <img src={previews[i]} alt={file.name} />
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${file.name}`}
                onClick={() => onChange(files.filter((_, k) => k !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
