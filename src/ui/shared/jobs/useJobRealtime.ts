import { useEffect, useRef, useMemo } from 'react'
import { supabase } from '../api/supabase.js'
import { useJobs } from './JobContext.js'

/**
 * Subscribe to Supabase Realtime on the jobs table.
 * When a tracked job's status changes to completed/failed, updates the context.
 * Falls back to polling every 10s in case Realtime misses an event.
 */
export function useJobRealtime(): void {
  const { jobs, updateJob } = useJobs()
  const updateJobRef = useRef(updateJob)
  updateJobRef.current = updateJob

  const runningIds = useMemo(
    () => jobs.filter((j) => j.status === 'running').map((j) => j.runId).sort().join(','),
    [jobs],
  )

  useEffect(() => {
    if (!runningIds) return

    const ids = new Set(runningIds.split(','))

    const handleUpdate = (row: { run_id: string; status: string }) => {
      if (!ids.has(row.run_id)) return
      if (row.status === 'completed' || row.status === 'failed') {
        updateJobRef.current(row.run_id, { status: row.status as 'completed' | 'failed' })
      }
    }

    // Primary: Supabase Realtime subscription
    const channel = supabase
      .channel(`jobs-${runningIds}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'jobs' },
        (payload) => handleUpdate(payload.new as { run_id: string; status: string }),
      )
      .subscribe()

    // Fallback: poll every 10s in case Realtime misses
    const fallback = setInterval(() => {
      void (async () => {
        try {
          const { data } = await supabase
            .from('jobs')
            .select('run_id, status')
            .in('run_id', [...ids])
            .order('created_at', { ascending: false })

          // Only use the LATEST job per run_id (ignore old completed ones)
          const seen = new Set<string>()
          for (const row of data ?? []) {
            const rid = row.run_id as string
            if (seen.has(rid)) continue
            seen.add(rid)
            handleUpdate(row as { run_id: string; status: string })
          }
        } catch { /* retry next cycle */ }
      })()
    }, 10000)

    return () => {
      void supabase.removeChannel(channel)
      clearInterval(fallback)
    }
  }, [runningIds])

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
