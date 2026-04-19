import { Link } from 'react-router-dom'
import { useQuotaStatus } from '../hooks/useQuotaStatus.js'
import styles from './QuotaBanner.module.css'

/**
 * Persistent red strip above the topbar shown whenever the logged-in user's
 * plan is hard-capped and fully consumed. Drives upgrades without the user
 * needing to open a specific feature tab first to discover they're blocked.
 * Silent for plans with overage enabled (Growth / Business) — they pay-as-
 * you-go and don't need the CTA.
 */
export function QuotaBanner(): React.ReactElement | null {
  const { loading, allowed, percent, planName, workspaceName } = useQuotaStatus()
  if (loading || allowed) return null

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.icon} aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
      <span className={styles.text}>
        <strong>Monthly quota exhausted</strong>
        {workspaceName && <> for <strong>{workspaceName}</strong></>}
        {' '}— the {planName ?? 'current'} plan is at {Math.round(percent)}%.
        {' '}Upgrade to continue using AI.
      </span>
      <Link to="/account?tab=billing" className={styles.link}>Upgrade plan →</Link>
    </div>
  )
}
