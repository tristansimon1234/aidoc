import { useState, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../../shared/api/client.js'
import styles from './VideoUploadBlock.module.css'

interface VideoUploadBlockProps {
  projectId: string
  pageId: string
  pageTitle: string
  pageSlug: string
}

type Step = 'idle' | 'uploading' | 'analyzing' | 'generating' | 'done' | 'error'

const STEP_LABELS: Record<Step, string> = {
  idle: '',
  uploading: 'Uploading video…',
  analyzing: 'Analyzing actions…',
  generating: 'Generating documentation…',
  done: 'Documentation ready',
  error: 'Something went wrong',
}

export function VideoUploadBlock({ projectId, pageId, pageTitle, pageSlug }: VideoUploadBlockProps): React.ReactElement {
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const runPipeline = useCallback(async (file: File): Promise<void> => {
    setError(null)
    setStep('uploading')
    try {
      // 1. Create a run scoped to this page
      const run = await api.runs.create({
        featureName: pageTitle,
        startUrl: '',
        goal: 'Document from screen recording',
        docPageId: pageId,
      })

      // 2. Get a signed URL and upload the video
      const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '.mp4'
      const videoPath = `runs/${run.id}/video${ext}`
      const { signedUrl } = await api.runs.getSignedUploadUrl(run.id, videoPath)
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'video/mp4' },
        body: file,
      })
      if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status})`)

      // 3. Kick off video analysis + doc generation (fire-and-forget on server)
      setStep('analyzing')
      await api.runs.analyzeVideo(run.id, videoPath, { generateDoc: true })

      setStep('done')
    } catch (err) {
      setError((err as Error).message)
      setStep('error')
    }
  }, [projectId, pageId, pageTitle])

  const handleFile = useCallback((file: File | null | undefined): void => {
    if (!file) return
    if (!file.type.startsWith('video/')) {
      setError('Please upload a video file.')
      return
    }
    void runPipeline(file)
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

  if (step === 'done') {
    return (
      <div className={styles.done}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <span>Documentation generated for <strong>{pageTitle}</strong></span>
        <Link
          to={`/projects/${projectId}/pages/${pageSlug}`}
          className={styles.viewLink}
        >
          View →
        </Link>
      </div>
    )
  }

  const isRunning = step !== 'idle' && step !== 'error'

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <span>Generate docs for <strong>{pageTitle}</strong></span>
      </div>

      {isRunning ? (
        <div className={styles.progress}>
          <div className={styles.spinner} aria-hidden="true" />
          <span>{STEP_LABELS[step]}</span>
        </div>
      ) : (
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
      )}

      {step === 'error' && error && (
        <p className={styles.errorMsg}>{error}</p>
      )}
    </div>
  )
}
