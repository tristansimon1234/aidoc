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
        "Give me the URL where I should run the test. That's the screen I'll follow your doc on, as a fresh user.",
      validate: () => looksLikeUrl,
      hint: () => 'A full URL (https://…) — leave blank to fall back to the project URL.',
      render: () => (
        <div className={styles.field}>
          <label className={styles.label}>Test URL</label>
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
      title: 'Context',
      message:
        "You can give me context the doc doesn't spell out — expected behaviour, test accounts, edge cases. Optional.",
      validate: () => true,
      render: () => (
        <div className={styles.fields}>
          <div className={styles.field}>
            <label className={styles.label}>Additional context</label>
            <textarea
              className={styles.textarea}
              rows={4}
              value={testNotes}
              onChange={(e) => update('testNotes', e.target.value)}
              placeholder="e.g. Test with an expired subscription. The Reset button should show a confirmation dialog."
            />
          </div>
          {projectResources.length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Resources to use</label>
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
              No resources configured. Add files, URLs, or notes in Project Settings.
            </p>
          )}
        </div>
      ),
    },
    {
      title: 'Pre-flight & run',
      message: preflightResult
        ? "Here's what I found — fix anything if needed, then I'll launch the agent."
        : preflightLoading
          ? "Checking that everything's ready for the test…"
          : "I'll first run a pre-flight (URL reachable, credentials OK), then launch the agent that follows your doc.",
      validate: () => true,
      render: () => (
        <div className={styles.fields}>
          {preflightLoading && (
            <div className={styles.preflightLoading}>
              <Spinner size="sm" />
              <span>Checking…</span>
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
              Click <strong>Run pre-flight</strong> below to start. The test runs after you confirm the results.
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
      finishLabel={preflightResult ? 'Test ready — confirm above' : 'Run pre-flight'}
    />
  )
}
