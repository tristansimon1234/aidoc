import { useState } from 'react'
import { Modal, StepperFlow, type StepperStep } from '../../design-system/components/index.js'
import { api, ApiError, type BrandDTO, type VoiceTone } from '../../shared/api/client.js'
import styles from './GenerateModal.module.css'

interface GenerateModalProps {
  brands: BrandDTO[]
  onClose: () => void
  onSuccess: () => void
}

interface FormState {
  brandId: string
  title: string
  brief: string
  tone: VoiceTone
  musicTrackId: string
}

const VOICE_TONES: { id: VoiceTone; name: string }[] = [
  { id: 'confident',      name: 'Confident — founder pitch' },
  { id: 'punchy',         name: 'Punchy — high energy' },
  { id: 'inspirational',  name: 'Inspirational — anthemic' },
  { id: 'playful',        name: 'Playful — light and fun' },
  { id: 'conversational', name: 'Conversational — podcast' },
  { id: 'calm',           name: 'Calm — minimalist' },
  { id: 'serious',        name: 'Serious — restrained' },
]

const MUSIC_STYLES: { id: string; name: string; mood: string }[] = [
  { id: 'ai-cinematic',     name: 'Cinematic',     mood: 'Dramatic' },
  { id: 'ai-upbeat',        name: 'Upbeat',        mood: 'Energetic' },
  { id: 'ai-inspirational', name: 'Inspirational', mood: 'Uplifting' },
  { id: 'ai-lofi',          name: 'Lo-fi',         mood: 'Relaxed' },
  { id: 'ai-tech',          name: 'Tech',          mood: 'Modern' },
  { id: 'ai-ambient',       name: 'Ambient',       mood: 'Minimal' },
  { id: 'none',             name: 'No music',      mood: 'Silent' },
]

/**
 * The single video-creation surface. Same 4-step stepper pattern as in
 * Doclee's per-page Marketing tab — brief → voice → music → review.
 * Brand is picked up front (defaults to the user's default brand).
 *
 * Synchronous create: the backend route blocks until the full pipeline
 * (script + voice + music + render) finishes. Modal stays open the whole
 * time with the stepper's `submitting=true` state, then closes on
 * success. UI rule: never let the user navigate away from the modal
 * while a credit is being burned — the modal is the receipt.
 */
export function GenerateModal({ brands, onClose, onSuccess }: GenerateModalProps): React.ReactElement {
  const defaultBrand = brands.find((b) => b.isDefault) ?? brands[0]
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const initial: FormState = {
    brandId: defaultBrand?.id ?? '',
    title: '',
    brief: '',
    tone: 'confident',
    musicTrackId: 'ai-upbeat',
  }

  const handleSubmit = async (state: FormState): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await api.marketingVideos.create({
        brief: state.brief,
        title: state.title || undefined,
        brandId: state.brandId || undefined,
        options: {
          tone: state.tone,
          musicTrackId: state.musicTrackId,
        },
      })
      onSuccess()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_CREDITS') {
        setError('You\'ve used your credit. Buy a pack from the billing page to keep going.')
      } else {
        setError((err as Error).message)
      }
      setSubmitting(false)
    }
  }

  const steps: StepperStep<FormState>[] = [
    {
      title: 'Brand',
      message: brands.length > 1
        ? 'Pick the brand this video is for — it controls colors, logo, and font.'
        : 'Using your default brand for colors and logo.',
      render: (s, set) => (
        <div className={styles.fields}>
          {brands.length > 1 ? (
            <div className={styles.brandGrid}>
              {brands.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`${styles.brandCard} ${s.brandId === b.id ? styles.brandCardActive : ''}`}
                  onClick={() => set({ brandId: b.id })}
                  style={{ borderColor: s.brandId === b.id ? b.accentColor : undefined }}
                >
                  <span className={styles.brandName}>{b.name}</span>
                  <span className={styles.brandSwatches}>
                    <span style={{ background: b.accentColor }} />
                    <span style={{ background: b.bgColor }} />
                    <span style={{ background: b.textColor }} />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.singleBrand}>
              <div className={styles.brandName}>{defaultBrand?.name}</div>
              <span className={styles.brandSwatches}>
                <span style={{ background: defaultBrand?.accentColor }} />
                <span style={{ background: defaultBrand?.bgColor }} />
                <span style={{ background: defaultBrand?.textColor }} />
              </span>
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Brief',
      message: 'Describe your product in a few sentences — concrete benefits, target audience, the angle to take.',
      validate: (s) => s.brief.trim().length >= 30,
      hint: () => 'At least 30 characters. Give me a clear angle.',
      render: (s, set) => (
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label}>Title (optional)</label>
            <input
              type="text"
              className={styles.input}
              placeholder="e.g. Linear Customer Requests — launch pitch"
              value={s.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Product brief</label>
            <textarea
              className={styles.textarea}
              rows={8}
              placeholder="e.g. Linear Customer Requests connects customer feedback directly to product work. For B2B SaaS PMs at 20–200 person companies. Stop juggling Intercom + Notion + Linear."
              value={s.brief}
              onChange={(e) => set({ brief: e.target.value })}
              autoFocus
            />
            <span className={styles.counter}>{s.brief.length} / 6000</span>
          </div>
        </div>
      ),
    },
    {
      title: 'Voice',
      message: 'Which voice should carry your pitch? The tone shapes both the voice-over and the script\'s energy.',
      render: (s, set) => (
        <div className={styles.choiceGrid}>
          {VOICE_TONES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.choiceCard} ${s.tone === t.id ? styles.choiceCardActive : ''}`}
              onClick={() => set({ tone: t.id })}
            >
              <span className={styles.choiceName}>{t.name}</span>
            </button>
          ))}
        </div>
      ),
    },
    {
      title: 'Music',
      message: 'Background music — AI-generated from the style you pick, tuned to sit under the voice.',
      render: (s, set) => (
        <div className={styles.choiceGrid}>
          {MUSIC_STYLES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`${styles.choiceCard} ${s.musicTrackId === m.id ? styles.choiceCardActive : ''}`}
              onClick={() => set({ musicTrackId: m.id })}
            >
              <span className={styles.choiceName}>{m.name}</span>
              <span className={styles.choiceMood}>{m.mood}</span>
            </button>
          ))}
        </div>
      ),
    },
    {
      title: 'Review',
      message: "All set. I'll write the script, synthesize the voice, generate the music, and render the video. Takes about 2-3 minutes — don't close this tab.",
      render: (s) => (
        <div className={styles.summary}>
          <SummaryRow label="Brand" value={brands.find((b) => b.id === s.brandId)?.name ?? '(none)'} />
          <SummaryRow label="Title" value={s.title || `Marketing video ${new Date().toLocaleDateString()}`} />
          <SummaryRow label="Brief" value={s.brief.length > 200 ? `${s.brief.slice(0, 200)}…` : s.brief} multiline />
          <SummaryRow label="Voice" value={VOICE_TONES.find((t) => t.id === s.tone)?.name ?? s.tone} />
          <SummaryRow label="Music" value={MUSIC_STYLES.find((m) => m.id === s.musicTrackId)?.name ?? s.musicTrackId} />
          <p className={styles.cost}>This will use <strong>1 credit</strong>.</p>
          {error && <div className={styles.errorMsg}>{error}</div>}
        </div>
      ),
    },
  ]

  return (
    <Modal
      title="New marketing video"
      subtitle="5 steps — about 2-3 minutes to render"
      size="lg"
      dismissible={!submitting}
      onClose={onClose}
    >
      <StepperFlow<FormState>
        steps={steps}
        initialState={initial}
        onComplete={(s) => void handleSubmit(s)}
        onCancel={onClose}
        finishLabel="Generate"
        submitting={submitting}
      />
    </Modal>
  )
}

function SummaryRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }): React.ReactElement {
  return (
    <div className={styles.summaryRow}>
      <span className={styles.summaryLabel}>{label}</span>
      <span className={`${styles.summaryValue} ${multiline ? styles.summaryValueMultiline : ''}`}>{value}</span>
    </div>
  )
}
