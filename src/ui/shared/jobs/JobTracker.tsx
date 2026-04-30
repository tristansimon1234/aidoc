import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useJobs, type Job } from './JobContext.js'
import { useJobRealtime } from './useJobRealtime.js'
import styles from './JobTracker.module.css'

const TYPE_LABELS: Record<Job['type'], string> = {
  'doc-gen': 'Generating documentation',
  'voiceover': 'Generating voice-over',
  'try-doc': 'Running test',
  'marketing-video': 'Generating marketing video',
}

const COMPLETED_LABELS: Record<Job['type'], string> = {
  'doc-gen': 'Documentation ready',
  'voiceover': 'Voice-over ready',
  'try-doc': 'Test complete',
  'marketing-video': 'Marketing video ready',
}

function elapsed(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function JobCard({ job, onDismiss, onNavigate }: { job: Job; onDismiss: () => void; onNavigate: () => void }): React.ReactElement {
  // Auto-dismiss completed jobs after 10s
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (job.status === 'completed' || job.status === 'failed') {
      timerRef.current = setTimeout(onDismiss, 10000)
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [job.status, onDismiss])

  // Tick elapsed time for running jobs
  const [, setTick] = useState(0)
  useEffect(() => {
    if (job.status !== 'running') return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [job.status])

  return (
    <div className={styles.card} onClick={onNavigate}>
      <div className={styles.icon}>
        {job.status === 'running' && <div className={styles.spinner} />}
        {job.status === 'completed' && (
          <svg className={styles.successIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        )}
        {job.status === 'failed' && (
          <svg className={styles.failIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.title}>{job.pageTitle}</div>
        <div className={styles.subtitle}>
          {job.status === 'running' && `${TYPE_LABELS[job.type]} — ${elapsed(job.startedAt)}`}
          {job.status === 'completed' && COMPLETED_LABELS[job.type]}
          {job.status === 'failed' && (
            job.errorCode === 'QUOTA_EXCEEDED'
              ? 'Monthly quota exhausted — upgrade to continue.'
              : (job.error && job.error.length > 0)
                ? job.error
                : `${TYPE_LABELS[job.type]} failed`
          )}
        </div>
        {job.status === 'failed' && job.errorCode === 'QUOTA_EXCEEDED' && (
          <a
            href="/account?tab=billing"
            className={styles.upgradeLink}
            onClick={(e) => e.stopPropagation()}
          >
            Upgrade plan →
          </a>
        )}
      </div>
      <button className={styles.dismiss} onClick={(e) => { e.stopPropagation(); onDismiss() }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
  )
}

export function JobTracker(): React.ReactElement | null {
  const { jobs, removeJob } = useJobs()
  const navigate = useNavigate()
  useJobRealtime()

  if (jobs.length === 0) return null

  return (
    <div className={styles.tracker}>
      {jobs.map((job) => (
        <JobCard
          key={job.runId}
          job={job}
          onDismiss={() => removeJob(job.runId)}
          onNavigate={() => {
            // Navigate to the page — projectId is embedded in the URL already
            const path = window.location.pathname
            const projectMatch = path.match(/\/projects\/([^/]+)/)
            if (projectMatch) {
              navigate(`/projects/${projectMatch[1]}/pages/${job.pageId}`)
            }
          }}
        />
      ))}
    </div>
  )
}

/** Topbar badge showing active job count */
export function JobBadge(): React.ReactElement | null {
  const { jobs } = useJobs()
  const active = jobs.filter((j) => j.status === 'running').length
  if (active === 0) return null
  return <span className={styles.badge}>{active}</span>
}
