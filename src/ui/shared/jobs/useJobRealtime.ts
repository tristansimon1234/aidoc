import { useEffect } from 'react'
import { supabase } from '../api/supabase.js'
import { useJobs } from './JobContext.js'

/**
 * Subscribe to Supabase Realtime for run status changes.
 * When a tracked job's run status changes to completed/failed,
 * updates the job tracker automatically.
 */
export function useJobRealtime(): void {
  const { jobs, updateJob } = useJobs()

  useEffect(() => {
    const trackedRunIds = jobs.filter((j) => j.status === 'running').map((j) => j.runId)
    if (trackedRunIds.length === 0) return

    const channel = supabase
      .channel('job-tracker')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'runs' },
        (payload) => {
          const row = payload.new as { id: string; status: string }
          if (!trackedRunIds.includes(row.id)) return

          if (row.status === 'completed') {
            updateJob(row.id, { status: 'completed' })
          } else if (row.status === 'failed') {
            updateJob(row.id, { status: 'failed' })
          }
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [jobs, updateJob])
}
