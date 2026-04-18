import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button, Spinner, EmptyState } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import {
  api,
  type AnalyticsMessageCategoryDTO,
  type AnalyticsPeriodDTO,
  type AnalyticsReportDTO,
  type AnalyticsRecommendationsDTO,
  type ProjectDTO,
} from '../../../shared/api/client.js'
import styles from './AnalyticsPage.module.css'

const PERIODS: { id: AnalyticsPeriodDTO; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
]

const SOURCE_COLORS: Record<'widget' | 'public' | 'app', string> = {
  widget: 'var(--color-primary)',
  public: 'var(--color-success)',
  app: 'var(--color-warning)',
}

const CATEGORY_LABELS: Record<AnalyticsMessageCategoryDTO, string> = {
  onboarding: 'Onboarding',
  pricing: 'Pricing & plans',
  'how-to': 'How-to',
  error: 'Errors / bugs',
  integration: 'Integration',
  account: 'Account & login',
  other: 'Other',
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

function SeverityPill({ level }: { level: 'high' | 'medium' | 'low' }): React.ReactElement {
  return <span className={`${styles.pill} ${styles[`pill_${level}`]}`}>{level}</span>
}

function SourceBar({ bySource, total }: {
  bySource: AnalyticsReportDTO['chatStats']['bySource']
  total: number
}): React.ReactElement {
  if (total === 0) return <div className={styles.bar}><div className={styles.barEmpty}>No messages yet</div></div>
  const segments = (['widget', 'public', 'app'] as const).map((src) => ({
    src,
    messages: bySource[src].messages,
    pct: (bySource[src].messages / total) * 100,
  })).filter((s) => s.pct > 0)
  return (
    <div>
      <div className={styles.bar}>
        {segments.map((s) => (
          <div
            key={s.src}
            className={styles.barSegment}
            style={{ width: `${s.pct}%`, background: SOURCE_COLORS[s.src] }}
            title={`${s.src}: ${s.messages} messages`}
          />
        ))}
      </div>
      <div className={styles.legend}>
        {(['widget', 'public', 'app'] as const).map((src) => (
          <span key={src} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: SOURCE_COLORS[src] }} />
            {src} · {formatNumber(bySource[src].messages)} msgs · {formatNumber(bySource[src].sessions)} sessions
          </span>
        ))}
      </div>
    </div>
  )
}

export function AnalyticsPage(): React.ReactElement {
  const { project } = useOutletContext<{ project: ProjectDTO }>()
  const [period, setPeriod] = useState<AnalyticsPeriodDTO>('30d')
  const { data, loading, error } = useAsync(() => api.analytics.report(project.id, period), [project.id, period])
  const [sampleFilter, setSampleFilter] = useState<'all' | 'negative' | 'frustrated'>('all')

  // Recommendations (explicit owner action)
  const [recos, setRecos] = useState<AnalyticsRecommendationsDTO | null>(null)
  const [recosLoading, setRecosLoading] = useState(false)
  const [recosError, setRecosError] = useState<string | null>(null)

  const handleGenerateRecos = async (): Promise<void> => {
    setRecosLoading(true); setRecosError(null)
    try {
      const result = await api.analytics.recommendations(project.id, period)
      setRecos(result)
    } catch (err) {
      setRecosError((err as Error).message)
    } finally {
      setRecosLoading(false)
    }
  }

  // Reset on-demand state when period changes
  useMemo(() => { setRecos(null); setRecosError(null) }, [period])

  const kpis = useMemo(() => {
    if (!data) return null
    const { userMessages, sentimentCounts } = data.chatStats
    const negativePct = userMessages > 0 ? Math.round((sentimentCounts.negative / userMessages) * 100) : 0
    return [
      { label: 'Sessions', value: formatNumber(data.chatStats.totalSessions) },
      { label: 'Messages', value: formatNumber(data.chatStats.totalMessages) },
      { label: 'Avg / session', value: data.chatStats.avgMessagesPerSession.toFixed(1) },
      {
        label: '% negative',
        value: sentimentCounts.classified === 0 ? '—' : `${negativePct}%`,
        hint: `${formatNumber(sentimentCounts.negative)} negative · ${formatNumber(sentimentCounts.frustrated)} frustrated`,
      },
      { label: 'Page views', value: formatNumber(data.viewStats.totalViews) },
      { label: 'Unique visitors', value: formatNumber(data.viewStats.uniqueSessions) },
    ]
  }, [data])

  const filteredSamples = useMemo(() => {
    if (!data) return []
    const users = data.recentSamples.filter((s) => s.role === 'user')
    if (sampleFilter === 'negative') return users.filter((s) => s.sentiment === 'negative')
    if (sampleFilter === 'frustrated') return users.filter((s) => s.frustrationFlag)
    return users
  }, [data, sampleFilter])

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Analytics</h1>
          <p className={styles.subtitle}>What your users ask, what frustrates them, and where to fix next — all derived from the conversations they had with your chat.</p>
        </div>
        <div className={styles.periodGroup}>
          {PERIODS.map((p) => (
            <button
              key={p.id}
              className={`${styles.periodBtn} ${period === p.id ? styles.periodBtnActive : ''}`}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className={styles.center}><Spinner size="lg" /></div>}
      {error && <EmptyState title="Failed to load analytics" description={error} />}

      {data && (
        <>
          {kpis && (
            <div className={styles.kpis}>
              {kpis.map((k) => (
                <div key={k.label} className={styles.kpiCard} title={'hint' in k ? (k as { hint?: string }).hint : undefined}>
                  <span className={styles.kpiLabel}>{k.label}</span>
                  <span className={styles.kpiValue}>{k.value}</span>
                  {'hint' in k && (k as { hint?: string }).hint && (
                    <span className={styles.kpiHint}>{(k as { hint: string }).hint}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className={styles.twoCol}>
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Where messages come from</h2>
              <SourceBar bySource={data.chatStats.bySource} total={data.chatStats.totalMessages} />
            </div>

            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Top pages (public docs)</h2>
              {data.viewStats.topPages.length === 0 ? (
                <p className={styles.empty}>No page views in this period.</p>
              ) : (
                <table className={styles.table}>
                  <tbody>
                    {data.viewStats.topPages.map((p) => (
                      <tr key={p.slug}>
                        <td>{p.title ?? p.slug}</td>
                        <td className={styles.numCell}>{formatNumber(p.views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Pain points by topic</h2>
            {data.painPoints.length === 0 ? (
              <p className={styles.empty}>Not enough classified messages yet. Come back once users have asked a few questions.</p>
            ) : (
              <ul className={styles.painList}>
                {data.painPoints.map((pp) => {
                  const intensity = pp.total === 0 ? 0 : Math.round(((pp.negative + pp.frustrated) / pp.total) * 100)
                  return (
                    <li key={pp.category} className={styles.painItem}>
                      <div className={styles.painHeader}>
                        <span className={styles.painCategory}>{CATEGORY_LABELS[pp.category]}</span>
                        <span className={styles.painStats}>
                          <span>{pp.total} msgs</span>
                          {pp.negative > 0 && <span className={styles.negativeChip}>{pp.negative} negative</span>}
                          {pp.frustrated > 0 && <span className={styles.frustrationChip}>{pp.frustrated} frustrated</span>}
                          {intensity > 0 && <span className={styles.painIntensity}>{intensity}% pain</span>}
                        </span>
                      </div>
                      {pp.examples.length > 0 && (
                        <ul className={styles.quoteList}>
                          {pp.examples.map((q, i) => <li key={i}>"{q}"</li>)}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Frustration signals</h2>
            {data.frustrationSignals.length === 0 ? (
              <p className={styles.empty}>No frustration signals picked up — 🎉</p>
            ) : (
              <ul className={styles.signalList}>
                {data.frustrationSignals.map((s, i) => (
                  <li key={i} className={styles.signalItem}>
                    <span className={styles.signalSource} style={{ color: SOURCE_COLORS[s.source] }}>{s.source}</span>
                    <span className={styles.signalContent}>
                      "{s.content}"
                      {s.category && <span className={styles.signalCategory}>{CATEGORY_LABELS[s.category]}</span>}
                    </span>
                    <span className={styles.signalDate}>{new Date(s.createdAt).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.recoHeader}>
              <div>
                <h2 className={styles.sectionTitle}>AI recommendations</h2>
                <p className={styles.recoDesc}>On-demand: we ask Gemini to synthesise prioritised fixes from the last 200 user messages. Fresh every 5 minutes, or on your click.</p>
              </div>
              <Button size="sm" onClick={() => void handleGenerateRecos()} disabled={recosLoading}>
                {recosLoading ? 'Generating…' : recos ? 'Regenerate' : 'Generate recommendations'}
              </Button>
            </div>
            {recosError && <p className={styles.recoError}>{recosError}</p>}
            {recos && (
              <>
                <p className={styles.summary}>{recos.summary}</p>
                {recos.items.length === 0 ? (
                  <p className={styles.empty}>Not enough signal for actionable recommendations yet.</p>
                ) : (
                  <ul className={styles.recoList}>
                    {recos.items.map((r, i) => (
                      <li key={i} className={styles.recoItem}>
                        <div className={styles.recoItemHeader}>
                          <span className={styles.recoTitleText}>{r.title}</span>
                          <span className={styles.insightMeta}>
                            <span className={styles.recType}>{r.type}</span>
                            <SeverityPill level={r.priority} />
                          </span>
                        </div>
                        <p className={styles.suggestion}>{r.description}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={styles.recoFootnote}>Generated {new Date(recos.generatedAt).toLocaleString()}</p>
              </>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.samplesHeader}>
              <h2 className={styles.sectionTitle}>Recent user messages</h2>
              <div className={styles.filterGroup}>
                {(['all', 'negative', 'frustrated'] as const).map((f) => (
                  <button
                    key={f}
                    className={`${styles.filterBtn} ${sampleFilter === f ? styles.filterBtnActive : ''}`}
                    onClick={() => setSampleFilter(f)}
                  >
                    {f === 'all' ? 'All' : f === 'negative' ? `Negative (${data.chatStats.sentimentCounts.negative})` : `Frustrated (${data.chatStats.sentimentCounts.frustrated})`}
                  </button>
                ))}
              </div>
            </div>
            {filteredSamples.length === 0 ? (
              <p className={styles.empty}>
                {sampleFilter === 'all' ? 'No recent messages.' : 'No messages match this filter in the recent window.'}
              </p>
            ) : (
              <ul className={styles.samplesList}>
                {filteredSamples.map((s, i) => (
                  <li key={i} className={styles.sampleRow}>
                    <span className={styles.sampleSource} style={{ color: SOURCE_COLORS[s.source] }}>{s.source}</span>
                    <span className={styles.sampleText}>
                      {s.content}
                      {s.frustrationFlag && <span className={styles.frustrationChip}>frustrated</span>}
                      {s.sentiment === 'negative' && !s.frustrationFlag && <span className={styles.negativeChip}>negative</span>}
                      {s.category && <span className={styles.signalCategory}>{CATEGORY_LABELS[s.category]}</span>}
                    </span>
                    <span className={styles.sampleDate}>{new Date(s.createdAt).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
