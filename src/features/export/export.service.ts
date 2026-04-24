import JSZip from 'jszip'
import { findPagesByProjectId } from '../page/page.repository.js'
import { findProjectById } from '../project/project.repository.js'
import { findLatestRunByPageId, findStepsByRunId } from '../run/run.repository.js'
import { downloadFromStorage, getPublicUrl } from '../../shared/db/storage.repository.js'
import { supabase } from '../../shared/db/supabase.client.js'
import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import { isVideoServiceConfigured, muxVideoWithAudio } from '../../shared/video/video.client.js'
import type { DocPage } from '../page/page.types.js'
import {
  EXPORT_MANIFEST_VERSION,
  type ExportManifest,
  type ExportedMediaRef,
  type ExportedPage,
  type ExportedVoiceover,
  type ExportedVoiceoverSegment,
} from './export.types.js'

const ARTIFACTS_BUCKET = 'artifacts'

/**
 * Walk a markdown string and pull out storage paths of every image whose URL
 * points at our public artifacts bucket. URLs from other origins are left
 * alone and will stay absolute in the exported markdown — we only rewrite
 * the ones we can actually ship inside the ZIP.
 *
 * Matches both `![alt](url)` and stray HTML `<img src="url">` so hand-written
 * doc pages still get their media embedded.
 */
function extractArtifactStoragePaths(markdown: string | null): string[] {
  if (!markdown) return []
  const out = new Set<string>()
  const imgRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  const htmlRe = /<img[^>]+src=["']([^"']+)["']/gi

  const tryAdd = (rawUrl: string): void => {
    // Strip querystring (cache-busters like `?v=timestamp`) before path match.
    const url = rawUrl.split('?')[0] ?? rawUrl
    // Look for the `/storage/v1/object/public/artifacts/` segment that
    // Supabase returns from getPublicUrl.
    const marker = '/storage/v1/object/public/artifacts/'
    const idx = url.indexOf(marker)
    if (idx === -1) return
    const path = url.slice(idx + marker.length)
    if (path) out.add(decodeURIComponent(path))
  }

  for (const m of markdown.matchAll(imgRe)) tryAdd(m[1] ?? '')
  for (const m of markdown.matchAll(htmlRe)) tryAdd(m[1] ?? '')
  return Array.from(out)
}

function contentTypeFor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  return 'application/octet-stream'
}

/** Rewrite every absolute artifacts URL inside the markdown to a relative
 *  `./media/...` path matching where we'll place the file in the ZIP. We
 *  don't touch non-artifact URLs (e.g. external screenshots someone pasted
 *  from elsewhere). Preserves the cache-bust `?v=...` by dropping it — the
 *  relative file-system link doesn't need it. */
function rewriteToRelativeMedia(markdown: string): string {
  const marker = '/storage/v1/object/public/artifacts/'
  return markdown.replace(/(!\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?(\))/g, (full, open: string, url: string, titlePart: string | undefined, close: string) => {
    const idx = url.indexOf(marker)
    if (idx === -1) return full
    const path = (url.split('?')[0] ?? url).slice(idx + marker.length)
    const decoded = decodeURIComponent(path)
    return `${open}./media/${decoded}${titlePart ?? ''}${close}`
  }).replace(/<img([^>]+)src=(["'])([^"']+)\2/gi, (full, attrs: string, quote: string, url: string) => {
    const idx = url.indexOf(marker)
    if (idx === -1) return full
    const path = (url.split('?')[0] ?? url).slice(idx + marker.length)
    const decoded = decodeURIComponent(path)
    return `<img${attrs}src=${quote}./media/${decoded}${quote}`
  })
}

/** Locate where a slug's markdown file should live inside `pages/`. Mirrors
 *  the page hierarchy as folders so the extracted ZIP is navigable in a file
 *  explorer — `getting-started.md` + `getting-started/first-step.md` etc. */
function buildPageFilePath(page: DocPage, pagesById: Map<string, DocPage>): string {
  const trail: string[] = [page.slug]
  let current = page.parentId ? pagesById.get(page.parentId) : undefined
  const seen = new Set<string>([page.id])
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    trail.unshift(current.slug)
    current = current.parentId ? pagesById.get(current.parentId) : undefined
  }
  const file = `${trail.pop()}.md`
  const dir = trail.length > 0 ? `${trail.join('/')}/` : ''
  return `pages/${dir}${file}`
}

/** Build the YAML front-matter block at the top of each `.md` file. Minimal
 *  on purpose — we keep the rich stuff (briefing, parentSlug) in manifest.json
 *  so hand editing the .md doesn't require understanding YAML. */
function buildFrontMatter(page: ExportedPage): string {
  const lines = ['---', `title: ${JSON.stringify(page.title)}`, `slug: ${page.slug}`]
  if (page.parentSlug) lines.push(`parentSlug: ${page.parentSlug}`)
  lines.push(`status: ${page.status}`)
  lines.push(`isPublic: ${page.isPublic}`)
  lines.push(`sortOrder: ${page.sortOrder}`)
  lines.push('---')
  return lines.join('\n')
}

interface RunMediaResult {
  media: ExportedMediaRef[]
  voiceover: ExportedVoiceover | null
  /** Warnings surfaced to the export manifest so the user knows why mux fell
   *  back to separate tracks. */
  warnings: string[]
}

/** Pull everything recorded against a page's latest run that we'd want in a
 *  backup: step screenshots, trimmed video, voice-over final + segments.
 *  Missing files (deleted, not yet generated) are silently skipped — the
 *  whole point of "backup" is to grab what's there, not fail on gaps.
 *
 *  When both a video and a voice-over exist, we ask the video-service to mux
 *  them into a single playable MP4 so the ZIP is self-contained for external
 *  editors (VS Code / Obsidian / GitHub preview). The raw voice-over + segments
 *  stay in the archive so a re-import into doclee can still restore per-segment
 *  regeneration. If the mux step fails or the service isn't configured, we
 *  gracefully keep the muted video + standalone mp3 and surface a warning. */
async function collectRunMedia(pageId: string): Promise<RunMediaResult> {
  const run = await findLatestRunByPageId(pageId).catch(() => null)
  if (!run) return { media: [], voiceover: null, warnings: [] }

  const media: ExportedMediaRef[] = []
  const warnings: string[] = []
  const steps = await findStepsByRunId(run.id).catch(() => [])

  for (const step of steps) {
    if (step.screenshotPath) {
      media.push({
        zipPath: `media/${step.screenshotPath}`,
        originalStoragePath: step.screenshotPath,
        contentType: contentTypeFor(step.screenshotPath),
      })
    }
  }

  const summary = (run.summaryJson ?? {}) as Record<string, unknown>
  const videoPath = typeof summary.videoPath === 'string' ? summary.videoPath : null
  const voiceoverPath = typeof summary.voiceoverPath === 'string' ? summary.voiceoverPath : null

  // Try to produce a merged video+audio MP4 when both tracks are available.
  // Falls back to shipping them separately on any failure — the export must
  // never 500 because of an optional video-service hiccup.
  let primaryVideoPath = videoPath
  if (videoPath && voiceoverPath && isVideoServiceConfigured()) {
    try {
      const muxedPath = await muxVideoWithAudio(videoPath, voiceoverPath, run.id)
      primaryVideoPath = muxedPath
    } catch (err) {
      warnings.push(`Video/voice-over mux failed (${(err as Error).message}). Falling back to separate files.`)
    }
  }

  if (primaryVideoPath) {
    media.push({
      zipPath: `media/${primaryVideoPath}`,
      originalStoragePath: primaryVideoPath,
      contentType: contentTypeFor(primaryVideoPath),
    })
  }

  let voiceover: ExportedVoiceover | null = null
  if (voiceoverPath) {
    media.push({
      zipPath: `media/${voiceoverPath}`,
      originalStoragePath: voiceoverPath,
      contentType: contentTypeFor(voiceoverPath),
    })
    const rawSegs = Array.isArray(summary.voiceoverSegments) ? (summary.voiceoverSegments as unknown[]) : []
    const segs: ExportedVoiceoverSegment[] = []
    for (const raw of rawSegs) {
      if (!raw || typeof raw !== 'object') continue
      const obj = raw as Record<string, unknown>
      const segPath = typeof obj.audioPath === 'string' ? obj.audioPath : null
      if (!segPath) continue
      media.push({
        zipPath: `media/${segPath}`,
        originalStoragePath: segPath,
        contentType: contentTypeFor(segPath),
      })
      segs.push({
        stepIndex: typeof obj.stepIndex === 'number' ? obj.stepIndex : -1,
        startMs: typeof obj.startMs === 'number' ? obj.startMs : null,
        endMs: typeof obj.endMs === 'number' ? obj.endMs : null,
        text: typeof obj.text === 'string' ? obj.text : null,
        file: `media/${segPath}`,
      })
    }
    voiceover = { finalFile: `media/${voiceoverPath}`, segments: segs }
  }

  return { media, voiceover, warnings }
}

/**
 * Turn a project into a ZIP buffer. The caller streams the buffer back as
 * a file download. Structure:
 *
 *     manifest.json
 *     pages/<hierarchy>.md   (front-matter + markdown, image refs relative)
 *     media/runs/<runId>/... (screenshots, voice-over, video)
 *
 * Non-throwing on per-file failures: a missing screenshot won't fail the
 * whole export — it'll just be absent from the archive, with a `warnings`
 * entry in the manifest.
 */
export async function buildProjectZip(projectId: string): Promise<{ buffer: Buffer; filename: string }> {
  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')

  const pages = await findPagesByProjectId(projectId)
  const pagesById = new Map(pages.map((p) => [p.id, p]))

  const zip = new JSZip()
  const manifestPages: ExportedPage[] = []
  const seenMediaPaths = new Set<string>()
  const warnings: string[] = []

  for (const page of pages) {
    const parentSlug = page.parentId ? pagesById.get(page.parentId)?.slug ?? null : null

    // Collect + download all media referenced in the markdown AND attached
    // to the latest run. De-dup by zipPath so two pages referencing the same
    // image don't store it twice.
    const markdownMediaPaths = extractArtifactStoragePaths(page.content)
    const markdownMedia: ExportedMediaRef[] = markdownMediaPaths.map((p) => ({
      zipPath: `media/${p}`,
      originalStoragePath: p,
      contentType: contentTypeFor(p),
    }))
    const runMedia = await collectRunMedia(page.id)
    if (runMedia.warnings.length > 0) warnings.push(...runMedia.warnings)
    const pageMedia = [...markdownMedia, ...runMedia.media]

    for (const m of pageMedia) {
      if (seenMediaPaths.has(m.zipPath)) continue
      seenMediaPaths.add(m.zipPath)
      const buf = await downloadFromStorage(ARTIFACTS_BUCKET, m.originalStoragePath).catch(() => null)
      if (!buf) {
        warnings.push(`Missing media: ${m.originalStoragePath}`)
        continue
      }
      zip.file(m.zipPath, buf)
    }

    const rewrittenContent = page.content ? rewriteToRelativeMedia(page.content) : null
    const exported: ExportedPage = {
      slug: page.slug,
      title: page.title,
      parentSlug,
      sortOrder: page.sortOrder,
      status: page.status,
      isPublic: page.isPublic,
      startUrl: page.startUrl,
      goal: page.goal,
      customPrompt: page.customPrompt,
      briefing: page.briefing,
      content: rewrittenContent,
      voiceover: runMedia.voiceover,
      runId: runMedia.voiceover ? runMedia.voiceover.finalFile.split('/')[2] ?? null : null,
    }
    manifestPages.push(exported)

    // Write the .md file so the archive is useful as a standalone doc set
    // (Obsidian / VS Code / GitHub all render it fine).
    const mdPath = buildPageFilePath(page, pagesById)
    const frontMatter = buildFrontMatter(exported)
    const bodyH1 = `# ${page.title}`
    const body = rewrittenContent ?? '_(empty)_'
    zip.file(mdPath, `${frontMatter}\n\n${bodyH1}\n\n${body}\n`)
  }

  const manifest: ExportManifest = {
    version: EXPORT_MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    sourceProjectId: project.id,
    sourceProjectName: project.name,
    pages: manifestPages,
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  if (warnings.length > 0) {
    zip.file('WARNINGS.txt', warnings.join('\n') + '\n')
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const safeName = project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'doclee-project'
  return { buffer, filename: `${safeName}.zip` }
}

/**
 * Single-page export. Same layout as the project export but scoped to one
 * page — useful for moving a single doc around or keeping an isolated copy.
 * Children are NOT included; caller can export the whole project if they
 * want the subtree.
 */
export async function buildPageZip(pageId: string): Promise<{ buffer: Buffer; filename: string }> {
  const { data, error } = await supabase
    .from('doc_pages')
    .select('project_id')
    .eq('id', pageId)
    .single()
  if (error || !data) throw new NotFoundError('Page')
  const projectId = (data as { project_id: string }).project_id

  const pages = await findPagesByProjectId(projectId)
  const pagesById = new Map(pages.map((p) => [p.id, p]))
  const page = pagesById.get(pageId)
  if (!page) throw new NotFoundError('Page')

  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')

  const zip = new JSZip()
  const seenMediaPaths = new Set<string>()
  const warnings: string[] = []

  const parentSlug = page.parentId ? pagesById.get(page.parentId)?.slug ?? null : null
  const markdownMediaPaths = extractArtifactStoragePaths(page.content)
  const markdownMedia: ExportedMediaRef[] = markdownMediaPaths.map((p) => ({
    zipPath: `media/${p}`,
    originalStoragePath: p,
    contentType: contentTypeFor(p),
  }))
  const runMedia = await collectRunMedia(page.id)
  if (runMedia.warnings.length > 0) warnings.push(...runMedia.warnings)
  const pageMedia = [...markdownMedia, ...runMedia.media]

  for (const m of pageMedia) {
    if (seenMediaPaths.has(m.zipPath)) continue
    seenMediaPaths.add(m.zipPath)
    const buf = await downloadFromStorage(ARTIFACTS_BUCKET, m.originalStoragePath).catch(() => null)
    if (!buf) {
      warnings.push(`Missing media: ${m.originalStoragePath}`)
      continue
    }
    zip.file(m.zipPath, buf)
  }

  const rewrittenContent = page.content ? rewriteToRelativeMedia(page.content) : null
  const exported: ExportedPage = {
    slug: page.slug,
    title: page.title,
    // Single-page export loses the parent context (there's no parent in the
    // archive to hang it on) — record it for reference but the import will
    // re-home at the root of the destination project unless told otherwise.
    parentSlug,
    sortOrder: page.sortOrder,
    status: page.status,
    isPublic: page.isPublic,
    startUrl: page.startUrl,
    goal: page.goal,
    customPrompt: page.customPrompt,
    briefing: page.briefing,
    content: rewrittenContent,
    voiceover: runMedia.voiceover,
    runId: runMedia.voiceover ? runMedia.voiceover.finalFile.split('/')[2] ?? null : null,
  }

  zip.file(`pages/${page.slug}.md`, `${buildFrontMatter(exported)}\n\n# ${page.title}\n\n${rewrittenContent ?? '_(empty)_'}\n`)

  const manifest: ExportManifest = {
    version: EXPORT_MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    sourceProjectId: project.id,
    sourceProjectName: project.name,
    pages: [exported],
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  if (warnings.length > 0) {
    zip.file('WARNINGS.txt', warnings.join('\n') + '\n')
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const safeSlug = page.slug || 'page'
  return { buffer, filename: `${safeSlug}.zip` }
}

// Re-export helpers used by the import service so both paths share the same
// storage-path → public-URL conversion logic.
export { ARTIFACTS_BUCKET, contentTypeFor, getPublicUrl }
