import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Spinner, EmptyState } from '../../../design-system/components/index.js'
import { useAsync } from '../../../shared/hooks/useAsync.js'
import { api, type AnalyticsPeriodDTO, type AnalyticsReportDTO, type ProjectDTO } from '../../../shared/api/client.js'
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

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

function SeverityPill({ level }: { level: 'high' | 'medium' | 'low' }): React.ReactElement {
  return <span className={`${styles.pill} ${styles[`pill_${level}`]}`}>{level}</span>
}

function SentimentBadge({ score }: { score: 'positive' | 'neutral' | 'negative' | 'mixed' }): React.ReactElement {
  return <span className={`${styles.sentiment} ${styles[`sentiment_${score}`]}`}>{score}</span>
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

  const kpis = useMemo(() => {
    if (!data) return null
    return [
      { label: 'Sessions', value: formatNumber(data.chatStats.totalSessions) },
      { label: 'Messages', value: formatNumber(data.chatStats.totalMessages) },
      { label: 'Avg / session', value: data.chatStats.avgMessagesPerSession.toFixed(1) },
      { label: 'Page views', value: formatNumber(data.viewStats.totalViews) },
      { label: 'Unique visitors', value: formatNumber(data.viewStats.uniqueSessions) },
    ]
  }, [data])

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Analytics</h1>
          <p className={styles.subtitle}>How users interact with your chat and public docs — with an AI-generated read on what to fix next.</p>
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
                <div key={k.label} className={styles.kpiCard}>
                  <span className={styles.kpiLabel}>{k.label}</span>
                  <span className={styles.kpiValue}>{k.value}</span>
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
            <div className={styles.insightsHeader}>
              <h2 className={styles.sectionTitle}>AI insights</h2>
              {data.insights && <SentimentBadge score={data.insights.overallSentiment.score} />}
            </div>
            {!data.insights ? (
              <p className={styles.empty}>Not enough messages yet — ask users to chat with the docs and come back in a bit.</p>
            ) : (
              <>
                <p className={styles.summary}>{data.insights.overallSentiment.summary}</p>

                <InsightsBlock
                  title="Pain points"
                  empty="No recurring pain points surfaced."
                  items={data.insights.painPoints.map((p) => ({
                    title: `${p.topic}`,
                    meta: <>{p.frequency > 0 && <span>{p.frequency}×</span>} <SeverityPill level={p.severity} /></>,
                    body: p.examples.length > 0 ? <ul className={styles.quoteList}>{p.examples.map((e, i) => <li key={i}>"{e}"</li>)}</ul> : null,
                  }))}
                />

                <InsightsBlock
                  title="Content gaps"
                  empty="No content gaps detected."
                  items={data.insights.contentGaps.map((g) => ({
                    title: g.question,
                    meta: g.askedCount > 0 ? <span>{g.askedCount} asks</span> : null,
                    body: g.suggestedPage ? <p className={styles.suggestion}>Suggested page: <b>{g.suggestedPage}</b></p> : null,
                  }))}
                />

                <InsightsBlock
                  title="Frustration signals"
                  empty="No frustration signals picked up — 🎉"
                  items={data.insights.frustrationSignals.map((s) => ({
                    title: `"${s.excerpt}"`,
                    meta: <SeverityPill level={s.severity} />,
                    body: <p className={styles.suggestion}>{s.reason}</p>,
                  }))}
                />

                <InsightsBlock
                  title="Recommendations"
                  empty="No actionable recommendations yet."
                  items={data.insights.recommendations.map((r) => ({
                    title: r.title,
                    meta: <><span className={styles.recType}>{r.type}</span><SeverityPill level={r.priority} /></>,
                    body: <p className={styles.suggestion}>{r.description}</p>,
                  }))}
                />
              </>
            )}
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Recent user messages</h2>
            {data.recentSamples.length === 0 ? (
              <p className={styles.empty}>No recent messages.</p>
            ) : (
              <ul className={styles.samplesList}>
                {data.recentSamples.filter((s) => s.role === 'user').map((s, i) => (
                  <li key={i} className={styles.sampleRow}>
                    <span className={styles.sampleSource} style={{ color: SOURCE_COLORS[s.source] }}>{s.source}</span>
                    <span className={styles.sampleText}>{s.content}</span>
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

interface InsightItem { title: React.ReactNode; meta?: React.ReactNode; body?: React.ReactNode }

function InsightsBlock({ title, empty, items }: { title: string; empty: string; items: InsightItem[] }): React.ReactElement {
  return (
    <div className={styles.insightGroup}>
      <h3 className={styles.insightTitle}>{title}</h3>
      {items.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <ul className={styles.insightList}>
          {items.map((it, i) => (
            <li key={i} className={styles.insightItem}>
              <div className={styles.insightHeader}>
                <span className={styles.insightLabel}>{it.title}</span>
                {it.meta && <span className={styles.insightMeta}>{it.meta}</span>}
              </div>
              {it.body && <div className={styles.insightBody}>{it.body}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
