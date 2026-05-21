import { useCallback, useEffect, useState } from 'react'
import { useOutletContext, useParams } from 'react-router-dom'
import {
  Button,
  EmptyState,
  Modal,
  Spinner,
  StepperFlow,
  type StepperStep,
} from '../../../design-system/components/index.js'
import { api, ApiError, type ProjectDTO } from '../../../shared/api/client.js'
import styles from './ProjectMarketing.module.css'

interface ProjectContext {
  project: ProjectDTO
}

interface MarketingVideoRow {
  runId: string
  title: string
  brief: string | null
  createdAt: string
  videoUrl: string | null
  renderStatus: 'idle' | 'rendering' | 'ready' | 'failed'
  thumbnailUrl: string | null
  durationSeconds: number | null
}

const VOICE_TONES: { id: 'punchy' | 'calm' | 'playful' | 'serious' | 'confident' | 'inspirational' | 'conversational'; name: string }[] = [
  { id: 'confident', name: 'Confident — founder pitch' },
  { id: 'punchy', name: 'Punchy — high energy' },
  { id: 'inspirational', name: 'Inspirational — anthemic' },
  { id: 'playful', name: 'Playful — light and fun' },
  { id: 'conversational', name: 'Conversational — podcast style' },
  { id: 'calm', name: 'Calm — minimalist' },
  { id: 'serious', name: 'Serious — restrained' },
]

const MUSIC_STYLES: { id: string; name: string; mood: string }[] = [
  { id: 'ai-cinematic', name: 'Cinematic', mood: 'Dramatic' },
  { id: 'ai-upbeat', name: 'Upbeat', mood: 'Energetic' },
  { id: 'ai-inspirational', name: 'Inspirational', mood: 'Uplifting' },
  { id: 'ai-lofi', name: 'Lo-fi', mood: 'Relaxed' },
  { id: 'ai-tech', name: 'Tech', mood: 'Modern' },
  { id: 'ai-ambient', name: 'Ambient', mood: 'Minimal' },
  { id: 'none', name: 'No music', mood: 'Silent' },
]

interface FormState {
  title: string
  brief: string
  tone: typeof VOICE_TONES[number]['id']
  musicTrackId: string
}

/**
 * Project-level Marketing tab — generates standalone promo videos from a
 * plain-text brief, no doc page required.
 *
 * Why this lives at the project level (and not on a page like the existing
 * `MarketingVideoPanel`): a sales prospect asked for the marketing-video
 * feature on its own, without going through the doc-generation flow. The
 * page-scoped panel always needed a recording + page.content; this surface
 * accepts a brief directly. The 4-step stepper walks the user through
 * title → brief → voice → music to address the "forms are heavy" feedback.
 *
 * Existing page-scoped marketing videos (the ones tied to a specific page's
 * Marketing tab) are NOT listed here — different surface, different intent.
 * Only `kind='marketing-only'` runs show up. They render in a card gallery
 * with their thumbnail / status / duration.
 */
export function ProjectMarketing(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const context = useOutletContext<ProjectContext>()
  const [items, setItems] = useState<MarketingVideoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const res = await api.projects.listMarketingVideos(projectId)
      setItems(res.items)
    } catch (err) {
      console.warn('[marketing] list failed', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])

  const handleCreate = useCallback(async (state: FormState) => {
    if (!projectId) return
    setCreating(true)
    setError(null)
    try {
      await api.projects.createMarketingVideo(projectId, {
        brief: state.brief,
        title: state.title || undefined,
        options: {
          tone: state.tone,
          musicTrackId: state.musicTrackId,
        },
      })
      setModalOpen(false)
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError('Monthly quota reached — upgrade your plan to generate more marketing videos.')
      } else {
        setError((err as Error).message)
      }
    } finally {
      setCreating(false)
    }
  }, [projectId, refresh])

  const initial: FormState = {
    title: '',
    brief: context.project.description ?? '',
    tone: 'confident',
    musicTrackId: 'ai-upbeat',
  }

  const steps: StepperStep<FormState>[] = [
    {
      title: 'Brief',
      message:
        "Décris ton produit en quelques phrases — je m'en sers pour écrire le script du clip. Plus c'est concret (bénéfices, public cible), mieux c'est.",
      validate: (s) => s.brief.trim().length >= 30,
      hint: () => 'Au moins 30 caractères. Donne moi un angle clair.',
      render: (s, set) => (
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label}>Titre (optionnel)</label>
            <input
              type="text"
              className={styles.input}
              placeholder="ex. Lancement Doclee — pitch sales"
              value={s.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Brief produit</label>
            <textarea
              className={styles.textarea}
              rows={8}
              placeholder="ex. Doclee génère automatiquement de la documentation produit à partir d'enregistrements d'écran. Pour les Heads of Product / Support qui n'ont pas le temps d'écrire. Économise 4h par feature."
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
      title: 'Voix',
      message:
        "Quelle voix doit porter ton pitch ? Le ton détermine à la fois la diction de la voix off et l'énergie générale du script.",
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
      title: 'Musique',
      message:
        "Et la musique de fond ? Elle est générée par IA en fonction du style choisi — calibrée pour rester sous la voix.",
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
      title: 'Récap',
      message:
        "Tout est prêt. Je vais écrire le script, synthétiser la voix, générer la musique et rendre la vidéo. Compte environ 2-3 minutes.",
      render: (s) => (
        <div className={styles.summary}>
          <SummaryRow label="Titre" value={s.title || `Marketing video ${new Date().toLocaleDateString()}`} />
          <SummaryRow label="Brief" value={s.brief.length > 200 ? `${s.brief.slice(0, 200)}…` : s.brief} multiline />
          <SummaryRow label="Voix" value={VOICE_TONES.find((t) => t.id === s.tone)?.name ?? s.tone} />
          <SummaryRow label="Musique" value={MUSIC_STYLES.find((m) => m.id === s.musicTrackId)?.name ?? s.musicTrackId} />
          {error && <div className={styles.errorMsg}>{error}</div>}
        </div>
      ),
    },
  ]

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Marketing videos</h1>
          <p className={styles.subtitle}>
            Generate standalone promo videos from a plain text brief — no recording or doc required.
          </p>
        </div>
        <Button variant="primary" onClick={() => { setError(null); setModalOpen(true) }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New marketing video
        </Button>
      </div>

      {loading ? (
        <div className={styles.loadingBox}><Spinner size="md" /></div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No standalone marketing videos yet"
          description="Click ‘New marketing video’ to generate your first one from a brief — takes 2-3 minutes."
        />
      ) : (
        <div className={styles.grid}>
          {items.map((item) => (
            <VideoCard key={item.runId} item={item} />
          ))}
        </div>
      )}

      {modalOpen && (
        <Modal
          title="New marketing video"
          subtitle="From a brief — 4 steps"
          size="lg"
          dismissible={!creating}
          onClose={() => setModalOpen(false)}
        >
          <StepperFlow
            steps={steps}
            initialState={initial}
            onComplete={handleCreate}
            onCancel={() => setModalOpen(false)}
            finishLabel="Generate"
            submitting={creating}
          />
        </Modal>
      )}
    </div>
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

function VideoCard({ item }: { item: MarketingVideoRow }): React.ReactElement {
  const statusLabel: Record<MarketingVideoRow['renderStatus'], string> = {
    idle: 'Pending render',
    rendering: 'Rendering…',
    ready: 'Ready',
    failed: 'Render failed',
  }
  return (
    <div className={styles.card}>
      <div className={styles.cardMedia}>
        {item.videoUrl ? (
          <video controls className={styles.cardVideo} poster={item.thumbnailUrl ?? undefined}>
            <source src={item.videoUrl} type="video/mp4" />
          </video>
        ) : item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className={styles.cardThumb} />
        ) : (
          <div className={styles.cardPlaceholder}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
        )}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>{item.title}</div>
        <div className={styles.cardMeta}>
          <span>{statusLabel[item.renderStatus]}</span>
          {item.durationSeconds && <span>· {item.durationSeconds.toFixed(0)}s</span>}
          <span>· {new Date(item.createdAt).toLocaleDateString()}</span>
        </div>
        {item.brief && <p className={styles.cardBrief}>{item.brief.length > 140 ? `${item.brief.slice(0, 140)}…` : item.brief}</p>}
      </div>
    </div>
  )
}
