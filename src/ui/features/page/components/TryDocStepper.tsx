import { StepperFlow, type StepperStep, Spinner } from '../../../design-system/components/index.js'
import type { DocPageDTO, ProjectDTO, PreflightResultDTO } from '../../../shared/api/client.js'
import { PreflightPanel } from './PreflightPanel.js'
import styles from './TryDocStepper.module.css'

interface TryDocStepperProps {
  page: DocPageDTO
  project: ProjectDTO
  preflightResult: PreflightResultDTO | null
  preflightLoading: boolean
  quotaBlocked: boolean
  /** Update the page's briefing object — same handler the parent already
   *  uses to debounce-save URL / context / resource selections. */
  onBriefingChange: (briefing: DocPageDTO['briefing']) => void
  /** Triggered when the user clicks the stepper's final action. Parent runs
   *  the preflight; results flow back via `preflightResult` and the
   *  PreflightPanel renders inline (Confirm → onRunTest). */
  onRunPreflight: () => Promise<void>
  /** Confirmed run — parent kicks off the actual exploration + analyze pipeline. */
  onRunTest: () => void
  /** Dismiss the preflight result and let the user tweak inputs again. */
  onDismissPreflight: () => void
  /** Show "Plan over quota" hint instead of running. */
  onQuotaBlocked: () => void
}

interface FormShape { /* state lives in `page.briefing` — stepper state is a no-op */ _: never }

/**
 * 3-step stepper replacing the inline "Test Configuration" two-column
 * layout. Same data, same handlers — just sliced into guided steps with
 * AI-bubble copy so the user knows what each input is for.
 *
 * The state itself still lives on `page.briefing` (debounced-saved by the
 * parent) so the stepper's internal state object is a no-op `{}` and each
 * step's render reads / writes through closures. That keeps the autosave
 * + cross-page-survival behavior of the existing form intact.
 */
export function TryDocStepper({
  page,
  project,
  preflightResult,
  preflightLoading,
  quotaBlocked,
  onBriefingChange,
  onRunPreflight,
  onRunTest,
  onDismissPreflight,
  onQuotaBlocked,
}: TryDocStepperProps): React.ReactElement {
  const briefing = (page.briefing ?? {}) as Record<string, unknown>
  const testUrl = (briefing.testUrl as string) || page.startUrl || project.baseUrl || ''
  const testNotes = (briefing.testNotes as string) ?? ''
  const projectResources = project.resources ?? []
  const selectedResources = (briefing.selectedResources as number[]) ?? []

  const update = (field: string, value: unknown): void => {
    onBriefingChange({ ...(page.briefing ?? {}), [field]: value } as DocPageDTO['briefing'])
  }
  const toggleResource = (index: number): void => {
    const next = selectedResources.includes(index)
      ? selectedResources.filter((i) => i !== index)
      : [...selectedResources, index]
    update('selectedResources', next)
  }

  const looksLikeUrl = /^https?:\/\/\S+\.\S+/.test(testUrl.trim())

  const steps: StepperStep<FormShape>[] = [
    {
      title: 'URL',
      message:
        "Donne-moi l'URL où je dois lancer le test. C'est l'écran sur lequel je vais suivre ta doc comme un nouvel utilisateur.",
      validate: () => looksLikeUrl,
      hint: () => 'Une URL complète (https://…) — laisse vide pour reprendre l\'URL du projet.',
      render: () => (
        <div className={styles.field}>
          <label className={styles.label}>URL de test</label>
          <input
            type="text"
            className={styles.input}
            value={testUrl}
            onChange={(e) => update('testUrl', e.target.value)}
            placeholder={page.startUrl ?? project.baseUrl ?? 'https://…'}
            autoFocus
            style={{ fontFamily: 'var(--font-mono)' }}
          />
        </div>
      ),
    },
    {
      title: 'Contexte',
      message:
        'Tu peux me donner du contexte que la doc ne dit pas — comportements attendus, comptes de test, edge cases. Optionnel.',
      validate: () => true,
      render: () => (
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label}>Contexte additionnel</label>
            <textarea
              className={styles.textarea}
              rows={4}
              value={testNotes}
              onChange={(e) => update('testNotes', e.target.value)}
              placeholder="ex. Tester avec une subscription expirée. Le bouton Reset doit afficher une confirmation."
            />
          </div>
          {projectResources.length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Resources à utiliser</label>
              <div className={styles.resourceList}>
                {projectResources.map((r, i) => (
                  <label key={i} className={`${styles.resourceItem} ${selectedResources.includes(i) ? styles.resourceItemActive : ''}`}>
                    <input
                      type="checkbox"
                      checked={selectedResources.includes(i)}
                      onChange={() => toggleResource(i)}
                    />
                    <span className={styles.resourceType}>{r.type}</span>
                    <span className={styles.resourceLabel}>{r.label || r.value.split('/').pop()}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {projectResources.length === 0 && (
            <p className={styles.muted}>
              Aucune resource configurée. Tu peux en ajouter dans Project Settings (fichiers, URLs, notes).
            </p>
          )}
        </div>
      ),
    },
    {
      title: 'Pré-flight & test',
      message: preflightResult
        ? "Voici ce que j'ai trouvé — corrige si nécessaire, puis je lance l'agent."
        : preflightLoading
          ? "Je vérifie que tout est prêt pour le test…"
          : "Je vais d'abord faire un pré-flight (URL joignable, credentials OK), puis lancer l'agent qui suivra ta doc.",
      validate: () => true,
      render: () => (
        <div className={styles.fields}>
          {preflightLoading && (
            <div className={styles.preflightLoading}>
              <Spinner size="sm" />
              <span>Vérification en cours…</span>
            </div>
          )}
          {preflightResult && (
            <PreflightPanel
              result={preflightResult}
              onConfirm={() => { onDismissPreflight(); onRunTest() }}
              onDismiss={onDismissPreflight}
            />
          )}
          {!preflightResult && !preflightLoading && (
            <p className={styles.muted}>
              Cliquer sur <strong>Lancer le pré-flight</strong> ci-dessous pour démarrer. Le test commence après ta confirmation des résultats.
            </p>
          )}
        </div>
      ),
    },
  ]

  return (
    <StepperFlow<FormShape>
      steps={steps}
      initialState={{ _: undefined as never }}
      submitting={preflightLoading}
      onComplete={() => {
        if (quotaBlocked) { onQuotaBlocked(); return }
        if (!preflightResult) void onRunPreflight()
      }}
      finishLabel={preflightResult ? 'Test prêt — confirme ci-dessus' : 'Lancer le pré-flight'}
    />
  )
}
