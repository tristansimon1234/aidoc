import { useState, useRef, useCallback } from 'react'
import { Spinner } from '../../../design-system/components/index.js'
import { api } from '../../../shared/api/client.js'
import type { VoiceoverSegment } from './NarratedPlayer.js'

interface VideoTimelineProps {
  runId: string
  duration: number
  segments: VoiceoverSegment[]
  onSegmentsChange: (segments: VoiceoverSegment[]) => void
}

const TRACK_HEIGHT = 36
const TIMELINE_HEIGHT = 120

/**
 * Mini timeline editor for narrated videos.
 * Shows the video duration with audio segments as draggable blocks.
 * Users can drag segments to adjust timing, regenerate individual
 * segments, and edit narration text.
 */
export function VideoTimeline({ runId, duration, segments, onSegmentsChange }: VideoTimelineProps): React.ReactElement {
  const [dragging, setDragging] = useState<number | null>(null)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const timeToPercent = useCallback((t: number) => duration > 0 ? (t / duration) * 100 : 0, [duration])

  const handleDragStart = (idx: number, e: React.MouseEvent): void => {
    e.preventDefault()
    setDragging(idx)
    const seg = segments[idx]!
    const startX = e.clientX
    const origStart = seg.startTime
    const segDuration = seg.endTime - seg.startTime

    const onMove = (moveE: MouseEvent): void => {
      if (!trackRef.current) return
      const trackWidth = trackRef.current.getBoundingClientRect().width
      const dx = moveE.clientX - startX
      const dt = (dx / trackWidth) * duration
      const newStart = Math.max(0, Math.min(duration - segDuration, origStart + dt))
      const updated = segments.map((s, i) =>
        i === idx ? { ...s, startTime: newStart, endTime: newStart + segDuration } : s,
      )
      onSegmentsChange(updated)
    }

    const onUp = (): void => {
      setDragging(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Save to backend
      void saveTimingToBackend()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const saveTimingToBackend = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.runs.updateSegmentTiming(
        runId,
        segments.map((s) => ({ stepIndex: s.stepIndex, startTime: s.startTime, endTime: s.endTime })),
      )
    } catch {
      // Timing save failed — segments still updated locally
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerate = async (idx: number): Promise<void> => {
    const seg = segments[idx]!
    setRegeneratingIdx(idx)
    try {
      const text = editingIdx === idx ? editText : undefined
      const result = await api.runs.regenerateSegment(runId, seg.stepIndex, text)
      const updated = segments.map((s, i) =>
        i === idx ? { ...s, audioUrl: result.audioUrl, text: result.text } : s,
      )
      onSegmentsChange(updated)
      setEditingIdx(null)
    } catch {
      // ignore
    } finally {
      setRegeneratingIdx(null)
    }
  }

  const formatTime = (t: number): string => {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // Color palette for segments
  const colors = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#6366F1', '#EF4444', '#14B8A6']

  return (
    <div style={{
      background: 'var(--color-card)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-md)',
      marginTop: 'var(--space-sm)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
        <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)' }}>
          timeline — {segments.length} segments — {formatTime(duration)}
        </span>
        {saving && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>Saving...</span>}
      </div>

      {/* Timeline track */}
      <div
        ref={trackRef}
        style={{
          position: 'relative',
          height: TIMELINE_HEIGHT,
          background: 'var(--color-secondary)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}
      >
        {/* Time markers */}
        {Array.from({ length: Math.ceil(duration / 30) + 1 }, (_, i) => i * 30).map((t) => (
          <div key={t} style={{
            position: 'absolute',
            left: `${timeToPercent(t)}%`,
            top: 0,
            height: '100%',
            borderLeft: '1px solid var(--color-border)',
            pointerEvents: 'none',
          }}>
            <span style={{
              position: 'absolute', top: 2, left: 4,
              fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)',
            }}>
              {formatTime(t)}
            </span>
          </div>
        ))}

        {/* Video track (background bar) */}
        <div style={{
          position: 'absolute', top: 8, left: 0, right: 0, height: TRACK_HEIGHT,
          background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--radius-sm)',
        }}>
          <span style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: 'var(--color-muted-fg)', fontFamily: 'var(--font-mono)' }}>
            video
          </span>
        </div>

        {/* Audio segments (draggable blocks) */}
        {segments.map((seg, idx) => {
          const left = timeToPercent(seg.startTime)
          const width = timeToPercent(seg.endTime - seg.startTime)
          const color = colors[idx % colors.length]!
          return (
            <div
              key={seg.stepIndex}
              onMouseDown={(e) => handleDragStart(idx, e)}
              style={{
                position: 'absolute',
                top: 52,
                left: `${left}%`,
                width: `${Math.max(width, 1)}%`,
                height: TRACK_HEIGHT,
                background: `${color}33`,
                border: `1.5px solid ${color}`,
                borderRadius: 'var(--radius-sm)',
                cursor: dragging === idx ? 'grabbing' : 'grab',
                display: 'flex',
                alignItems: 'center',
                padding: '0 4px',
                overflow: 'hidden',
                transition: dragging === idx ? 'none' : 'left 0.1s, width 0.1s',
                zIndex: dragging === idx ? 10 : 1,
              }}
            >
              <span style={{
                fontSize: 9, fontFamily: 'var(--font-mono)',
                color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {idx + 1}
              </span>
            </div>
          )
        })}

        {/* Label */}
        <span style={{ position: 'absolute', left: 4, top: 56, fontSize: 9, color: 'var(--color-muted-fg)', fontFamily: 'var(--font-mono)', pointerEvents: 'none' }}>
          narration
        </span>
      </div>

      {/* Segment list with edit/regenerate */}
      <div style={{ marginTop: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {segments.map((seg, idx) => {
          const color = colors[idx % colors.length]!
          const isEditing = editingIdx === idx
          return (
            <div key={seg.stepIndex} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
              padding: '4px var(--space-sm)',
              borderRadius: 'var(--radius-sm)',
              background: isEditing ? 'var(--color-secondary)' : 'transparent',
            }}>
              {/* Color dot + step number */}
              <span style={{
                width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                background: `${color}33`, border: `1.5px solid ${color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontFamily: 'var(--font-mono)', color,
              }}>
                {idx + 1}
              </span>

              {/* Time range */}
              <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', flexShrink: 0, minWidth: 70 }}>
                {formatTime(seg.startTime)} — {formatTime(seg.endTime)}
              </span>

              {/* Text — editable */}
              {isEditing ? (
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRegenerate(idx) }}
                  style={{
                    flex: 1, fontSize: 'var(--text-xs)',
                    padding: '2px 6px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-card)', color: 'var(--color-fg)',
                    fontFamily: 'var(--font-sans)', outline: 'none',
                  }}
                  autoFocus
                />
              ) : (
                <span
                  style={{ flex: 1, fontSize: 'var(--text-xs)', color: 'var(--color-fg)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  onClick={() => { setEditingIdx(idx); setEditText(seg.text ?? '') }}
                  title="Click to edit narration text"
                >
                  {seg.text ?? `Step ${idx + 1}`}
                </span>
              )}

              {/* Regenerate button */}
              {regeneratingIdx === idx ? (
                <Spinner size="sm" />
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRegenerate(idx)}
                  title={isEditing ? 'Regenerate with new text' : 'Regenerate audio'}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                    color: isEditing ? 'var(--color-primary)' : 'var(--color-muted-fg)',
                    display: 'flex', alignItems: 'center', flexShrink: 0,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
