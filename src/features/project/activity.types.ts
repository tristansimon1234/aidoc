export type ActivityKind = 'page_edited' | 'doc_generated' | 'member_joined' | 'page_published'

export interface ActivityItem {
  kind: ActivityKind
  /** The ISO timestamp the activity surfaces — already formatted serialisable. */
  at: string
  /** Human name to render. Null when the acting user couldn't be resolved. */
  actorName: string | null
  /** Subject of the action: page title, member email, etc. Always populated. */
  subject: string
  /** Optional navigable link (e.g. /projects/:pid/pages/:id). */
  href?: string
}
