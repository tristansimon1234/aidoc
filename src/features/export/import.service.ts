import JSZip from 'jszip'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { createPage as createPageRepo, findPagesByProjectId, updatePage as updatePageRepo } from '../page/page.repository.js'
import { findProjectById } from '../project/project.repository.js'
import { uploadToStorage, getPublicUrl } from '../../shared/db/storage.repository.js'
import { AppError, NotFoundError, ValidationError } from '../../shared/middleware/error.middleware.js'
import { EXPORT_MANIFEST_VERSION, type ExportManifest, type ImportResult } from './export.types.js'
import { ARTIFACTS_BUCKET, contentTypeFor } from './export.service.js'

const ARTIFACT_PATH_RE = /^runs\/[a-f0-9-]{8,}\/[^/]+/

const ExportedVoiceoverSegmentSchema = z.object({
  stepIndex: z.number().int(),
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  text: z.string().nullable(),
  file: z.string(),
})

const ExportedVoiceoverSchema = z.object({
  finalFile: z.string(),
  segments: z.array(ExportedVoiceoverSegmentSchema),
})

const BriefingSchema = z.object({
  objective: z.string(),
  knowledge: z.string(),
  resources: z.array(
    z.object({
      type: z.enum(['url', 'credential', 'endpoint', 'file', 'note']),
      label: z.string(),
      value: z.string(),
    }),
  ),
})

const ExportedPageSchema = z.object({
  slug: z.string().min(1).max(200),
  title: z.string().min(1).max(400),
  parentSlug: z.string().nullable(),
  sortOrder: z.number().int().min(0),
  status: z.enum(['draft', 'exploring', 'published']),
  isPublic: z.boolean(),
  startUrl: z.string().nullable(),
  goal: z.string().nullable(),
  customPrompt: z.string().nullable(),
  briefing: BriefingSchema.nullable(),
  content: z.string().nullable(),
  voiceover: ExportedVoiceoverSchema.nullable().optional(),
  runId: z.string().nullable().optional(),
})

const ExportManifestSchema = z.object({
  version: z.literal(EXPORT_MANIFEST_VERSION),
  exportedAt: z.string(),
  sourceProjectId: z.string(),
  sourceProjectName: z.string(),
  pages: z.array(ExportedPageSchema),
})

/** We only accept storage paths that look like `runs/<id>/file` — the export
 *  only ever writes those shapes, and anything else could be a path-traversal
 *  attempt (`../../secrets/...`) crafted by a malicious uploader. */
function isSafeArtifactPath(path: string): boolean {
  if (path.includes('..')) return false
  return ARTIFACT_PATH_RE.test(path)
}

/**
 * Parse and validate a ZIP buffer, returning the manifest and the JSZip
 * instance so the import service can read media files lazily. Throws
 * `ValidationError` when the structure is wrong — giving the user a clear
 * message rather than a confused downstream crash.
 */
async function openImportZip(buffer: Buffer): Promise<{ manifest: ExportManifest; zip: JSZip }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new ValidationError({ zip: ['Not a valid ZIP archive'] })
  }
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) throw new ValidationError({ manifest: ['manifest.json is missing from the archive'] })
  const manifestText = await manifestFile.async('string')
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestText)
  } catch {
    throw new ValidationError({ manifest: ['manifest.json is not valid JSON'] })
  }
  const parsed = ExportManifestSchema.safeParse(manifestRaw)
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten())
  }
  return { manifest: parsed.data, zip }
}

/**
 * Take a slug and make sure it doesn't collide with existing pages OR with
 * another slug we've just allocated in this import run. Suffixes `-2`, `-3`,
 * … until a free one is found. The in-memory `claimed` set is mutated so
 * parallel imports from the same manifest don't double-claim.
 */
function allocateSlug(desired: string, claimed: Set<string>): string {
  let slug = desired
  let n = 2
  while (claimed.has(slug)) {
    slug = `${desired}-${n++}`
  }
  claimed.add(slug)
  return slug
}

/**
 * Topologically sort manifest pages so parents are created before children.
 * Pages whose parentSlug isn't present in the manifest OR in the destination
 * project (optional extra set) are promoted to the root with a warning.
 */
function topoSort(
  pages: ExportManifest['pages'],
  existingSlugs: Set<string>,
): { sorted: ExportManifest['pages']; orphaned: string[] } {
  const bySlug = new Map(pages.map((p) => [p.slug, p]))
  const visited = new Set<string>()
  const sorted: ExportManifest['pages'] = []
  const orphaned: string[] = []

  const visit = (slug: string, trail: Set<string>): void => {
    if (visited.has(slug)) return
    if (trail.has(slug)) {
      // Cycle — shouldn't happen with a well-formed export, but be safe.
      return
    }
    trail.add(slug)
    const p = bySlug.get(slug)
    if (!p) return
    if (p.parentSlug) {
      if (bySlug.has(p.parentSlug)) {
        visit(p.parentSlug, trail)
      } else if (!existingSlugs.has(p.parentSlug)) {
        orphaned.push(p.slug)
      }
    }
    visited.add(slug)
    sorted.push(p)
  }

  for (const p of pages) visit(p.slug, new Set())
  return { sorted, orphaned }
}

/**
 * Import a project ZIP into an existing destination project. Every page is
 * created from scratch (we don't attempt to merge / update in place —
 * slug collisions get suffixed with `-2` etc. to stay non-destructive).
 * Media files under `media/runs/<id>/...` are re-uploaded into the
 * destination's `artifacts` bucket under a fresh namespace
 * `imports/<importId>/runs/<origRunId>/...` and the markdown links in each
 * page are rewritten to the new public URLs.
 */
export async function importProjectZip(
  destProjectId: string,
  buffer: Buffer,
): Promise<ImportResult> {
  const project = await findProjectById(destProjectId)
  if (!project) throw new NotFoundError('Project')

  const { manifest, zip } = await openImportZip(buffer)

  // Claim slugs against whatever already exists in the destination so we
  // don't overwrite a user's real pages.
  const existingPages = await findPagesByProjectId(destProjectId)
  const claimed = new Set<string>(existingPages.map((p) => p.slug))

  const { sorted, orphaned } = topoSort(manifest.pages, claimed)
  const warnings: string[] = orphaned.map(
    (slug) => `Parent slug missing for "${slug}" — imported at root.`,
  )

  // 1. Upload every media file from the zip that lives under `media/`,
  //    remapping originalStoragePath → imports/<importId>/<originalStoragePath>.
  //    We resolve new public URLs now so we can rewrite markdown before
  //    creating pages.
  const importId = randomUUID()
  const mediaMap = new Map<string, string>() // old-path-in-zip → new public URL
  let mediaReuploaded = 0
  for (const relPath of Object.keys(zip.files)) {
    if (!relPath.startsWith('media/')) continue
    const entry = zip.file(relPath)
    if (!entry || entry.dir) continue
    const originalStoragePath = relPath.slice('media/'.length)
    if (!isSafeArtifactPath(originalStoragePath)) {
      warnings.push(`Skipped unsafe media path: ${originalStoragePath}`)
      continue
    }
    const buf = Buffer.from(await entry.async('nodebuffer'))
    const newStoragePath = `imports/${importId}/${originalStoragePath}`
    try {
      await uploadToStorage(ARTIFACTS_BUCKET, newStoragePath, buf, contentTypeFor(originalStoragePath))
      const url = getPublicUrl(ARTIFACTS_BUCKET, newStoragePath)
      if (url) {
        mediaMap.set(relPath, url)
        mediaReuploaded += 1
      }
    } catch (err) {
      warnings.push(`Failed to upload ${originalStoragePath}: ${(err as Error).message}`)
    }
  }

  /** Rewrite `./media/...` links in exported markdown → absolute public URLs
   *  pointing at the new import namespace. Unknown media paths (e.g. typo in
   *  the manifest, or we failed to upload) are left as-is so the user can
   *  fix them in the editor. */
  const rewriteLinks = (md: string): string => {
    return md
      .replace(/(!\[[^\]]*\]\()(\.\/media\/[^)\s]+)(\s+"[^"]*")?(\))/g, (full, open: string, url: string, title: string | undefined, close: string) => {
        const key = url.slice(2) // strip leading `./`
        const remapped = mediaMap.get(key)
        return remapped ? `${open}${remapped}${title ?? ''}${close}` : full
      })
      .replace(/<img([^>]+)src=(["'])(\.\/media\/[^"']+)\2/gi, (full, attrs: string, quote: string, url: string) => {
        const key = url.slice(2)
        const remapped = mediaMap.get(key)
        return remapped ? `<img${attrs}src=${quote}${remapped}${quote}` : full
      })
  }

  // 2. Walk the topologically sorted pages. Keep a map from manifest slug →
  //    freshly-assigned id so children can look up their parent.
  const createdIds: string[] = []
  const slugToNewId = new Map<string, string>()

  for (const exported of sorted) {
    const desiredSlug = exported.slug
    const slug = allocateSlug(desiredSlug, claimed)
    if (slug !== desiredSlug) {
      warnings.push(`Slug "${desiredSlug}" already existed — imported as "${slug}".`)
    }

    let parentId: string | null = null
    if (exported.parentSlug) {
      const newParentId = slugToNewId.get(exported.parentSlug)
      if (newParentId) parentId = newParentId
      else {
        // Parent might exist in the destination project from a previous import
        // or the user's own pages — honor that so nested re-imports make sense.
        const existing = existingPages.find((p) => p.slug === exported.parentSlug)
        if (existing) parentId = existing.id
      }
    }

    const created = await createPageRepo({
      projectId: destProjectId,
      parentId: parentId ?? undefined,
      title: exported.title,
      slug,
      startUrl: exported.startUrl ?? undefined,
      goal: exported.goal ?? undefined,
      sortOrder: exported.sortOrder,
    })

    const rewrittenContent = exported.content ? rewriteLinks(exported.content) : null
    await updatePageRepo(created.id, {
      content: rewrittenContent ?? undefined,
      status: exported.status,
      isPublic: exported.isPublic,
      briefing: exported.briefing ?? undefined,
      customPrompt: exported.customPrompt ?? undefined,
    })

    slugToNewId.set(exported.slug, created.id)
    createdIds.push(created.id)
  }

  // 3. Fire-and-forget re-index so the RAG chat picks up the new pages
  //    without blocking the HTTP response.
  void import('../chat/chat.service.js')
    .then(({ indexProject }) => indexProject(destProjectId))
    .catch((err) => console.error('[import] Re-index failed:', err))

  return {
    projectId: destProjectId,
    createdPageIds: createdIds,
    skippedSlugs: [],
    mediaReuploaded,
    warnings,
  }
}

/**
 * Import a single-page ZIP into a destination project, optionally nested
 * under a given parent page. Convenience wrapper over `importProjectZip`
 * — validates the archive contains exactly one page and swaps the root
 * parent when `parentId` is provided.
 */
export async function importPageZip(
  destProjectId: string,
  buffer: Buffer,
  parentId: string | null,
): Promise<ImportResult> {
  const project = await findProjectById(destProjectId)
  if (!project) throw new NotFoundError('Project')

  const { manifest, zip } = await openImportZip(buffer)
  if (manifest.pages.length !== 1) {
    throw new AppError(
      'Expected a single-page archive but manifest lists multiple pages. Use the project import flow instead.',
      'IMPORT_MULTIPLE_PAGES',
      400,
    )
  }

  // Resolve the optional parent: if provided, check it belongs to the target
  // project. Otherwise drop parentSlug so the page lands at the root.
  let parentSlug: string | null = null
  if (parentId) {
    const existingPages = await findPagesByProjectId(destProjectId)
    const parent = existingPages.find((p) => p.id === parentId)
    if (!parent) throw new NotFoundError('Parent page')
    parentSlug = parent.slug
  }

  // Rewrite the manifest in-place to reflect the chosen parent, then
  // delegate to the full-project import path. JSZip keeps the media files
  // intact so we can re-use its uploader logic without duplicating it.
  const mutated = { ...manifest, pages: [{ ...manifest.pages[0]!, parentSlug }] }
  zip.file('manifest.json', JSON.stringify(mutated, null, 2))
  const rewrittenBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return importProjectZip(destProjectId, rewrittenBuffer)
}
