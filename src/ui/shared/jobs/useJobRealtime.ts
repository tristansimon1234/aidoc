import { useEffect, useRef, useMemo } from 'react'
import { supabase } from '../api/supabase.js'
import { useJobs } from './JobContext.js'

/**
 * Poll the jobs table for status updates.
 * Checks every 5s if any running job has completed or failed.
 * Jobs live in DB so they survive browser refresh and tab changes.
 */
export function useJobRealtime(): void {
  const { jobs, updateJob } = useJobs()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const updateJobRef = useRef(updateJob)
  updateJobRef.current = updateJob

  // Stable string key — only re-subscribe when the set of running IDs changes
  const runningIds = useMemo(
    () => jobs.filter((j) => j.status === 'running').map((j) => j.runId).sort().join(','),
    [jobs],
  )

  useEffect(() => {
    if (!runningIds) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
      return
    }

    const ids = runningIds.split(',')

    const poll = async (): Promise<void> => {
      try {
        const { data } = await supabase
          .from('jobs')
          .select('id, run_id, status')
          .in('run_id', ids)

        if (!data) return
        for (const row of data) {
          const status = row.status as string
          if (status === 'completed' || status === 'failed') {
            updateJobRef.current(row.run_id as string, { status: status as 'completed' | 'failed' })
          }
        }
      } catch {
        // Retry next cycle
      }
    }

    void poll()
    intervalRef.current = setInterval(() => void poll(), 5000)

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    }
  }, [runningIds]) // Stable dep — only changes when running job set changes

  return
}

/**
 * Load running jobs from DB on mount.
 * Called once per project to restore job state after browser refresh.
 */
export function useLoadJobsFromDB(projectId: string | undefined): void {
  const { addJob } = useJobs()
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!projectId || loadedRef.current) return
    loadedRef.current = true

    void (async () => {
      try {
        // Single query with page title join
        const { data } = await supabase
          .from('jobs')
          .select('run_id, page_id, type, status, doc_pages!inner(title)')
          .eq('project_id', projectId)
          .eq('status', 'running')
          .order('created_at', { ascending: false })

        if (!data) return

        for (const row of data) {
          const pages = row.doc_pages as unknown as { title: string } | { title: string }[]
          const title = Array.isArray(pages) ? pages[0]?.title : pages?.title
          addJob({
            runId: row.run_id as string,
            pageId: row.page_id as string,
            pageTitle: title ?? 'Page',
            type: row.type as 'doc-gen' | 'voiceover' | 'try-doc',
            status: 'running',
          })
        }
      } catch (err) {
        console.warn('[jobs] Failed to load from DB:', err)
      }
    })()
  }, [projectId, addJob])
}
