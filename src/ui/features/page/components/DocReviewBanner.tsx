import { useState } from 'react'
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
}

export function DocReviewBanner({ selfAssessment }: DocReviewBannerProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)

  const completeness = selfAssessment?.overallCompleteness
  const rawGaps = selfAssessment?.gaps ?? []
  const nextSteps = selfAssessment?.nextSteps ?? []

  // Legacy fingerprint — pre-fix doc generations stored a sentinel gap
  // and 0 % completeness whenever Gemini's tail JSON failed to parse.
  // Detect that exact shape and treat it as a parse failure so the
  // banner doesn't lie about confidence on docs generated before the
  // parser was hardened. New runs set `parseFailed` directly.
  const isLegacyParseFallback =
    completeness === 0 &&
    rawGaps.length === 1 &&
    rawGaps[0]?.reason === 'Self-assessment could not be parsed'

  const parseFailed = selfAssessment?.parseFailed === true || isLegacyParseFallback
  // When we know the assessment is bogus, hide its gap so we don't
  // surface "Entire documentation — Self-assessment could not be parsed"
  // as if it were a real AI-flagged issue.
  const gaps = parseFailed ? [] : rawGaps
  const hasAssessment = typeof completeness === 'number' || gaps.length > 0 || parseFailed

  if (!hasAssessment) return null

  const summaryBits: string[] = []
  if (parseFailed) {
    summaryBits.push('AI confidence unavailable — regenerate to refresh')
  } else if (typeof completeness === 'number') {
    summaryBits.push(`${completeness}% confidence`)
  }
  if (gaps.length > 0) {
    summaryBits.push(`${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'} flagged by AI`)
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
        </div>
      )}
    </div>
  )
}
