import { NotFoundError } from '../../shared/middleware/error.middleware.js'
import type { DocPage, DocPageTreeNode, CreatePageInput, UpdatePageInput, ReorderItem } from './page.types.js'
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
  return pageRepo.updatePage(id, input)
}

export async function deletePage(id: string): Promise<void> {
  const page = await pageRepo.findPageById(id)
  if (!page) throw new NotFoundError('Page')
  return pageRepo.deletePage(id)
}

export async function reorderPages(items: ReorderItem[]): Promise<void> {
  return pageRepo.reorderPages(items)
}
