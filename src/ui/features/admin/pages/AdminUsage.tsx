import { useEffect, useState } from 'react'
import { Shell } from '../../../shared/layout/Shell.js'
import { Spinner } from '../../../design-system/components/index.js'
import { api, type AdminUsageReportDTO } from '../../../shared/api/client.js'
import styles from './AdminUsage.module.css'

function currentMonthYYYYMM(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

export function AdminUsage(): React.ReactElement {
  const [month, setMonth] = useState<string>(currentMonthYYYYMM())
  const [report, setReport] = useState<AdminUsageReportDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const r = await api.admin.usage(month)
        if (!cancelled) setReport(r)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [month])

  const totals = report?.users.reduce(
    (acc, u) => ({
      docRun: acc.docRun + u.counts.doc_run,
      voiceover: acc.voiceover + u.counts.voiceover,
      tryDoc: acc.tryDoc + u.counts.try_doc,
      chatSessions: acc.chatSessions + u.counts.chat_sessions,
      euroCost: acc.euroCost + u.euroCost,
    }),
    { docRun: 0, voiceover: 0, tryDoc: 0, chatSessions: 0, euroCost: 0 },
  )

  const formatEuro = (n: number): string =>
    n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'

  return (
    <Shell>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Admin · Usage</h1>
          <input
            type="month"
            className={styles.monthInput}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>

        {loading && (
          <div className={styles.loading}><Spinner size="md" /></div>
        )}

        {error && !loading && (
          <div className={styles.error}>{error}</div>
        )}

        {report && !loading && (
          <>
            {totals && (
              <div className={styles.totals}>
                <div><span className={styles.totalsLabel}>Users</span><span className={styles.totalsValue}>{report.users.length}</span></div>
                <div><span className={styles.totalsLabel}>Doc gens</span><span className={styles.totalsValue}>{formatNumber(totals.docRun)}</span></div>
                <div><span className={styles.totalsLabel}>Voice-overs</span><span className={styles.totalsValue}>{formatNumber(totals.voiceover)}</span></div>
                <div><span className={styles.totalsLabel}>Try Doc</span><span className={styles.totalsValue}>{formatNumber(totals.tryDoc)}</span></div>
                <div><span className={styles.totalsLabel}>Chat sessions</span><span className={styles.totalsValue}>{formatNumber(totals.chatSessions)}</span></div>
                <div><span className={styles.totalsLabel}>AI cost</span><span className={styles.totalsValue}>{formatEuro(totals.euroCost)}</span></div>
              </div>
            )}

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th className={styles.num}>Doc gens</th>
                    <th className={styles.num}>Voice-overs</th>
                    <th className={styles.num}>Try Doc</th>
                    <th className={styles.num}>Chat</th>
                    <th className={styles.num}>AI cost</th>
                    <th className={styles.num}>Quota %</th>
                  </tr>
                </thead>
                <tbody>
                  {report.users.map((u) => {
                    const overClass = u.percent >= 100 ? styles.rowOver : u.percent >= 80 ? styles.rowWarn : ''
                    return (
                      <tr key={u.userId} className={overClass}>
                        <td>
                          <div className={styles.userCell}>
                            <span className={styles.userEmail}>{u.email ?? '—'}</span>
                            {u.fullName && <span className={styles.userName}>{u.fullName}</span>}
                          </div>
                        </td>
                        <td><span className={styles.planBadge}>{u.planId ?? '—'}</span></td>
                        <td className={styles.num}>{formatNumber(u.counts.doc_run)}</td>
                        <td className={styles.num}>{formatNumber(u.counts.voiceover)}</td>
                        <td className={styles.num}>{formatNumber(u.counts.try_doc)}</td>
                        <td className={styles.num}>{formatNumber(u.counts.chat_sessions)}</td>
                        <td className={styles.num} title={`Doc ${formatEuro(u.euroByFeature.doc_run)} · VO ${formatEuro(u.euroByFeature.voiceover)} · Try ${formatEuro(u.euroByFeature.try_doc)} · Chat ${formatEuro(u.euroByFeature.chat_sessions)}`}>
                          {formatEuro(u.euroCost)}
                        </td>
                        <td className={styles.num}>{u.percent.toFixed(1)}</td>
                      </tr>
                    )
                  })}
                  {report.users.length === 0 && (
                    <tr><td colSpan={8} className={styles.empty}>No data for this month.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Shell>
  )
}
