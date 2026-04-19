import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ActivityItemDTO, type ActivityKindDTO } from '../../../shared/api/client.js'
import { formatRelativeTime } from '../../../shared/util/relativeTime.js'
import { Spinner } from '../../../design-system/components/index.js'
import styles from './ActivityFeed.module.css'

const VERB: Record<ActivityKindDTO, string> = {
  page_edited: 'edited',
  doc_generated: 'generated',
  page_published: 'published',
  member_joined: '',
}

const ICON: Record<ActivityKindDTO, React.ReactNode> = {
  page_edited: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  ),
  doc_generated: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20" /><path d="m5 9 7-7 7 7" />
    </svg>
  ),
  page_published: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  member_joined: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
}

/**
 * Derived activity feed — reads the last ~20 events (page edits, doc
 * generations, new members) from existing tables and renders them inline.
 * Cheap: no dedicated activities table. Silent empty state when the
 * project has no recent activity.
 */
export function ActivityFeed({ projectId }: { projectId: string }): React.ReactElement | null {
  const [items, setItems] = useState<ActivityItemDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.projects
      .activity(projectId)
      .then((r) => { if (!cancelled) setItems(r.items) })
      .catch((err) => { if (!cancelled) setError((err as Error).message) })
    return () => { cancelled = true }
  }, [projectId])

  if (error) return null // fail silently — this is a nice-to-have panel
  if (!items) return <div className={styles.loading}><Spinner size="sm" /></div>
  if (items.length === 0) return null

  return (
    <div className={styles.wrap}>
      <h3 className={styles.title}>Recent activity</h3>
      <ul className={styles.list}>
        {items.map((it, idx) => {
          const actor = it.actorName ?? 'A teammate'
          const verb = VERB[it.kind]
          const body = it.kind === 'member_joined'
            ? <>{actor} · {it.subject}</>
            : <>{actor} {verb} <strong>{it.subject}</strong></>
          return (
            <li key={idx} className={styles.item}>
              <span className={styles.icon} aria-hidden>{ICON[it.kind]}</span>
              <span className={styles.body}>
                {it.href ? <Link to={it.href} className={styles.link}>{body}</Link> : body}
              </span>
              <span className={styles.time}>{formatRelativeTime(it.at)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
