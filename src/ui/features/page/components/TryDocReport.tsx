import { useState } from 'react'
import styles from './TryDocReport.module.css'

/* ===== Local DTO interface (to be replaced by shared type later) ===== */

interface TryDocReportDTO {
  version: number
  pageId: string
  pageTitle: string
  executedAt: string
  summary: {
    totalSteps: number
    passed: number
    failed: number
    ambiguous: number
    overallVerdict: 'pass' | 'fail' | 'partial'
  }
  steps: {
    stepIndex: number
    instruction: string
    action: string
    pageUrl: string | null
    status: 'pass' | 'fail' | 'ambiguous'
    issueType: 'doc' | 'product' | null
    detail: string
    screenshotPath: string | null
  }[]
  failures: {
    stepIndex: number | null
    issueType: 'doc' | 'product'
    title: string
    description: string
    severity: 'critical' | 'major' | 'minor'
    suggestion: string
  }[]
  docIssues: {
    clarityScore: number
    missingSections: string[]
    ambiguousInstructions: string[]
    implicitAssumptions: string[]
  }
  uxInsights: {
    category: string
    description: string
    stepIndex: number | null
    severity: 'high' | 'medium' | 'low'
  }[]
  recommendations: {
    type: 'fix-doc' | 'fix-product' | 'improve-ux'
    title: string
    description: string
    priority: 'high' | 'medium' | 'low'
  }[]
  scores: {
    docQuality: number
    testPassRate: number
    uxClarity: number
  }
}

interface TryDocReportProps {
  report: TryDocReportDTO
}

/* ===== Helpers ===== */

function scoreColorClass(value: number): string {
  if (value < 4) return styles.colorFail ?? ''
  if (value < 7) return styles.colorAmbiguous ?? ''
  return styles.colorSuccess ?? ''
}

function clarityBarClass(value: number): string {
  if (value < 4) return styles.clarityBarRed ?? ''
  if (value < 7) return styles.clarityBarAmber ?? ''
  return styles.clarityBarGreen ?? ''
}

function statusBorderClass(status: 'pass' | 'fail' | 'ambiguous'): string {
  if (status === 'pass') return styles.stepBorderPass ?? ''
  if (status === 'fail') return styles.stepBorderFail ?? ''
  return styles.stepBorderAmbiguous ?? ''
}

function severityPillClass(severity: 'critical' | 'major' | 'minor'): string {
  if (severity === 'critical') return styles.severityCritical ?? ''
  if (severity === 'major') return styles.severityMajor ?? ''
  return styles.severityMinor ?? ''
}

function priorityPillClass(priority: 'high' | 'medium' | 'low'): string {
  if (priority === 'high') return styles.priorityHigh ?? ''
  if (priority === 'medium') return styles.priorityMedium ?? ''
  return styles.priorityLow ?? ''
}

function severityDotClass(severity: 'high' | 'medium' | 'low'): string {
  if (severity === 'high') return styles.dotHigh ?? ''
  if (severity === 'medium') return styles.dotMedium ?? ''
  return styles.dotLow ?? ''
}

function categoryBadgeClass(category: string): string {
  const lower = category.toLowerCase().replace(/[\s_]+/g, '-')
  if (lower.includes('friction')) return styles.categoryFriction ?? ''
  if (lower.includes('missing-feedback')) return styles.categoryMissingFeedback ?? ''
  if (lower.includes('unnecessary-step')) return styles.categoryUnnecessaryStep ?? ''
  return styles.categoryDefault ?? ''
}

function verdictBadgeClass(verdict: 'pass' | 'fail' | 'partial'): string {
  if (verdict === 'pass') return styles.verdictPass ?? ''
  if (verdict === 'fail') return styles.verdictFail ?? ''
  return styles.verdictPartial ?? ''
}

const REC_TYPE_LABELS: Record<string, string> = {
  'fix-doc': 'Fix Documentation',
  'fix-product': 'Fix Product',
  'improve-ux': 'Improve UX',
}

/* ===== Collapsible Section ===== */

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={styles.section}>
      <div
        className={styles.sectionHeader}
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((o) => !o)
          }
        }}
      >
        <span className={styles.sectionTitle}>{title}</span>
        <span
          className={`${styles.sectionToggle} ${open ? styles.sectionToggleOpen : ''}`}
        >
          &#9656;
        </span>
      </div>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  )
}

/* ===== Main Component ===== */

export function TryDocReport({ report }: TryDocReportProps): React.ReactElement {
  const { summary, steps, failures, docIssues, uxInsights, recommendations, scores } =
    report

  /* Group failures by issue type */
  const docFailures = failures.filter((f) => f.issueType === 'doc')
  const productFailures = failures.filter((f) => f.issueType === 'product')

  /* Group recommendations by type */
  const recGroups = (['fix-doc', 'fix-product', 'improve-ux'] as const).reduce<
    Record<string, typeof recommendations>
  >(
    (acc, type) => {
      const items = recommendations.filter((r) => r.type === type)
      if (items.length > 0) acc[type] = items
      return acc
    },
    {},
  )

  return (
    <div className={styles.report}>
      {/* ===== Section 1: Summary Bar ===== */}
      <div className={styles.section}>
        <div className={styles.summaryBar}>
          <div className={styles.statCard}>
            <span className={`${styles.statValue} ${styles.colorMuted}`}>
              {summary.totalSteps}
            </span>
            <span className={styles.statLabel}>Total</span>
          </div>
          <div className={styles.statCard}>
            <span className={`${styles.statValue} ${styles.colorSuccess}`}>
              {summary.passed}
            </span>
            <span className={styles.statLabel}>Passed</span>
          </div>
          <div className={styles.statCard}>
            <span className={`${styles.statValue} ${styles.colorFail}`}>
              {summary.failed}
            </span>
            <span className={styles.statLabel}>Failed</span>
          </div>
          <div className={styles.statCard}>
            <span className={`${styles.statValue} ${styles.colorAmbiguous}`}>
              {summary.ambiguous}
            </span>
            <span className={styles.statLabel}>Ambiguous</span>
          </div>
          <div className={styles.summarySpacer} />
          <span className={`${styles.verdictBadge} ${verdictBadgeClass(summary.overallVerdict)}`}>
            {summary.overallVerdict}
          </span>
        </div>
      </div>

      {/* ===== Section 2: Step-by-step Results ===== */}
      <CollapsibleSection title="Step-by-step Results">
        <div className={styles.stepList}>
          {steps.map((step) => (
            <div
              key={step.stepIndex}
              className={`${styles.stepRow} ${statusBorderClass(step.status)}`}
            >
              <span className={styles.stepNumber}>#{step.stepIndex}</span>
              <div className={styles.stepContent}>
                <div className={styles.stepInstruction}>
                  <span className={styles.stepInstructionLabel}>Doc says:</span>
                  {step.instruction}
                </div>
                <div className={styles.stepDetail}>
                  <span className={styles.stepDetailLabel}>Result:</span>
                  {step.detail}
                </div>
                {step.issueType !== null && step.status === 'fail' && (
                  <div className={styles.stepMeta}>
                    <span
                      className={`${styles.pill} ${step.issueType === 'doc' ? styles.pillDoc : styles.pillProduct}`}
                    >
                      {step.issueType}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleSection>

      {/* ===== Section 3: Failures & Root Causes ===== */}
      {failures.length > 0 && (
        <CollapsibleSection title="Failures &amp; Root Causes">
          {docFailures.length > 0 && (
            <div className={styles.failureGroup}>
              <div className={styles.failureGroupTitle}>Documentation Issues</div>
              <div className={styles.failureCards}>
                {docFailures.map((f, i) => (
                  <div key={i} className={styles.failureCard}>
                    <div className={styles.failureCardHeader}>
                      <span className={`${styles.pill} ${severityPillClass(f.severity)}`}>
                        {f.severity}
                      </span>
                      <span className={styles.failureTitle}>{f.title}</span>
                    </div>
                    <div className={styles.failureDesc}>{f.description}</div>
                    <div className={styles.failureSuggestion}>{f.suggestion}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {productFailures.length > 0 && (
            <div className={styles.failureGroup}>
              <div className={styles.failureGroupTitle}>Product Issues</div>
              <div className={styles.failureCards}>
                {productFailures.map((f, i) => (
                  <div key={i} className={styles.failureCard}>
                    <div className={styles.failureCardHeader}>
                      <span className={`${styles.pill} ${severityPillClass(f.severity)}`}>
                        {f.severity}
                      </span>
                      <span className={styles.failureTitle}>{f.title}</span>
                    </div>
                    <div className={styles.failureDesc}>{f.description}</div>
                    <div className={styles.failureSuggestion}>{f.suggestion}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CollapsibleSection>
      )}

      {/* ===== Section 4: Documentation Issues ===== */}
      <CollapsibleSection title="Documentation Issues">
        {/* Clarity score bar */}
        <div className={styles.clarityRow}>
          <span className={styles.clarityLabel}>Clarity Score</span>
          <div className={styles.clarityBarTrack}>
            <div
              className={`${styles.clarityBarFill} ${clarityBarClass(docIssues.clarityScore)}`}
              style={{ width: `${(docIssues.clarityScore / 10) * 100}%` }}
            />
          </div>
          <span className={`${styles.clarityScore} ${scoreColorClass(docIssues.clarityScore)}`}>
            {docIssues.clarityScore}/10
          </span>
        </div>

        {/* Missing sections */}
        <div className={styles.issueListGroup}>
          <div className={styles.issueListTitle}>Missing Sections</div>
          {docIssues.missingSections.length > 0 ? (
            <ul className={styles.issueList}>
              {docIssues.missingSections.map((item, i) => (
                <li key={i} className={styles.issueListItem}>
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.emptyHint}>None detected</span>
          )}
        </div>

        {/* Ambiguous instructions */}
        <div className={styles.issueListGroup}>
          <div className={styles.issueListTitle}>Ambiguous Instructions</div>
          {docIssues.ambiguousInstructions.length > 0 ? (
            <ul className={styles.issueList}>
              {docIssues.ambiguousInstructions.map((item, i) => (
                <li key={i} className={styles.issueListItem}>
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.emptyHint}>None detected</span>
          )}
        </div>

        {/* Implicit assumptions */}
        <div className={styles.issueListGroup}>
          <div className={styles.issueListTitle}>Implicit Assumptions</div>
          {docIssues.implicitAssumptions.length > 0 ? (
            <ul className={styles.issueList}>
              {docIssues.implicitAssumptions.map((item, i) => (
                <li key={i} className={styles.issueListItem}>
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.emptyHint}>None detected</span>
          )}
        </div>
      </CollapsibleSection>

      {/* ===== Section 5: UX Insights ===== */}
      {uxInsights.length > 0 && (
        <CollapsibleSection title="UX Insights">
          <div className={styles.insightList}>
            {uxInsights.map((insight, i) => (
              <div key={i} className={styles.insightRow}>
                <div
                  className={`${styles.severityDot} ${severityDotClass(insight.severity)}`}
                />
                <span
                  className={`${styles.categoryBadge} ${categoryBadgeClass(insight.category)}`}
                >
                  {insight.category}
                </span>
                <span className={styles.insightDescription}>{insight.description}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* ===== Section 6: Recommendations ===== */}
      {recommendations.length > 0 && (
        <CollapsibleSection title="Recommendations">
          {Object.entries(recGroups).map(([type, items]) => (
            <div key={type} className={styles.recGroup}>
              <div className={styles.recGroupTitle}>
                {REC_TYPE_LABELS[type] ?? type}
              </div>
              <div className={styles.recList}>
                {items.map((rec, i) => (
                  <div key={i} className={styles.recRow}>
                    <span className={styles.recArrow}>{'\u2192'}</span>
                    <div className={styles.recContent}>
                      <div className={styles.recMeta}>
                        <span
                          className={`${styles.pill} ${priorityPillClass(rec.priority)}`}
                        >
                          {rec.priority}
                        </span>
                        <span className={styles.recTitle}>{rec.title}</span>
                      </div>
                      <div className={styles.recDesc}>{rec.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CollapsibleSection>
      )}

      {/* ===== Section 7: Global Scores ===== */}
      <div className={styles.section}>
        <div className={styles.sectionTitle} style={{ marginBottom: 'var(--space-md)' }}>
          Global Scores
        </div>
        <div className={styles.scoresGrid}>
          <div className={styles.scoreCard}>
            <span className={`${styles.scoreValue} ${scoreColorClass(scores.docQuality)}`}>
              {scores.docQuality}
            </span>
            <span className={styles.scoreLabel}>Doc Quality</span>
          </div>
          <div className={styles.scoreCard}>
            <span className={`${styles.scoreValue} ${scoreColorClass(scores.testPassRate)}`}>
              {scores.testPassRate}
            </span>
            <span className={styles.scoreLabel}>Test Pass Rate</span>
          </div>
          <div className={styles.scoreCard}>
            <span className={`${styles.scoreValue} ${scoreColorClass(scores.uxClarity)}`}>
              {scores.uxClarity}
            </span>
            <span className={styles.scoreLabel}>UX Clarity</span>
          </div>
        </div>
      </div>
    </div>
  )
}
