import { NotFoundError, AppError } from '../../shared/middleware/error.middleware.js'
import type { DocPage, DocPageTreeNode, CreatePageInput, UpdatePageInput, ReorderItem, PreflightCheck, PreflightResult } from './page.types.js'
import * as pageRepo from './page.repository.js'

export async function createPage(input: CreatePageInput): Promise<DocPage> {
  return pageRepo.createPage(input)
}

export async function getPage(id: string): Promise<DocPage> {
  const page = await pageRepo.findPageById(id)
  if (!page) throw new NotFoundError('Page')
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

export async function updatePage(id: string, input: UpdatePageInput): Promise<DocPage> {
  const page = await pageRepo.findPageById(id)
  if (!page) throw new NotFoundError('Page')
  const updated = await pageRepo.updatePage(id, input)

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
  return pageRepo.deletePage(id)
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
    maxTokens: 1024,
  })

  // Parse Gemini response
  let jsonStr = result.text.trim()
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const braceStart = jsonStr.indexOf('{')
  const braceEnd = jsonStr.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1)

  const { DocRequirementsAnalysisSchema } = await import('./page.schema.js')
  const analysis = DocRequirementsAnalysisSchema.parse(JSON.parse(jsonStr))

  // Gather available resources
  const briefing = page.briefing as Record<string, unknown> | null
  const testUrl = (briefing?.testUrl as string) || page.startUrl || project.baseUrl
  const testResources = (briefing?.testResources as { type: string; label: string; value: string }[]) ?? []
  const credentials = project.credentials ?? []

  // Match requirements against available resources
  const checks: PreflightCheck[] = []

  for (const req of analysis.requirements) {
    switch (req.category) {
      case 'url': {
        checks.push({
          category: 'url',
          label: req.label,
          status: testUrl ? 'ready' : 'missing',
          detail: testUrl ? testUrl : 'No test URL configured',
          resolution: testUrl ? null : 'Set a test URL in the Test Configuration panel, or set a base URL on the project.',
        })
        break
      }
      case 'credentials': {
        const hasCredentials = credentials.length > 0
        checks.push({
          category: 'credentials',
          label: req.label,
          status: hasCredentials ? 'ready' : (req.critical ? 'missing' : 'warning'),
          detail: hasCredentials
            ? `${credentials.length} credential set(s): ${credentials.map((c) => c.label).join(', ')}`
            : 'No credentials configured',
          resolution: hasCredentials ? null : 'Add test credentials in Project Settings.',
        })
        break
      }
      case 'file': {
        const fileResources = testResources.filter((r) => r.type === 'file' && r.value)
        const hasFiles = fileResources.length > 0
        checks.push({
          category: 'file',
          label: req.label,
          status: hasFiles ? 'ready' : (req.critical ? 'missing' : 'warning'),
          detail: hasFiles
            ? `File(s): ${fileResources.map((r) => r.label || r.value.split('/').pop()).join(', ')}`
            : 'No test files uploaded',
          resolution: hasFiles ? null : 'Add a file resource in the Test Configuration panel.',
        })
        break
      }
      case 'navigation':
      case 'prerequisite': {
        checks.push({
          category: req.category,
          label: req.label,
          status: 'warning',
          detail: req.reason,
          resolution: 'Consider adding this context in "Additional context" so the test agent is aware.',
        })
        break
      }
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
