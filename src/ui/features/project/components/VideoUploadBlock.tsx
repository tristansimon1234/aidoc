import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../../shared/api/client.js'
import styles from './VideoUploadBlock.module.css'

interface VideoUploadBlockProps {
  projectId: string
  pageId: string
  pageTitle: string
  pageSlug: string
  /** Pre-claim a file (e.g. dropped on the chat bar). Auto-starts the
   *  pipeline on mount when set. */
  preselectedFile?: File | null
}

type Step = 'idle' | 'uploading' | 'analyzing' | 'done' | 'error' | 'cancelled'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Upload a file via XMLHttpRequest so we can report real progress. */
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4')
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed (${xhr.status})`))
    })
    xhr.addEventListener('error', () => reject(new Error('Upload network error')))
    xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}

export function VideoUploadBlock({
  projectId,
  pageId,
  pageTitle,
  pageSlug,
  preselectedFile,
}: VideoUploadBlockProps): React.ReactElement {
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [uploadPct, setUploadPct] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const startedRef = useRef(false)

  const runPipeline = useCallback(async (f: File): Promise<void> => {
    setError(null)
    setFile(f)
    setUploadPct(0)
    setStep('uploading')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // 1. Create a run scoped to this page
      const run = await api.runs.create({
        featureName: pageTitle,
        startUrl: '',
        goal: 'Document from screen recording',
        docPageId: pageId,
      })

      // 2. Get a signed URL and upload the video (with real progress)
      const ext = f.name.includes('.') ? f.name.substring(f.name.lastIndexOf('.')) : '.mp4'
      const videoPath = `runs/${run.id}/video${ext}`
      const { signedUrl } = await api.runs.getSignedUploadUrl(run.id, videoPath)
      await uploadWithProgress(signedUrl, f, setUploadPct, controller.signal)

      // 3. Kick off video analysis + doc generation (fire-and-forget on server)
      setStep('analyzing')
      await api.runs.analyzeVideo(run.id, videoPath, { generateDoc: true })

      setStep('done')
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStep('cancelled')
        return
      }
      setError((err as Error).message)
      setStep('error')
    } finally {
      abortRef.current = null
    }
  }, [pageId, pageTitle])

  // Auto-start the pipeline when a file was pre-claimed by a drop
  useEffect(() => {
    if (preselectedFile && !startedRef.current && step === 'idle') {
      startedRef.current = true
      void runPipeline(preselectedFile)
    }
  }, [preselectedFile, step, runPipeline])

  // Cancel in-flight pipeline when unmounted
  useEffect(() => () => abortRef.current?.abort(), [])

  const handleCancel = (): void => {
    abortRef.current?.abort()
  }

  const handleRetry = (): void => {
    if (file) void runPipeline(file)
  }

  const handleFile = useCallback((picked: File | null | undefined): void => {
    if (!picked) return
    if (!picked.type.startsWith('video/')) {
      setError('Please pick a video file.')
      setStep('error')
      return
    }
    void runPipeline(picked)
  }, [runPipeline])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files[0])
  }, [handleFile])

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = (): void => setDragOver(false)

  // --- DONE state ---
  if (step === 'done') {
    return (
      <div className={`${styles.block} ${styles.blockDone}`}>
        <div className={styles.statusRow}>
          <span className={styles.iconCircle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <div className={styles.statusText}>
            <div className={styles.statusTitle}>Documentation ready</div>
            <div className={styles.statusSubtitle}>Generated for {pageTitle}</div>
          </div>
          <Link to={`/projects/${projectId}/pages/${pageSlug}`} className={styles.viewLink}>
            View →
          </Link>
        </div>
      </div>
    )
  }

  // --- IDLE state (drop zone) ---
  if (step === 'idle') {
    return (
      <div className={styles.block}>
        <div className={styles.header}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
          <span>Generate docs for <strong>{pageTitle}</strong></span>
        </div>
        <div
          className={`${styles.dropzone} ${dragOver ? styles.dropzoneActive : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
          aria-label="Upload a video to generate documentation"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className={styles.dropLabel}>Drop a video or click to browse</p>
          <p className={styles.dropHint}>MP4, WebM, MOV — max 300 MB</p>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className={styles.hiddenInput}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      </div>
    )
  }

  // --- RUNNING / ERROR / CANCELLED states — show file info + progress ---
  return (
    <div className={`${styles.block} ${step === 'error' ? styles.blockError : ''}`}>
      <div className={styles.header}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <span>Generate docs for <strong>{pageTitle}</strong></span>
      </div>

      {file && (
        <div className={styles.fileRow}>
          <span className={styles.fileName}>{file.name}</span>
          <span className={styles.fileSize}>{formatBytes(file.size)}</span>
        </div>
      )}

      {step === 'uploading' && (
        <>
          <div className={styles.progressBarWrap}>
            <div className={styles.progressBar} style={{ width: `${uploadPct}%` }} />
          </div>
          <div className={styles.progressRow}>
            <span className={styles.progressLabel}>
              <span className={styles.spinnerDot} aria-hidden="true" />
              Uploading… {uploadPct}%
            </span>
            <button type="button" className={styles.cancelBtn} onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === 'analyzing' && (
        <div className={styles.progressRow}>
          <span className={styles.progressLabel}>
            <span className={styles.spinnerDot} aria-hidden="true" />
            Analyzing & generating documentation… (may take 1-2 min)
          </span>
        </div>
      )}

      {step === 'error' && (
        <div className={styles.errorRow}>
          <span className={styles.errorMsg}>{error ?? 'Something went wrong.'}</span>
          <button type="button" className={styles.retryBtn} onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}

      {step === 'cancelled' && (
        <div className={styles.errorRow}>
          <span className={styles.errorMsg}>Cancelled.</span>
          <button type="button" className={styles.retryBtn} onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
