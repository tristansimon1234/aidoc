import { type ChangeEvent, useState, useRef, useEffect } from 'react'
import { Button, ProgressLoader, useConfirmDialog } from '../../../design-system/components/index.js'
import { api, type DocPageDTO } from '../../../shared/api/client.js'
import { useJobs } from '../../../shared/jobs/JobContext.js'
import styles from '../pages/PageView.module.css'

type Status = 'idle' | 'recording' | 'uploading' | 'analyzing' | 'extracting' | 'generating'

const MAX_RECORDING_SECONDS = 300 // 5 minutes max

/** DOM event captured by the Chrome extension's content script */
interface DomEvent {
  type: 'click' | 'input' | 'navigation' | 'scroll' | 'load'
  timestamp: number
  url: string
  selector?: string
  text?: string
  tagName?: string
  inputName?: string
  pageTitle?: string
}

/** Check if the AiDoc Chrome extension is installed */
function isExtensionInstalled(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).__AIDOC_EXTENSION__)
}

/** Request DOM capture start from the extension */
function extensionStartCapture(): void {
  window.postMessage({ type: 'AIDOC_START_DOM_CAPTURE' }, '*')
}

/** Request DOM capture stop from the extension and collect events */
function extensionStopCapture(): Promise<DomEvent[]> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent): void => {
      if (event.data?.type === 'AIDOC_DOM_EVENTS') {
        window.removeEventListener('message', handler)
        resolve(event.data.events as DomEvent[])
      }
    }
    window.addEventListener('message', handler)
    window.postMessage({ type: 'AIDOC_STOP_DOM_CAPTURE' }, '*')

    // Timeout fallback — don't block forever if extension doesn't respond
    setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve([])
    }, 3000)
  })
}

interface ScreenRecorderProps {
  projectId: string
  pageId: string
  page: DocPageDTO
  onComplete: () => Promise<void>
  hasExistingVoiceover?: boolean
}

export function ScreenRecorder({ pageId, page, onComplete, hasExistingVoiceover }: ScreenRecorderProps): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const { dialog: confirmDialog, confirm } = useConfirmDialog()
  const { addJob } = useJobs()
  const [elapsed, setElapsed] = useState(0)
  const [hasExtension, setHasExtension] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const domEventsRef = useRef<DomEvent[]>([])

  // Detect extension on mount
  useEffect(() => {
    setHasExtension(isExtensionInstalled())

    // Listen for late extension detection (extension might load after page)
    const handler = (event: MessageEvent): void => {
      if (event.data?.type === 'AIDOC_EXTENSION_READY') setHasExtension(true)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      displayStreamRef.current?.getTracks().forEach((t) => t.stop())
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const processVideo = async (file: File | Blob, fileName: string, domEvents?: DomEvent[]): Promise<void> => {
    if (hasExistingVoiceover) {
      const ok = await confirm({ title: 'Replace video?', message: 'The current video and voice-over will be permanently replaced.', confirmLabel: 'Replace', variant: 'danger' })
      if (!ok) return
    }
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
      const fileSize = file instanceof File ? file.size : (file as Blob).size
      console.log(`[upload] Starting: ${videoPath} (${(fileSize / 1024 / 1024).toFixed(1)}MB, ${mimeType})`)
      const { signedUrl } = await api.runs.getSignedUploadUrl(run.id, videoPath)
      const uploadRes = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file })
      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => uploadRes.statusText)
        throw new Error(`Upload failed (${uploadRes.status}): ${errText}`)
      }
      console.log(`[upload] Done: ${videoPath}`)

      // Upload DOM events if captured
      if (domEvents && domEvents.length > 0) {
        const eventsPath = `runs/${run.id}/dom-events.json`
        const eventsBlob = new Blob([JSON.stringify(domEvents)], { type: 'application/json' })
        const { signedUrl: eventsSignedUrl } = await api.runs.getSignedUploadUrl(run.id, eventsPath)
        await fetch(eventsSignedUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: eventsBlob })
      }

      // 3. Analyze + generate doc — entire pipeline runs server-side.
      // Responds 202 immediately so user can navigate freely.
      setStatus('analyzing')
      await api.runs.analyzeVideo(run.id, videoPath, { generateDoc: true })
      addJob({ runId: run.id, pageId, pageTitle: page.title, type: 'doc-gen', status: 'running' })

      await onComplete()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStatus('idle')
    }
  }

  const startRecording = async (): Promise<void> => {
    if (hasExistingVoiceover) {
      const ok = await confirm({ title: 'Replace video?', message: 'Recording a new video will replace the current video and voice-over.', confirmLabel: 'Record', variant: 'danger' })
      if (!ok) return
    }
    setError(null)
    try {
      // 1. Screen capture (video only — mic is separate)
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      })
      displayStreamRef.current = displayStream

      // 2. Mic capture (separate stream)
      let micStream: MediaStream | null = null
      if (micEnabled) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          micStreamRef.current = micStream
        } catch {
          // Mic denied — continue without it
          console.warn('[ScreenRecorder] Mic access denied, recording without audio')
        }
      }

      // 3. Combine video + mic into one stream
      const combinedStream = new MediaStream()
      displayStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t))
      if (micStream) {
        micStream.getAudioTracks().forEach((t) => combinedStream.addTrack(t))
      }

      chunksRef.current = []
      domEventsRef.current = []

      // 4. Detect supported format
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9'
          : MediaRecorder.isTypeSupported('video/webm')
            ? 'video/webm'
            : 'video/mp4'

      // Higher bitrate = more frequent keyframes = better seeking precision
      const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 3_000_000 })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        displayStream.getTracks().forEach((t) => t.stop())
        micStream?.getTracks().forEach((t) => t.stop())
        displayStreamRef.current = null
        micStreamRef.current = null

        // Collect DOM events from extension
        let domEvents: DomEvent[] = []
        if (hasExtension) {
          domEvents = await extensionStopCapture()
        }

        const blob = new Blob(chunksRef.current, { type: mimeType })
        if (blob.size > 0) {
          void processVideo(blob, `recording.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`, domEvents)
        }
      }

      // Stop recording if the user stops sharing their screen
      displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop()
        }
      })

      // 5. Start DOM capture via extension (if installed)
      if (hasExtension) {
        extensionStartCapture()
      }

      recorder.start(1000) // Collect data every second
      setStatus('recording')
      setElapsed(0)
      timerRef.current = setInterval(() => {
        setElapsed((e) => {
          const next = e + 1
          // Auto-stop at max duration
          if (next >= MAX_RECORDING_SECONDS) {
            mediaRecorderRef.current?.stop()
          }
          return next
        })
      }, 1000)
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

    if (file.size > 200 * 1024 * 1024) {
      setError('Video too large (max 200MB)')
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
            <span style={{ fontSize: 'var(--text-lg)', fontFamily: 'var(--font-mono)', color: elapsed >= MAX_RECORDING_SECONDS - 30 ? 'var(--color-destructive)' : 'var(--color-fg)', fontWeight: 600 }}>
              {formatTime(elapsed)} / {formatTime(MAX_RECORDING_SECONDS)}
            </span>
            {hasExtension && (
              <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-success)', padding: '2px 6px', background: 'rgba(0,200,0,0.1)', borderRadius: 'var(--radius-sm)' }}>
                DOM
              </span>
            )}
          </div>
          <Button variant="secondary" onClick={stopRecording}>
            Stop & Generate
          </Button>
        </div>
      </div>
    )
  }

  // Processing pipeline
  if (status === 'uploading' || status === 'analyzing' || status === 'extracting' || status === 'generating') {
    const pipelineSteps = [
      { label: 'Uploading video', estimatedSeconds: 5 },
      { label: 'Analyzing with AI', estimatedSeconds: 45 },
      { label: 'Extracting screenshots', estimatedSeconds: 10 },
      { label: 'Generating documentation', estimatedSeconds: 20 },
    ]
    const stepMap: Record<string, number> = { uploading: 0, analyzing: 1, extracting: 2, generating: 3 }
    return (
      <div className={styles.methodContent}>
        <ProgressLoader steps={pipelineSteps} activeStep={stepMap[status] ?? 0} />
      </div>
    )
  }

  // Idle — record + upload stacked vertically (dashed border style)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', height: '100%' }}>
      {confirmDialog}
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
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); setMicEnabled(!micEnabled) }} style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            background: micEnabled ? 'rgba(16, 185, 129, 0.1)' : 'var(--color-secondary)',
            border: `1px solid ${micEnabled ? 'var(--color-success)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-full)', cursor: 'pointer',
            fontSize: 'var(--text-xs)', fontFamily: 'var(--font-sans)', padding: '2px 10px',
            color: micEnabled ? 'var(--color-success)' : 'var(--color-muted-fg)',
            transition: 'all 0.15s',
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            </svg>
            {micEnabled ? 'Mic on' : 'Mic off'}
          </button>
        </span>
      </button>

      {/* Upload */}
      <label
        className={styles.dropZone}
        style={{ flex: 1 }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-fg)', marginBottom: 'var(--space-xs)' }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
        </svg>
        <span className={styles.dropZoneTitle}>Upload a video</span>
        <span className={styles.dropZoneHint}>.mp4, .webm, .mov — up to 200MB</span>
        <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => void handleFileUpload(e)}
          style={{ display: 'none' }} />
      </label>

      {error && <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive)', marginTop: 'var(--space-xs)' }}>{error}</p>}
    </div>
  )
}
