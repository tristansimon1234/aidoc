import { AppError } from '../../shared/middleware/error.middleware.js'
import * as jobRepo from './job.repository.js'
import type { Job, JobType } from './job.repository.js'

/**
 * How long a job in status='running' can sit untouched before we treat it as
 * abandoned and let the next caller take over. The longest legitimate op we
 * run is exploration at ~5 min (Vercel maxDuration 300s). 10 min gives us a
 * 2× safety margin for the occasional slow Gemini / Browserbase call.
 */
const STALE_JOB_AFTER_MS = 10 * 60 * 1000

/** Uniform shape for a 409 "someone else is running this" response. */
export interface AlreadyRunningDetails {
  jobId: string
  jobType: JobType
  triggeredByUserId: string | null
  triggeredByName: string | null
  runningSince: string
  pageId: string | null
  projectId: string
}

export class AlreadyRunningError extends AppError {
  constructor(public running: AlreadyRunningDetails) {
    super(
      `A ${running.jobType} job is already running for this page`,
      'RUN_ALREADY_RUNNING',
      409,
      running,
    )
  }
}

async function resolveTriggeredByName(userId: string | null): Promise<string | null> {
  if (!userId) return null
  try {
    const { findProfileById } = await import('../profile/profile.repository.js')
    const profile = await findProfileById(userId)
    return profile?.fullName ?? profile?.email ?? null
  } catch {
    return null
  }
}

async function describeRunning(job: Job): Promise<AlreadyRunningDetails> {
  const triggeredByName = await resolveTriggeredByName(job.triggeredByUserId)
  return {
    jobId: job.id,
    jobType: job.type,
    triggeredByUserId: job.triggeredByUserId,
    triggeredByName,
    runningSince: job.createdAt.toISOString(),
    pageId: job.pageId,
    projectId: job.projectId,
  }
}

function isStale(job: Job): boolean {
  return Date.now() - job.createdAt.getTime() > STALE_JOB_AFTER_MS
}

interface EnsureInput {
  runId: string | null
  pageId: string | null
  projectId: string
  type: JobType
  triggeredByUserId: string | null
}

/**
 * Acquire an exclusive lock for a heavy action (exploration, doc-gen,
 * voice-over, try-doc analysis, project index). Every caller that wants
 * to start one of these should route through here before spawning a
 * Browserbase / Gemini / ElevenLabs call.
 *
 * Semantics:
 *   - Uses the DB-level UNIQUE partial indexes on `jobs` as the real
 *     race anchor. If two callers arrive simultaneously, Postgres lets
 *     exactly one INSERT succeed and rejects the other with 23505.
 *   - On conflict, we fetch the running row. If it's older than
 *     STALE_JOB_AFTER_MS it's assumed abandoned (Vercel timeout etc):
 *     mark it `failed` and retry our INSERT. Otherwise we throw
 *     AlreadyRunningError with the triggering user's display name.
 *
 * The route layer catches AlreadyRunningError and renders the 409 body;
 * the service layer should treat it as a normal throw.
 */
export async function ensureExclusiveJob(input: EnsureInput): Promise<Job> {
  try {
    return await jobRepo.createJob(input)
  } catch (err) {
    const message = (err as Error).message?.toLowerCase() ?? ''
    const isDuplicate = message.includes('duplicate') || message.includes('unique') || message.includes('23505')
    if (!isDuplicate) throw err

    const existing = input.pageId
      ? await jobRepo.findRunningJobForPage(input.pageId, input.type)
      : await jobRepo.findRunningJobForProject(input.projectId, input.type)

    if (!existing) {
      // The row finished between our failed INSERT and this SELECT — the
      // collision has already cleared itself. Retry once.
      return await jobRepo.createJob(input)
    }

    if (isStale(existing)) {
      // Abandoned (probably a Vercel timeout). Mark it failed so the next
      // INSERT can succeed, and take over the work.
      await jobRepo.updateJobStatus(existing.id, 'failed', 'Reclaimed — previous run exceeded time budget').catch(() => undefined)
      return await jobRepo.createJob(input)
    }

    throw new AlreadyRunningError(await describeRunning(existing))
  }
}

/** Best-effort end-of-job marker. Swallows errors because the work is done
 *  either way — leaving a stuck 'running' row is less bad than failing the
 *  actual response to the user. The staleness fallback above will recover
 *  the slot at the next attempt. */
export async function completeJob(jobId: string): Promise<void> {
  await jobRepo.updateJobStatus(jobId, 'completed').catch(() => undefined)
}

export async function failJob(jobId: string, errorMessage: string): Promise<void> {
  await jobRepo.updateJobStatus(jobId, 'failed', errorMessage).catch(() => undefined)
}
