export interface DocTab {
  id: string
  projectId: string
  name: string
  slug: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

export interface DocTabWithCount extends DocTab {
  /** Number of pages currently assigned to this tab. Used by the admin
   *  UI to decide whether a delete needs a "move pages to…" target. */
  pageCount: number
}

export interface CreateTabInput {
  projectId: string
  name: string
  slug?: string
  sortOrder?: number
}

export interface UpdateTabInput {
  name?: string
  slug?: string
  sortOrder?: number
}
