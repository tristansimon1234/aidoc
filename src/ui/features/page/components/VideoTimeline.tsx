import { useState, useRef, useCallback } from 'react'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { api } from '../../../shared/api/client.js'
import type { VoiceoverSegment } from './NarratedPlayer.js'

interface VideoTimelineProps {
  runId: string
  duration: number
  segments: VoiceoverSegment[]
  voiceId?: string
  onSegmentsChange: (segments: VoiceoverSegment[]) => void
  onVideoTrimmed?: (videoUrl: string) => void
  onAudioUrlChange?: (audioUrl: string) => void
}

const TRACK_H = 32

export function VideoTimeline({ runId, duration, segments, voiceId, onSegmentsChange, onVideoTrimmed, onAudioUrlChange }: VideoTimelineProps): React.ReactElement {
  const [dragging, setDragging] = useState<number | null>(null)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(duration)
  const [trimming, setTrimming] = useState(false)
  const [saving, setSaving] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const toPct = useCallback((t: number) => duration > 0 ? (t / duration) * 100 : 0, [duration])

  if (!duration || !isFinite(duration) || duration <= 0) return <></>

  const handleDragStart = (idx: number, e: React.MouseEvent): void => {
    e.preventDefault()
    setDragging(idx)
    const seg = segments[idx]!
    const startX = e.clientX
    const origStart = seg.startTime
    const segDur = seg.endTime - seg.startTime

    const onMove = (me: MouseEvent): void => {
      if (!trackRef.current) return
      const w = trackRef.current.getBoundingClientRect().width
      const dt = ((me.clientX - startX) / w) * duration
      const ns = Math.max(0, Math.min(duration - segDur, origStart + dt))
      onSegmentsChange(segments.map((s, i) => i === idx ? { ...s, startTime: ns, endTime: ns + segDur } : s))
    }
    const onUp = (): void => {
      setDragging(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      void saveTiming()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const saveTiming = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.runs.updateSegmentTiming(runId, segments.map((s) => ({ stepIndex: s.stepIndex, startTime: s.startTime, endTime: s.endTime })))
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  const handleRegenerate = async (idx: number): Promise<void> => {
    setRegeneratingIdx(idx)
    try {
      const text = editingIdx === idx ? editText : undefined
      const result = await api.runs.regenerateSegment(runId, segments[idx]!.stepIndex, text, voiceId) as { stepIndex: number; audioUrl?: string; text: string }
      onSegmentsChange(segments.map((s, i) => i === idx ? { ...s, text: result.text } : s))
      if (result.audioUrl) onAudioUrlChange?.(result.audioUrl)
      setEditingIdx(null)
    } catch { /* ignore */ }
    finally { setRegeneratingIdx(null) }
  }

  const handleTrim = async (): Promise<void> => {
    if (trimStart >= trimEnd) return
    setTrimming(true)
    try {
      const result = await api.runs.trimVideo(runId, trimStart, trimEnd)
      onVideoTrimmed?.(result.videoUrl)
    } catch { /* ignore */ }
    finally { setTrimming(false) }
  }

  const handleTrimDrag = (handle: 'start' | 'end', e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const origVal = handle === 'start' ? trimStart : trimEnd

    const onMove = (me: MouseEvent): void => {
      if (!trackRef.current) return
      const w = trackRef.current.getBoundingClientRect().width
      const dt = ((me.clientX - startX) / w) * duration
      const nv = Math.max(0, Math.min(duration, origVal + dt))
      if (handle === 'start') setTrimStart(Math.min(nv, trimEnd - 1))
      else setTrimEnd(Math.max(nv, trimStart + 1))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const fmt = (t: number): string => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`

  const colors = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#6366F1', '#EF4444', '#14B8A6']

  return (
    <div style={{ padding: 'var(--space-md)', borderTop: '1px solid var(--color-border)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)' }}>
          timeline — {segments.length} segments — {fmt(duration)}
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}>
          {saving && <span style={{ fontSize: 10, color: 'var(--color-muted-fg)' }}>Saving...</span>}
          {trimming ? (
            <><Spinner size="sm" /><span style={{ fontSize: 10, color: 'var(--color-muted-fg)' }}>Trimming...</span></>
          ) : (
            (trimStart > 0.5 || trimEnd < duration - 0.5) && (
              <Button size="sm" variant="secondary" onClick={() => void handleTrim()}>
                Cut to {fmt(trimStart)} — {fmt(trimEnd)}
              </Button>
            )
          )}
        </div>
      </div>

      {/* Timeline tracks */}
      <div ref={trackRef} style={{ position: 'relative', height: 100, background: 'var(--color-secondary)', borderRadius: 'var(--radius-md)', overflow: 'visible' }}>
        {/* Time markers */}
        {Array.from({ length: Math.ceil(duration / 30) + 1 }, (_, i) => i * 30).map((t) => (
          <div key={t} style={{ position: 'absolute', left: `${toPct(t)}%`, top: 0, height: '100%', borderLeft: '1px solid var(--color-border)', pointerEvents: 'none' }}>
            <span style={{ position: 'absolute', top: 2, left: 3, fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)' }}>{fmt(t)}</span>
          </div>
        ))}

        {/* Video track */}
        <div style={{ position: 'absolute', top: 8, left: 0, right: 0, height: TRACK_H, background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--radius-sm)' }}>
          <span style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: 'var(--color-muted-fg)', fontFamily: 'var(--font-mono)' }}>video</span>
        </div>

        {/* Trim overlay — darkens areas outside trim range */}
        {(trimStart > 0.5 || trimEnd < duration - 0.5) && (
          <>
            <div style={{ position: 'absolute', top: 0, left: 0, width: `${toPct(trimStart)}%`, height: '100%', background: 'rgba(0,0,0,0.4)', pointerEvents: 'none', borderRadius: 'var(--radius-md) 0 0 var(--radius-md)' }} />
            <div style={{ position: 'absolute', top: 0, right: 0, width: `${100 - toPct(trimEnd)}%`, height: '100%', background: 'rgba(0,0,0,0.4)', pointerEvents: 'none', borderRadius: '0 var(--radius-md) var(--radius-md) 0' }} />
          </>
        )}

        {/* Trim handles */}
        <div
          onMouseDown={(e) => handleTrimDrag('start', e)}
          style={{
            position: 'absolute', top: 0, left: `${toPct(trimStart)}%`, width: 8, height: '100%',
            cursor: 'ew-resize', zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            transform: 'translateX(-4px)',
          }}
        >
          <div style={{ width: 3, height: 24, borderRadius: 2, background: 'var(--color-primary)' }} />
        </div>
        <div
          onMouseDown={(e) => handleTrimDrag('end', e)}
          style={{
            position: 'absolute', top: 0, left: `${toPct(trimEnd)}%`, width: 8, height: '100%',
            cursor: 'ew-resize', zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            transform: 'translateX(-4px)',
          }}
        >
          <div style={{ width: 3, height: 24, borderRadius: 2, background: 'var(--color-primary)' }} />
        </div>

        {/* Narration segments */}
        {segments.map((seg, idx) => {
          const left = toPct(seg.startTime)
          const width = toPct(seg.endTime - seg.startTime)
          const color = colors[idx % colors.length]!
          return (
            <div
              key={seg.stepIndex}
              onMouseDown={(e) => handleDragStart(idx, e)}
              style={{
                position: 'absolute', top: 56, left: `${left}%`, width: `${Math.max(width, 1.5)}%`, height: TRACK_H,
                background: `${color}33`, border: `1.5px solid ${color}`, borderRadius: 'var(--radius-sm)',
                cursor: dragging === idx ? 'grabbing' : 'grab',
                display: 'flex', alignItems: 'center', padding: '0 4px', overflow: 'hidden',
                transition: dragging === idx ? 'none' : 'left 0.1s',
                zIndex: dragging === idx ? 10 : 1,
              }}
            >
              <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color, whiteSpace: 'nowrap' }}>{idx + 1}</span>
            </div>
          )
        })}

        <span style={{ position: 'absolute', left: 4, top: 60, fontSize: 9, color: 'var(--color-muted-fg)', fontFamily: 'var(--font-mono)', pointerEvents: 'none' }}>narration</span>
      </div>

      {/* Segment list — edit text + regenerate */}
      <div style={{ marginTop: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {segments.map((seg, idx) => {
          const color = colors[idx % colors.length]!
          const isEditing = editingIdx === idx
          return (
            <div key={seg.stepIndex} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: '3px var(--space-sm)',
              borderRadius: 'var(--radius-sm)', background: isEditing ? 'var(--color-secondary)' : 'transparent',
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                background: `${color}33`, border: `1.5px solid ${color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontFamily: 'var(--font-mono)', color,
              }}>{idx + 1}</span>

              <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', flexShrink: 0, minWidth: 65 }}>
                {fmt(seg.startTime)} — {fmt(seg.endTime)}
              </span>

              {isEditing ? (
                <input type="text" value={editText} onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRegenerate(idx) }}
                  style={{ flex: 1, fontSize: 11, padding: '2px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-fg)', fontFamily: 'var(--font-sans)', outline: 'none' }}
                  autoFocus />
              ) : (
                <span onClick={() => { setEditingIdx(idx); setEditText(seg.text ?? '') }}
                  style={{ flex: 1, fontSize: 11, color: 'var(--color-fg)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title="Click to edit">
                  {seg.text ?? `Step ${idx + 1}`}
                </span>
              )}

              {regeneratingIdx === idx ? <Spinner size="sm" /> : (
                <button type="button" onClick={() => void handleRegenerate(idx)} title={isEditing ? 'Regenerate with new text' : 'Regenerate'} style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 2, flexShrink: 0,
                  color: isEditing ? 'var(--color-primary)' : 'var(--color-muted-fg)', display: 'flex',
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
                  </svg>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
