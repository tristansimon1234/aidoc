import { useCallback, useState } from 'react'
import { Modal, StepperFlow, type StepperStep } from '../../../design-system/components/index.js'
import type { DocPageDTO } from '../../../shared/api/client.js'
import { ScreenRecorder } from './ScreenRecorder.js'
import styles from './GenerationModal.module.css'

interface GenerationModalProps {
  projectId: string
  pageId: string
  page: DocPageDTO
  hasExistingVoiceover: boolean
  /** Called whenever a briefing field changes — wires up to the PageView's
   *  debounced page-update so the briefing persists even if the user closes
   *  the modal before recording. */
  onBriefingChange: (briefing: DocPageDTO['briefing']) => void
  onGoalChange: (goal: string) => void
  /** Fired by ScreenRecorder when the full pipeline kicks off — we close
   *  the modal here so the user lands back on the Documentation tab and
   *  watches the job progress via the JobBadge. */
  onComplete: () => Promise<void>
  onClose: () => void
}

interface BriefingState {
  goal: string
  objective: string
  knowledge: string
}

/**
 * Replaces the old "Generate" tab. The Generate flow is action-shaped, not
 * content-shaped, so it lives in a modal launched from the PageView header
 * CTA instead of sitting in the tab bar as a permanent stub. Two steps:
 *   1. Briefing — three fields scoped to *this page*. Saved as the user
 *      types so it sticks even if they close the modal.
 *   2. Record / Upload — ScreenRecorder. Its onComplete bubbles up,
 *      closes the modal, and the JobBadge tracks the rest.
 *
 * The stepper uses chat-bubble messages to guide the user — addresses the
 * "user doesn't know what to do" feedback. Each message is short and
 * action-oriented so it reads fast without becoming a wall of text.
 */
export function GenerationModal({
  projectId,
  pageId,
  page,
  hasExistingVoiceover,
  onBriefingChange,
  onGoalChange,
  onComplete,
  onClose,
}: GenerationModalProps): React.ReactElement {
  const briefing = (page.briefing ?? {}) as Record<string, unknown>
  const initial: BriefingState = {
    goal: page.goal ?? '',
    objective: (briefing.objective as string) ?? '',
    knowledge: (briefing.knowledge as string) ?? '',
  }

  // Once the user moves past step 0, the ScreenRecorder mounts and runs
  // its own pipeline. We keep `submitting=true` after that so the stepper
  // doesn't let the user navigate back into a partially-recorded state.
  const [submitting, setSubmitting] = useState(false)

  const handleRecorderComplete = useCallback(async () => {
    await onComplete()
    onClose()
  }, [onComplete, onClose])

  const steps: StepperStep<BriefingState>[] = [
    {
      title: 'Brief',
      message: "Dis-moi ce que tu veux documenter — je m'en servirai pour cadrer la doc générée.",
      validate: (s) => s.objective.trim().length >= 8,
      hint: () =>
        'Décris en une phrase ce que doit couvrir cette page (≥ 8 caractères).',
      render: (s, set) => (
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label}>Objectif (optionnel)</label>
            <input
              type="text"
              className={styles.input}
              placeholder="ex. Documenter le flow de pricing et d'upgrade"
              value={s.goal}
              onChange={(e) => {
                set({ goal: e.target.value })
                onGoalChange(e.target.value)
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Que documenter</label>
            <textarea
              rows={3}
              className={styles.textarea}
              placeholder="ex. Comment un nouvel utilisateur crée un compte et complète l'onboarding"
              value={s.objective}
              onChange={(e) => {
                set({ objective: e.target.value })
                onBriefingChange({ ...briefing, objective: e.target.value } as DocPageDTO['briefing'])
              }}
              autoFocus
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Ce que l&apos;IA ne peut pas deviner (optionnel)</label>
            <textarea
              rows={2}
              className={styles.textarea}
              placeholder="ex. Les utilisateurs trial n'ont pas accès au billing. L'export n'apparaît qu'après 3 entrées."
              value={s.knowledge}
              onChange={(e) => {
                set({ knowledge: e.target.value })
                onBriefingChange({ ...briefing, knowledge: e.target.value } as DocPageDTO['briefing'])
              }}
            />
          </div>
        </div>
      ),
    },
    {
      title: 'Enregistrement',
      message:
        'Maintenant, enregistre ton écran ou upload une vidéo — j\'analyse chaque action, extrais les captures clés, et je rédige la doc.',
      validate: () => true,
      render: () => (
        <div className={styles.recorderWrap}>
          <ScreenRecorder
            projectId={projectId}
            pageId={pageId}
            page={page}
            hasExistingVoiceover={hasExistingVoiceover}
            onComplete={handleRecorderComplete}
          />
        </div>
      ),
    },
  ]

  return (
    <Modal
      title={page.content ? 'Régénérer la documentation' : 'Générer la documentation'}
      subtitle={`Pour la page "${page.title}"`}
      size="lg"
      dismissible={!submitting}
      onClose={onClose}
    >
      <StepperFlow
        steps={steps}
        initialState={initial}
        onComplete={() => {
          // Last step's "Continue" doesn't actually submit — the
          // ScreenRecorder owns its own button. So this is a no-op; we
          // lock the stepper in place and let the recorder drive.
          setSubmitting(true)
        }}
        onCancel={onClose}
        finishLabel="OK"
        submitting={submitting}
      />
    </Modal>
  )
}
