import { useEffect, useRef } from 'react'
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

  useEffect(() => {
    const runningJobs = jobs.filter((j) => j.status === 'running')
    if (runningJobs.length === 0) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
      return
    }

    const runningIds = runningJobs.map((j) => j.runId)

    const poll = async (): Promise<void> => {
      try {
        const { data } = await supabase
          .from('jobs')
          .select('id, run_id, status, error')
          .in('run_id', runningIds)
          .order('created_at', { ascending: false })

        if (!data) return
        for (const row of data) {
          const status = row.status as string
          if (status === 'completed' || status === 'failed') {
            updateJob(row.run_id as string, { status: status as 'completed' | 'failed' })
          }
        }
      } catch {
        // Query failed — retry next cycle
      }
    }

    void poll()
    intervalRef.current = setInterval(() => void poll(), 5000)

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    }
  }, [jobs, updateJob])
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
        const { data } = await supabase
          .from('jobs')
          .select('run_id, page_id, type, status, created_at')
          .eq('project_id', projectId)
          .in('status', ['running'])
          .order('created_at', { ascending: false })

        if (!data) return

        // Also fetch page titles for display
        const pageIds = [...new Set(data.map((j) => j.page_id as string))]
        const { data: pages } = await supabase
          .from('doc_pages')
          .select('id, title')
          .in('id', pageIds)

        const titleMap = new Map((pages ?? []).map((p) => [p.id as string, p.title as string]))

        for (const row of data) {
          addJob({
            runId: row.run_id as string,
            pageId: row.page_id as string,
            pageTitle: titleMap.get(row.page_id as string) ?? 'Page',
            type: row.type as 'doc-gen' | 'voiceover' | 'try-doc',
            status: 'running',
          })
        }
      } catch {
        // Failed to load — jobs will appear when created
      }
    })()
  }, [projectId, addJob])
}
