import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import type { DocPage, DocPageTreeNode, CreatePageInput, UpdatePageInput, ReorderItem, PreflightCheck, PreflightResult } from './page.types.js'
import * as pageRepo from './page.repository.js'
import { findProfileById } from '../profile/profile.repository.js'

export async function createPage(input: CreatePageInput): Promise<DocPage> {
  return pageRepo.createPage(input)
}

export async function getPage(id: string): Promise<DocPage> {
  const page = await pageRepo.findPageById(id)
  if (!page) throw new NotFoundError('Page')
  // Resolve the editor's display name for the page header. One extra query
  // per single-page GET; skipped on list/tree to avoid N+1.
  if (page.lastEditedBy) {
    const profile = await findProfileById(page.lastEditedBy).catch(() => null)
    page.lastEditedByName = profile?.fullName ?? profile?.email ?? null
  }
  return page
}

export async function getPageTree(projectId: string): Promise<DocPageTreeNode[]> {
  const pages = await pageRepo.findPagesByProjectId(projectId)
  return pageRepo.buildTree(pages)
}

export async function getPageSiblings(projectId: string, excludePageId?: string): Promise<DocPage[]> {
  const pages = await pageRepo.findPagesByProjectId(projectId)
  return excludePageId ? pages.filter((p) => p.id !== excludePageId) : pages
}

export async function updatePage(id: string, input: UpdatePageInput, editorUserId?: string | null): Promise<DocPage> {
  const page = await pageRepo.findPageById(id)
  if (!page) throw new NotFoundError('Page')
  const updated = await pageRepo.updatePage(id, input, editorUserId)

  // Re-index embeddings when content changes (fire-and-forget)
  if (input.content !== undefined && input.content !== page.content) {
    import('../chat/chat.service.js')
      .then(({ indexPage }) =>
        indexPage({
          id: updated.id,
          projectId: updated.projectId,
          title: updated.title,
          slug: updated.slug,
          content: updated.content,
        }),
      )
      .catch((err) => console.error('[chat] Auto-index failed:', err))
  }

  return updated
}

export async function deletePage(id: string): Promise<void> {
  const page = await pageRepo.findPageById(id)
  if (!page) throw new NotFoundError('Page')

  await pageRepo.deletePage(id)

  // Clean up links to the deleted page from sibling pages — both their stored
  // markdown and the chat knowledge base would otherwise keep stale references.
  // Embeddings for the deleted page itself are removed via FK ON DELETE CASCADE.
  const escapedSlug = page.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linkRegex = new RegExp(
    `\\[([^\\]]+)\\]\\(\\/(?:docs\\/[a-f0-9-]+\\/)?${escapedSlug}(?:#[^)]*)?\\)`,
    'g',
  )

  const siblings = await pageRepo.findPagesByProjectId(page.projectId)
  const indexer = import('../chat/chat.service.js')
  for (const sibling of siblings) {
    if (!sibling.content || !linkRegex.test(sibling.content)) continue
    linkRegex.lastIndex = 0
    const cleaned = sibling.content.replace(linkRegex, '$1')
    const updated = await pageRepo.updatePage(sibling.id, { content: cleaned })
    indexer
      .then(({ indexPage }) =>
        indexPage({
          id: updated.id,
          projectId: updated.projectId,
          title: updated.title,
          slug: updated.slug,
          content: updated.content,
        }),
      )
      .catch((err) => console.error('[chat] Re-index after page delete failed:', err))
  }
}

export async function reorderPages(items: ReorderItem[]): Promise<void> {
  return pageRepo.reorderPages(items)
}

// --- Pre-flight verification ---

export async function runPreflight(pageId: string, projectId: string): Promise<PreflightResult> {
  const page = await pageRepo.findPageById(pageId)
  if (!page) throw new NotFoundError('Page')
  if (!page.content || page.content.trim().length < 20) {
    throw new AppError('Page has no documentation content to test', 'NO_CONTENT', 400)
  }

  const { findProjectById } = await import('../project/project.repository.js')
  const project = await findProjectById(projectId)
  if (!project) throw new NotFoundError('Project')

  // Call Gemini to analyze doc requirements
  const { generateText } = await import('../../shared/ai/gemini.client.js')
  const { PREFLIGHT_SYSTEM_PROMPT, buildPreflightAnalysisPrompt } = await import('../../shared/ai/prompt.builder.js')

  const result = await generateText({
    systemPrompt: PREFLIGHT_SYSTEM_PROMPT,
    userPrompt: buildPreflightAnalysisPrompt(page.content, page.title),
    maxTokens: 4096,
  })

  // Parse Gemini response — graceful fallback if JSON is malformed
  let jsonStr = result.text.trim()
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)

  const { DocRequirementsAnalysisSchema } = await import('./page.schema.js')

  let analysis: { testPlan: string; estimatedSteps: number; requirements: { category: 'file' | 'prerequisite'; label: string; reason: string }[] }
  try {
    analysis = DocRequirementsAnalysisSchema.parse(JSON.parse(jsonStr))
  } catch {
    // If Gemini returns broken JSON, proceed with hardcoded checks only
    console.warn('[preflight] Failed to parse Gemini response, proceeding with basic checks')
    analysis = { testPlan: `Verify documentation for "${page.title}"`, estimatedSteps: 0, requirements: [] }
  }

  // Gather available resources — filter by page-level selection
  const briefing = page.briefing as Record<string, unknown> | null
  const testUrl = (briefing?.testUrl as string) || page.startUrl || project.baseUrl
  const allProjectResources = project.resources ?? []
  const selectedIndices = (briefing?.selectedResources as number[] | undefined) ?? []
  const projectResources = selectedIndices.length > 0
    ? allProjectResources.filter((_, i) => selectedIndices.includes(i))
    : []
  const credentials = project.credentials ?? []

  // --- Hardcoded checks (always present) ---
  const checks: PreflightCheck[] = []

  // 1. Test URL — always required
  checks.push({
    category: 'url',
    label: 'Test URL',
    status: testUrl ? 'ready' : 'missing',
    detail: testUrl ?? 'No test URL configured',
    resolution: testUrl ? null : 'Set a test URL in the Test Configuration panel, or set a base URL on the project.',
  })

  // 2. Credentials — always required (all tests are behind login)
  checks.push({
    category: 'credentials',
    label: 'Login credentials',
    status: credentials.length > 0 ? 'ready' : 'missing',
    detail: credentials.length > 0
      ? `${credentials.length} credential set(s): ${credentials.map((c) => c.label).join(', ')}`
      : 'No credentials configured',
    resolution: credentials.length > 0 ? null : 'Add test credentials in Project Settings.',
  })

  // --- AI-driven checks (file uploads, prerequisites) ---
  for (const req of analysis.requirements) {
    if (req.category === 'file') {
      const fileResources = projectResources.filter((r) => r.type === 'file' && r.value)
      const hasFiles = fileResources.length > 0
      checks.push({
        category: 'file',
        label: req.label,
        status: hasFiles ? 'ready' : 'missing',
        detail: hasFiles
          ? `File(s): ${fileResources.map((r) => r.label || r.value.split('/').pop()).join(', ')}`
          : 'No test files uploaded',
        resolution: hasFiles ? null : 'Add a file resource in the Test Configuration panel.',
      })
    } else if (req.category === 'prerequisite') {
      checks.push({
        category: 'prerequisite',
        label: req.label,
        status: 'warning',
        detail: req.reason,
        resolution: 'Consider adding this context in "Additional context" so the test agent is aware.',
      })
    }
  }

  const hasMissing = checks.some((c) => c.status === 'missing')

  return {
    ready: !hasMissing,
    testPlan: analysis.testPlan,
    estimatedSteps: analysis.estimatedSteps,
    checks,
  }
}
