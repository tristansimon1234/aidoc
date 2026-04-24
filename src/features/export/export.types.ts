import type { PageBriefing, PageStatus } from '../page/page.types.js'

/** Bumped every time the on-disk manifest format changes in a non
 *  backwards-compatible way. Import checks this upfront and refuses
 *  newer manifests so we never silently misinterpret new fields. */
export const EXPORT_MANIFEST_VERSION = 1

/** One voice-over segment, as written to `manifest.json`. Timings mirror
 *  what ElevenLabs + the trim editor produce; `file` is a path relative
 *  to the ZIP root (e.g. `media/runs/<id>/voiceover-segments/seg-0.mp3`). */
export interface ExportedVoiceoverSegment {
  stepIndex: number
  startMs: number | null
  endMs: number | null
  text: string | null
  file: string
}

export interface ExportedVoiceover {
  /** Relative path to the final concatenated mp3 — this is what's
   *  referenced from the UI and what external editors should play. */
  finalFile: string
  segments: ExportedVoiceoverSegment[]
}

/** Media file captured in the zip, resolved from markdown image refs
 *  or from the latest run's screenshots / video / voice-over artifacts. */
export interface ExportedMediaRef {
  /** Path relative to the ZIP root, e.g. `media/runs/<runId>/step-0.png`. */
  zipPath: string
  /** Original storage path inside the `artifacts` bucket. Preserved so the
   *  import can recreate a reasonable path structure. */
  originalStoragePath: string
  contentType: string
}

export interface ExportedPage {
  slug: string
  title: string
  parentSlug: string | null
  sortOrder: number
  status: PageStatus
  isPublic: boolean
  startUrl: string | null
  goal: string | null
  customPrompt: string | null
  briefing: PageBriefing | null
  /** Markdown body — the ZIP also contains this as a sibling `.md` file so
   *  the whole export is browsable in a file explorer. Kept here for a
   *  lossless round-trip even if a human renames the .md on disk. */
  content: string | null
  /** Present only for pages that have a recorded run with audio. */
  voiceover?: ExportedVoiceover | null
  /** Original run id — used to namespace media paths for round-trip. */
  runId?: string | null
}

export interface ExportManifest {
  version: typeof EXPORT_MANIFEST_VERSION
  exportedAt: string
  sourceProjectId: string
  sourceProjectName: string
  pages: ExportedPage[]
}

export interface ImportResult {
  projectId: string
  createdPageIds: string[]
  skippedSlugs: string[]
  mediaReuploaded: number
  warnings: string[]
}
