import { createContext, useContext, useCallback, useState, type ReactNode } from 'react'

export type JobType = 'doc-gen' | 'voiceover' | 'try-doc' | 'video-analysis'
export type JobStatus = 'running' | 'completed' | 'failed'

export interface Job {
  runId: string
  pageId: string
  pageTitle: string
  type: JobType
  status: JobStatus
  startedAt: number
}

interface JobContextValue {
  jobs: Job[]
  addJob: (job: Omit<Job, 'startedAt'>) => void
  updateJob: (runId: string, updates: Partial<Pick<Job, 'status'>>) => void
  removeJob: (runId: string) => void
  getJobForPage: (pageId: string, type: JobType) => Job | undefined
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

  const updateJob = useCallback((runId: string, updates: Partial<Pick<Job, 'status'>>) => {
    setJobs((prev) => prev.map((j) => j.runId === runId ? { ...j, ...updates } : j))
  }, [])

  const removeJob = useCallback((runId: string) => {
    setJobs((prev) => prev.filter((j) => j.runId !== runId))
  }, [])

  const getJobForPage = useCallback((pageId: string, type: JobType) => {
    return jobs.find((j) => j.pageId === pageId && j.type === type)
  }, [jobs])

  return (
    <JobContext.Provider value={{ jobs, addJob, updateJob, removeJob, getJobForPage }}>
      {children}
    </JobContext.Provider>
  )
}

export function useJobs(): JobContextValue {
  const ctx = useContext(JobContext)
  if (!ctx) throw new Error('useJobs must be used within JobProvider')
  return ctx
}
