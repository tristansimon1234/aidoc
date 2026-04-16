import { useEffect, useRef } from 'react'
import { supabase } from '../api/supabase.js'
import { useJobs } from './JobContext.js'

/**
 * Poll run status for tracked jobs.
 * Checks every 5s if a running job's run has completed/failed.
 * More reliable than Realtime (which misses updates when status doesn't change).
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

    const poll = async (): Promise<void> => {
      for (const job of runningJobs) {
        try {
          const { data } = await supabase
            .from('runs')
            .select('status, summary_json')
            .eq('id', job.runId)
            .single()

          if (!data) continue

          const status = data.status as string
          const summary = data.summary_json as Record<string, unknown> | null

          // For doc-gen: check that doc generation actually completed (not just video analysis)
          if (job.type === 'doc-gen') {
            // If run failed, mark job failed
            if (status === 'failed') {
              updateJob(job.runId, { status: 'failed' })
              continue
            }
            // Check if generated_docs exists for this run (means doc gen completed)
            const { data: docData } = await supabase
              .from('generated_docs')
              .select('id')
              .eq('run_id', job.runId)
              .maybeSingle()
            if (docData) {
              updateJob(job.runId, { status: 'completed' })
            }
            continue
          }

          // For voiceover: check if summary has voiceover data
          if (job.type === 'voiceover') {
            if (summary?.voiceover) {
              updateJob(job.runId, { status: 'completed' })
            } else if (status === 'failed') {
              updateJob(job.runId, { status: 'failed' })
            }
            continue
          }

          // For other job types: just check run status
          if (status === 'completed') {
            updateJob(job.runId, { status: 'completed' })
          } else if (status === 'failed') {
            updateJob(job.runId, { status: 'failed' })
          }
        } catch {
          // Query failed — skip this cycle
        }
      }
    }

    // Poll immediately + every 5s
    void poll()
    intervalRef.current = setInterval(() => void poll(), 5000)

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    }
  }, [jobs, updateJob])
}
