import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../shared/api/client.js'
import type { DocGap, DocNextStep } from '../../../../features/documentation/documentation.types.js'
import styles from './DocReviewBanner.module.css'

interface DocReviewBannerProps {
  selfAssessment: {
    overallCompleteness?: number
    gaps?: DocGap[]
    nextSteps?: DocNextStep[]
    /** Set by the backend when Gemini's tail JSON couldn't be parsed
     *  (truncation, fence wrap, missing separator). Distinct from a
     *  legitimate 0 % completeness — we render an explicit "unavailable"
     *  state rather than misleading the user. */
    parseFailed?: boolean
  } | null
  /** Latest run id — used to fetch step observations for the
   *  UI-label visibility audit. When absent, only the AI confidence
   *  signal is shown (no label check). */
  runId: string | null
  /** Current markdown content — scanned for candidate UI labels. */
  markdown: string
}

/** Pull plausible UI labels out of the doc:
 *  - `**Submit**` style emphasis with ≤ 4 words
 *  - "Click 'Settings'" / 'Press "Save"' style instructions
 *
 *  Heuristic by design — false positives are fine because we only flag
 *  labels that ALSO fail the visibility check. False negatives are
 *  acceptable too: if a label appeared as plain text, it's already low
 *  signal that it was hallucinated. */
function extractCandidateLabels(markdown: string): string[] {
  if (!markdown) return []
  const out = new Set<string>()
  for (const m of markdown.matchAll(/\*\*([^*\n]{1,60})\*\*/g)) {
    const text = m[1]?.trim()
    if (!text) continue
    const words = text.split(/\s+/)
    if (words.length === 0 || words.length > 4) continue
    // Skip emphasized phrases that aren't UI-labelish (no leading capital,
    // sentences with punctuation, headings ending in ":", etc.)
    if (!/^[A-Z]/.test(text)) continue
    if (/[.?!:;]$/.test(text)) continue
    out.add(text)
  }
  for (const m of markdown.matchAll(/(?:click|open|press|select|tap|hit|choose|navigate to)\s+["']([^"'\n]{1,60})["']/gi)) {
    const text = m[1]?.trim()
    if (text && text.split(/\s+/).length <= 4) out.add(text)
  }
  return Array.from(out)
}

/** A label is "unverified" if its substring (case-insensitive) doesn't
 *  appear anywhere in the run's step actions / observations / titles.
 *  Substring on purpose: doc paraphrases ("the Submit button" vs
 *  observation "user clicks Submit") still match. */
function findUnverified(labels: string[], stepBlob: string): string[] {
  if (stepBlob.length === 0) return labels
  const haystack = stepBlob.toLowerCase()
  return labels.filter((l) => !haystack.includes(l.toLowerCase()))
}

export function DocReviewBanner({ selfAssessment, runId, markdown }: DocReviewBannerProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [stepBlob, setStepBlob] = useState<string | null>(null)
  const [stepsError, setStepsError] = useState(false)

  const candidateLabels = useMemo(() => extractCandidateLabels(markdown), [markdown])

  // Fetch step observations once on first expand. Cache in state so
  // repeated toggles don't re-fetch.
  useEffect(() => {
    if (!expanded || stepBlob !== null || !runId) return
    let cancelled = false
    void (async () => {
      try {
        const steps = await api.runs.steps(runId)
        if (cancelled) return
        const blob = steps
          .map((s) => `${s.action ?? ''} ${s.observation ?? ''} ${s.title ?? ''}`)
          .join(' ')
        setStepBlob(blob)
      } catch {
        if (!cancelled) setStepsError(true)
      }
    })()
    return () => { cancelled = true }
  }, [expanded, stepBlob, runId])

  const unverifiedLabels = useMemo(() => {
    if (stepBlob === null) return null
    return findUnverified(candidateLabels, stepBlob)
  }, [candidateLabels, stepBlob])

  const completeness = selfAssessment?.overallCompleteness
  const gaps = selfAssessment?.gaps ?? []
  const nextSteps = selfAssessment?.nextSteps ?? []
  const parseFailed = selfAssessment?.parseFailed === true
  const hasAssessment = typeof completeness === 'number' || gaps.length > 0 || parseFailed

  // Don't render at all when there's neither an AI signal nor anything
  // worth alerting on.
  if (!hasAssessment && candidateLabels.length === 0) return null

  const summaryBits: string[] = []
  if (parseFailed) {
    summaryBits.push('AI confidence unavailable — regenerate to refresh')
  } else if (typeof completeness === 'number') {
    summaryBits.push(`${completeness}% confidence`)
  }
  if (gaps.length > 0) {
    summaryBits.push(`${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'} flagged by AI`)
  }
  if (unverifiedLabels && unverifiedLabels.length > 0) {
    summaryBits.push(`${unverifiedLabels.length} unverified ${unverifiedLabels.length === 1 ? 'label' : 'labels'}`)
  }

  const tone: 'ok' | 'warn' | 'alert' =
    parseFailed ? 'warn' :
    typeof completeness === 'number' && completeness < 60 ? 'alert' :
    typeof completeness === 'number' && completeness < 80 ? 'warn' :
    gaps.some((g) => g.severity === 'major') ? 'warn' :
    gaps.length > 0 ? 'warn' :
    'ok'

  return (
    <div className={`${styles.banner} ${styles[tone]}`}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={styles.icon} aria-hidden>
          {tone === 'ok' ? '✓' : '⚠'}
        </span>
        <span className={styles.title}>AI Review</span>
        <span className={styles.summary}>
          {summaryBits.length > 0 ? summaryBits.join(' · ') : 'No issues flagged'}
        </span>
        <span className={styles.chevron} aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className={styles.details}>
          {gaps.length > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Gaps the AI flagged</h4>
              <ul className={styles.list}>
                {gaps.map((g, i) => (
                  <li key={i} className={`${styles.item} ${styles[`severity_${g.severity}`]}`}>
                    <span className={styles.itemArea}>{g.area}</span>
                    <span className={styles.itemReason}>{g.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {nextSteps.length > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Suggested next steps</h4>
              <ul className={styles.list}>
                {nextSteps.map((n, i) => (
                  <li key={i} className={styles.item}>
                    <span className={styles.itemArea}>{n.suggestion}</span>
                    {n.reason && <span className={styles.itemReason}>{n.reason}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>UI labels not seen in the recording</h4>
            {!runId ? (
              <p className={styles.muted}>No recording is linked to this page — skipping label check.</p>
            ) : stepsError ? (
              <p className={styles.muted}>Could not load steps for the label check.</p>
            ) : unverifiedLabels === null ? (
              <p className={styles.muted}>Loading…</p>
            ) : unverifiedLabels.length === 0 ? (
              <p className={styles.muted}>
                {candidateLabels.length === 0
                  ? 'No bold UI labels detected in the doc.'
                  : 'All bold labels appear somewhere in the recording.'}
              </p>
            ) : (
              <>
                <p className={styles.muted}>
                  These labels appear in the doc but not in any step the AI saw — verify they exist in your product.
                </p>
                <ul className={styles.labelList}>
                  {unverifiedLabels.map((l) => (
                    <li key={l} className={styles.labelChip}>{l}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
