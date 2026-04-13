import { type ChangeEvent, useState, useRef, useEffect } from 'react'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { api, type DocPageDTO } from '../../../shared/api/client.js'
import { updatePage as dbUpdatePage } from '../../../shared/api/db.js'
import styles from '../pages/PageView.module.css'

type Status = 'idle' | 'recording' | 'uploading' | 'analyzing' | 'extracting' | 'generating' | 'voiceover'

interface ScreenRecorderProps {
  projectId: string
  pageId: string
  page: DocPageDTO
  onComplete: () => Promise<void>
}

export function ScreenRecorder({ projectId, pageId, page, onComplete }: ScreenRecorderProps): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const processVideo = async (file: File | Blob, fileName: string): Promise<void> => {
    setError(null)
    try {
      // 1. Create a run
      const run = await api.runs.create({
        featureName: page.title,
        startUrl: page.startUrl ?? '',
        goal: page.goal || 'Document from screen recording',
        docPageId: pageId,
      })

      // 2. Upload video
      setStatus('uploading')
      const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '.webm'
      const videoPath = `runs/${run.id}/video${ext}`
      const mimeType = file instanceof File ? file.type : 'video/webm'
      const { signedUrl } = await api.runs.getSignedUploadUrl(run.id, videoPath)
      const uploadRes = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file })
      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.statusText}`)

      // 3. Analyze with Gemini
      setStatus('analyzing')
      const { timestamps } = await api.runs.analyzeVideo(run.id, videoPath)

      // 4. Extract frames at timestamps
      setStatus('extracting')
      const videoFile = file instanceof File ? file : new File([file], fileName, { type: 'video/webm' })
      await extractAndUploadFrames(videoFile, run.id, timestamps)

      // 5. Generate documentation
      setStatus('generating')
      await api.runs.generateDoc(run.id)
      await dbUpdatePage(projectId, pageId, { status: 'published' })

      // 6. Generate voice-over (fire-and-forget — don't block the flow)
      setStatus('voiceover')
      await api.runs.generateVoiceover(run.id).catch(() => {
        // Voice-over is optional — don't fail the whole flow
      })

      await onComplete()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStatus('idle')
    }
  }

  const startRecording = async (): Promise<void> => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      })
      streamRef.current = stream
      chunksRef.current = []

      // Detect supported format
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : 'video/mp4'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        const blob = new Blob(chunksRef.current, { type: mimeType })
        if (blob.size > 0) {
          void processVideo(blob, `recording.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`)
        }
      }

      // Stop recording if the user stops sharing their screen
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop()
        }
      })

      recorder.start(1000) // Collect data every second
      setStatus('recording')
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } catch (err) {
      // User cancelled the screen picker — not an error
      if ((err as Error).name !== 'NotAllowedError') {
        setError((err as Error).message)
      }
    }
  }

  const stopRecording = (): void => {
    mediaRecorderRef.current?.stop()
  }

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 500 * 1024 * 1024) {
      setError('Video too large (max 500MB)')
      return
    }

    await processVideo(file, file.name)
  }

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  // Recording in progress
  if (status === 'recording') {
    return (
      <div className={styles.methodContent}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-lg)',
          background: 'var(--color-card)',
          border: '2px solid var(--color-destructive)',
          borderRadius: 'var(--radius-xl)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <span style={{
              width: 12, height: 12, borderRadius: '50%',
              backgroundColor: 'var(--color-destructive)',
              animation: 'pulse 1.5s infinite',
            }} />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg)', fontWeight: 500 }}>
              Recording...
            </span>
            <span style={{ fontSize: 'var(--text-lg)', fontFamily: 'var(--font-mono)', color: 'var(--color-fg)', fontWeight: 600 }}>
              {formatTime(elapsed)}
            </span>
          </div>
          <Button variant="secondary" onClick={stopRecording}>
            Stop & Generate
          </Button>
        </div>
      </div>
    )
  }

  // Processing pipeline
  if (status !== 'idle') {
    return (
      <div className={styles.methodContent}>
        <div className={styles.methodProgress}>
          <Spinner size="sm" />
          <span>
            {status === 'uploading' && 'Uploading video...'}
            {status === 'analyzing' && 'Analyzing video with AI \u2014 this may take a minute...'}
            {status === 'extracting' && 'Extracting screenshots...'}
            {status === 'generating' && 'Generating documentation...'}
            {status === 'voiceover' && 'Generating voice-over...'}
          </span>
        </div>
      </div>
    )
  }

  // Idle — show record button + file upload
  return (
    <div className={styles.methodContent}>
      <div className={styles.methodInfo}>
        <div className={styles.methodInfoText}>
          <p className={styles.methodInfoDesc}>
            Record your screen or upload a video. AI watches every click, extracts screenshots at key moments, and writes step-by-step documentation with voice-over narration.
          </p>
          <div className={styles.methodInfoTags}>
            <span className={styles.methodTag}>.mp4, .webm, .mov</span>
            <span className={styles.methodTag}>up to 500MB</span>
            <span className={styles.methodTag}>auto voice-over</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'stretch' }}>
        {/* Record button */}
        <button
          type="button"
          onClick={() => void startRecording()}
          style={{
            flex: 1,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 'var(--space-sm)', padding: 'var(--space-xl)',
            background: 'var(--color-card)', border: '2px dashed var(--color-border)',
            borderRadius: 'var(--radius-xl)', cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-destructive)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.transform = 'none' }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="var(--color-destructive)" stroke="none">
            <circle cx="12" cy="12" r="8" />
          </svg>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)' }}>
            Record Screen
          </span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>
            Click to start capturing
          </span>
        </button>

        {/* Upload fallback */}
        <label
          className={styles.dropZone}
          style={{ flex: 1 }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-primary)', marginBottom: 'var(--space-xs)' }}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
          </svg>
          <span className={styles.dropZoneTitle}>Upload a video</span>
          <span className={styles.dropZoneHint}>or drop a file here</span>
          <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => void handleFileUpload(e)}
            style={{ display: 'none' }} />
        </label>
      </div>

      {error && <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive)', marginTop: 'var(--space-sm)' }}>{error}</p>}
    </div>
  )
}

// Extract frames from video at exact timestamps and upload as screenshots
async function extractAndUploadFrames(videoFile: File, runId: string, timestamps: number[]): Promise<void> {
  if (timestamps.length === 0) return

  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) { resolve(); return }

    video.onloadedmetadata = () => {
      canvas.width = Math.min(video.videoWidth, 1280)
      canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth))

      let i = 0

      const extractNext = (): void => {
        if (i >= timestamps.length) { resolve(); return }
        video.currentTime = timestamps[i]!
      }

      video.onseeked = () => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const stepIndex = i
        canvas.toBlob(async (blob) => {
          if (blob) {
            const path = `runs/${runId}/frame-${stepIndex}.jpg`
            const { signedUrl } = await api.runs.getSignedUploadUrl(runId, path)
            await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
            await api.runs.updateStepScreenshot(runId, stepIndex, path)
          }
          i++
          extractNext()
        }, 'image/jpeg', 0.8)
      }

      video.onerror = () => reject(new Error('Failed to load video'))
      extractNext()
    }

    video.onerror = () => reject(new Error('Failed to load video'))
    video.src = URL.createObjectURL(videoFile)
  })
}
