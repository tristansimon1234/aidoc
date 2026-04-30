import { createContext, useContext, useCallback, useState, type ReactNode } from 'react'

export type JobType = 'doc-gen' | 'voiceover' | 'try-doc' | 'marketing-video'
export type JobStatus = 'running' | 'completed' | 'failed'

export interface Job {
  runId: string
  pageId: string
  pageTitle: string
  type: JobType
  status: JobStatus
  startedAt: number
  liveUrl?: string
  phaseStartedAt?: number
  /** Human-readable failure reason — surfaced in the tracker card when status='failed'. */
  error?: string | null
  /** Machine-readable code (e.g. "QUOTA_EXCEEDED") so the UI can branch: upgrade CTA vs. generic retry. */
  errorCode?: string | null
}

interface JobContextValue {
  jobs: Job[]
  addJob: (job: Omit<Job, 'startedAt'>) => void
  updateJob: (runId: string, updates: Partial<Pick<Job, 'status' | 'liveUrl' | 'phaseStartedAt' | 'error' | 'errorCode'>>) => void
  removeJob: (runId: string) => void
  getJobForPage: (pageId: string, type: JobType) => Job | undefined
  /** Convenience: mark a job failed with a human error + optional code. Also used
   *  when the sync HTTP request itself fails (before any backend job was created). */
  failJob: (runId: string, error: string, code?: string | null) => void
}

const JobContext = createContext<JobContextValue | null>(null)

export function JobProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [jobs, setJobs] = useState<Job[]>([])

  const addJob = useCallback((job: Omit<Job, 'startedAt'>) => {
    setJobs((prev) => {
      // Replace existing job of same type for same page
      const filtered = prev.filter((j) => !(j.pageId === job.pageId && j.type === job.type))
      return [...filtered, { ...job, startedAt: Date.now() }]
    })
  }, [])

  const updateJob = useCallback((runId: string, updates: Partial<Pick<Job, 'status' | 'liveUrl' | 'phaseStartedAt' | 'error' | 'errorCode'>>) => {
    setJobs((prev) => prev.map((j) => j.runId === runId ? { ...j, ...updates } : j))
  }, [])

  const removeJob = useCallback((runId: string) => {
    setJobs((prev) => prev.filter((j) => j.runId !== runId))
  }, [])

  const getJobForPage = useCallback((pageId: string, type: JobType) => {
    return jobs.find((j) => j.pageId === pageId && j.type === type)
  }, [jobs])

  const failJob = useCallback((runId: string, error: string, code: string | null = null) => {
    setJobs((prev) => prev.map((j) => j.runId === runId ? { ...j, status: 'failed' as const, error, errorCode: code } : j))
  }, [])

  return (
    <JobContext.Provider value={{ jobs, addJob, updateJob, removeJob, getJobForPage, failJob }}>
      {children}
    </JobContext.Provider>
  )
}

export function useJobs(): JobContextValue {
  const ctx = useContext(JobContext)
  if (!ctx) throw new Error('useJobs must be used within JobProvider')
  return ctx
}
