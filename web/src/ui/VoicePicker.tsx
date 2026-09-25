import { useEffect, useRef, useState } from 'react'
import { api, type VoiceOption } from '../api'
import { Button } from './design-system/components'
import styles from '../pages/pages.module.css'

const STORAGE_KEY = 'doclee-voice'

/**
 * Voix et ton mémorisés d'une vidéo à l'autre (dans ce navigateur). Sans choix mémorisé, la voix est
 * vide : le sélecteur prend la voix par défaut quand la liste arrive (ElevenLabs si configuré).
 */
export function loadVoiceChoice(): { voice: string; tone: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      voice?: string
      tone?: string
    }
    return { voice: saved.voice ?? '', tone: saved.tone ?? 'friendly' }
  } catch {
    return { voice: '', tone: 'friendly' }
  }
}

/** Choix de la voix off et de son ton, avec écoute d'un extrait. */
export function VoicePicker({
  language,
  tones,
  voice,
  tone,
  onChange,
}: {
  language: string
  tones: { id: string; label: string }[]
  voice: string
  tone: string
  onChange: (choice: { voice: string; tone: string }) => void
}) {
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [premiumError, setPremiumError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    api
      .voices()
      .then((r) => {
        setVoices(r.voices)
        setPremiumError(r.premiumError)
      })
      .catch(() => setVoices([]))
    return () => audio.current?.pause()
  }, [])

  // Pas de voix choisie, ou une voix qui n'existe plus : la première voix premium (ElevenLabs), sinon Gemini.
  useEffect(() => {
    if (voices.length === 0 || voice === 'none' || voices.some((v) => v.id === voice)) return
    const fallback = voices.find((v) => v.premium) ?? voices[0]
    if (fallback) onChange({ voice: fallback.id, tone })
  }, [voices, voice, tone, onChange])

  function change(next: { voice: string; tone: string }) {
    audio.current?.pause()
    setPlaying(false)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // stockage indisponible : le choix vaut juste pour cette fois
    }
    onChange(next)
  }

  async function listen() {
    setError(null)
    if (playing) {
      audio.current?.pause()
      setPlaying(false)
      return
    }
    setPlaying(true)
    try {
      const url = await api.voicePreview(voice, language, tone)
      audio.current?.pause()
      audio.current = new Audio(url)
      audio.current.onended = () => setPlaying(false)
      await audio.current.play()
    } catch {
      setError('Preview unavailable right now.')
      setPlaying(false)
    }
  }

  const standard = voices.filter((v) => !v.premium)
  const premium = voices.filter((v) => v.premium)
  const option = (v: VoiceOption) => (
    <option key={v.id} value={v.id}>
      {v.name}
      {v.description ? ` — ${v.description}` : ''}
    </option>
  )

  return (
    <div className={styles.form}>
      <div className={styles.row}>
        <label className={styles.select}>
          Voice-over
          <select value={voice} onChange={(e) => change({ voice: e.target.value, tone })}>
            <option value="none">No voice-over (video only)</option>
            {premium.length > 0 && (
              <optgroup label="ElevenLabs · premium">{premium.map(option)}</optgroup>
            )}
            {standard.length > 0 && (
              <optgroup label="Gemini · included">{standard.map(option)}</optgroup>
            )}
          </select>
          {premiumError && (
            <span className={styles.notice}>ElevenLabs voices unavailable: {premiumError}</span>
          )}
        </label>
        {voice !== 'none' && (
          <label className={styles.select}>
            Tone
            <select value={tone} onChange={(e) => change({ voice, tone: e.target.value })}>
              {tones.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {voice !== 'none' && (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={() => void listen()}>
            {playing ? '■ Stop' : '▶ Listen'}
          </Button>
          {error && <span className={styles.notice}> {error}</span>}
        </div>
      )}
    </div>
  )
}
