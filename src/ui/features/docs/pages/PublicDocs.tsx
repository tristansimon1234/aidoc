import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { Spinner, EmptyState, MarkdownRenderer, TableOfContents } from '../../../design-system/components/index.js'
import type { ProjectDesignDTO, ChatResponseDTO, ChatStreamEventDTO } from '../../../shared/api/client.js'
import { computeFullTheme } from '../../../shared/theme/computeTheme.js'
import { ChatSurface, type ChatSurfaceApi } from '../../chat/components/ChatSurface.js'
import styles from './PublicDocs.module.css'

/** Lightweight narrated video player for public docs — syncs video + voiceover audio */
function NarratedVideo({ videoUrl, audioUrl }: { videoUrl: string; audioUrl?: string }): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const syncAudio = (): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio) return
    if (Math.abs(video.currentTime - audio.currentTime) > 0.3) {
      audio.currentTime = video.currentTime
    }
  }

  const handlePlay = (): void => {
    const audio = audioRef.current
    const video = videoRef.current
    if (audio && video) {
      audio.currentTime = video.currentTime
      void audio.play()
    }
  }

  const handlePause = (): void => { audioRef.current?.pause() }
  const handleSeeked = (): void => { syncAudio() }

  // When a voice-over is present, the video's original audio track must
  // never play — otherwise users clicking the native unmute button hear
  // the original audio layered on top of the narration. Force the video
  // to stay muted, and pipe the video's volume slider to the audio element
  // so the user still has a functional volume control.
  const handleVolumeChange = (): void => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audioUrl) return
    if (!video.muted) video.muted = true
    if (audio) audio.volume = video.volume
  }

  return (
    <div style={{
      marginBottom: 'var(--space-lg)', borderRadius: 'var(--radius-xl)',
      overflow: 'hidden', background: '#000',
    }}>
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        preload="metadata"
        muted={Boolean(audioUrl)}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={handleSeeked}
        onTimeUpdate={syncAudio}
        onVolumeChange={handleVolumeChange}
        className={audioUrl ? styles.narratedVideo : undefined}
        style={{ width: '100%', display: 'block', maxHeight: '420px' }}
      />
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
    </div>
  )
}

/** Lightweight row used for the nav tree + search. Content is loaded lazily. */
interface PublicPage {
  id: string
  title: string
  slug: string
  parentId: string | null
  sortOrder: number
  hasVideo?: boolean
}

/** Content loaded on demand for a single page. */
interface PublicPageContent {
  id: string
  title: string
  slug: string
  content: string | null
  parentId: string | null
  sortOrder: number
  videoUrl?: string | null
  audioUrl?: string | null
}

interface PublicProject {
  id: string
  name: string
  description: string | null
  design: ProjectDesignDTO | null
}

// API client for the public, anonymous chat endpoints. Same shape as the
// admin api.chat but skips JWT auth — the routes are gated server-side
// by `publicDocsChatEnabled` and rate-limited per IP.
function buildPublicChatApi(): ChatSurfaceApi {
  return {
    status: async (projectId: string) => {
      const res = await fetch(`/api/docs/${projectId}/chat/status`)
      if (!res.ok) return { hasEmbeddings: false }
      const body = await res.json() as { ready: boolean }
      return { hasEmbeddings: body.ready }
    },
    suggestions: async (projectId: string) => {
      const res = await fetch(`/api/docs/${projectId}/chat/suggestions`)
      if (!res.ok) return { suggestions: [] }
      return res.json() as Promise<{ suggestions: string[] }>
    },
    send: async (projectId, message, history, sessionToken) => {
      const res = await fetch(`/api/docs/${projectId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, sessionToken }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(err?.error ?? `Chat failed: ${res.status}`)
      }
      return res.json() as Promise<ChatResponseDTO>
    },
    // Streaming SSE for the public docs chat surface. Same
    // implementation as api.chat.sendStream but unauthenticated and
    // pointed at the public-docs endpoint.
    sendStream: async function* (projectId, message, history, sessionToken, signal) {
      const res = await fetch(`/api/docs/${projectId}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, sessionToken }),
        signal,
      })
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(err?.error ?? `Chat stream failed: ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') return
            try {
              yield JSON.parse(payload) as ChatStreamEventDTO
            } catch { /* skip malformed frame */ }
          }
        }
      }
    },
  }
}

// --- Search helper: title search only.
// Content is lazy-loaded per page, so scanning every doc's markdown
// client-side would defeat the point. Titles still cover the majority
// of "jump to page" queries — a server-side fulltext search can be
// added later if needed.
interface SearchResult { page: PublicPage; snippet: string }

function searchPages(pages: PublicPage[], query: string): SearchResult[] {
  if (!query || query.length < 2) return []
  const q = query.toLowerCase()
  const results: SearchResult[] = []
  for (const p of pages) {
    if (p.title.toLowerCase().includes(q)) {
      results.push({ page: p, snippet: p.title })
    }
  }
  return results.slice(0, 8)
}

interface TreePage extends PublicPage {
  children: TreePage[]
}

function buildPageTree(pages: PublicPage[]): TreePage[] {
  const map = new Map<string, TreePage>()
  const roots: TreePage[] = []
  for (const p of pages) map.set(p.id, { ...p, children: [] })
  for (const p of pages) {
    const node = map.get(p.id)!
    if (p.parentId && map.has(p.parentId)) {
      map.get(p.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function NavTree({ items, activePage, onSelect, onPrefetch, depth = 0 }: {
  items: TreePage[]
  activePage: PublicPage | null
  onSelect: (page: PublicPage) => void
  onPrefetch: (page: PublicPage) => void
  depth?: number
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <>
      {items.map((p) => {
        const hasChildren = p.children.length > 0
        const isCollapsed = collapsed.has(p.id)
        return (
          <div key={p.id}>
            <div className={styles.navRow} style={{ paddingLeft: `${depth * 14 + 4}px` }}>
              {hasChildren ? (
                <button className={styles.navChevron} onClick={() => toggle(p.id)}>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }}
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              ) : (
                <span className={styles.navSpacer} />
              )}
              <button
                className={`${styles.navItem} ${activePage?.id === p.id ? styles.navItemActive : ''}`}
                onClick={() => onSelect(p)}
                onMouseEnter={() => onPrefetch(p)}
                onFocus={() => onPrefetch(p)}
                title={p.title}
              >
                {p.title}
              </button>
            </div>
            {hasChildren && !isCollapsed && (
              <NavTree items={p.children} activePage={activePage} onSelect={onSelect} onPrefetch={onPrefetch} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </>
  )
}

export function PublicDocs(): React.ReactElement {
  const { projectId, slug } = useParams<{ projectId: string; slug?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  // The /docs/:projectId/chat route renders the chat as a full page in
  // the content area instead of as a drawer — still wrapped by the same
  // sidebar + topbar so users can navigate back to a page in one click.
  const inChatMode = location.pathname.endsWith('/chat')
  const [project, setProject] = useState<PublicProject | null>(null)
  const [chatEnabled, setChatEnabled] = useState(false)
  const chatApiRef = useRef<ChatSurfaceApi>(buildPublicChatApi())
  const [pages, setPages] = useState<PublicPage[]>([])
  const [activePage, setActivePage] = useState<PublicPage | null>(null)
  // Per-slug cache for lazily-loaded page bodies. Revisiting a page is free
  // after the first hit; navigating a 200-page doc site no longer forces
  // the server to ship all content up front.
  const [pageContents, setPageContents] = useState<Map<string, PublicPageContent>>(() => new Map())
  const [contentLoading, setContentLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Close search on outside click
  useEffect(() => {
    if (!searchFocused) return
    const handler = (e: MouseEvent): void => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchFocused(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [searchFocused])

  useEffect(() => {
    if (!projectId) return
    void (async () => {
      try {
        const res = await fetch(`/api/docs/${projectId}`)
        if (!res.ok) throw new Error('Not found')
        const data = await res.json() as { project: PublicProject; chatEnabled?: boolean; pages: PublicPage[] }
        setProject(data.project)
        setChatEnabled(Boolean(data.chatEnabled))
        setPages(data.pages)
        if (data.pages.length > 0) {
          const initial = (slug ? data.pages.find((p) => p.slug === slug) : null) ?? data.pages[0] ?? null
          setActivePage(initial)
        }
      } catch {
        setError('Documentation not found')
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Sync active page when the URL slug changes (back/forward, deep link)
  useEffect(() => {
    if (!slug || pages.length === 0) return
    const match = pages.find((p) => p.slug === slug)
    if (match && match.id !== activePage?.id) setActivePage(match)
  }, [slug, pages, activePage?.id])

  // Track in-flight prefetches so hovering twice on the same nav item
  // doesn't fire duplicate requests. Shared between the hover prefetch
  // and the active-page effect so they collapse into a single fetch.
  const inFlightRef = useRef<Set<string>>(new Set())

  // Prefetch a page's content into the cache if we don't already have it.
  // Called from the nav tree on hover/focus so clicking feels instant,
  // and from the active-page effect on direct navigation.
  const prefetchPage = useCallback((page: PublicPage): void => {
    if (!projectId) return
    if (pageContents.has(page.slug)) return
    if (inFlightRef.current.has(page.slug)) return
    inFlightRef.current.add(page.slug)
    void (async () => {
      try {
        const res = await fetch(`/api/docs/${projectId}/pages/${encodeURIComponent(page.slug)}`)
        if (!res.ok) throw new Error('Page not found')
        const body = await res.json() as PublicPageContent
        setPageContents((prev) => {
          const next = new Map(prev)
          next.set(body.slug, body)
          return next
        })
      } catch {
        // Soft-fail: the page shell still renders, just without content.
      } finally {
        inFlightRef.current.delete(page.slug)
      }
    })()
  }, [projectId, pageContents])

  // Drive the loading spinner for the currently-viewed page. Prefetch
  // dedupes with inFlightRef so this doesn't trigger a second request.
  useEffect(() => {
    if (!projectId || !activePage) return
    if (pageContents.has(activePage.slug)) { setContentLoading(false); return }
    setContentLoading(true)
    prefetchPage(activePage)
  }, [projectId, activePage, pageContents, prefetchPage])

  // Clear the spinner once the active page's content lands in cache.
  useEffect(() => {
    if (!activePage) return
    if (pageContents.has(activePage.slug)) setContentLoading(false)
  }, [activePage, pageContents])

  // Fire-and-forget: ping the view endpoint so the owner sees page-view
  // analytics. Dedupe per slug so strict-mode / re-renders don't double-count.
  const viewedSlugsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!projectId || !activePage) return
    if (viewedSlugsRef.current.has(activePage.slug)) return
    viewedSlugsRef.current.add(activePage.slug)
    void (async () => {
      try {
        const { getChatSessionToken } = await import('../../../shared/hooks/useChatSessionToken.js')
        await fetch(`/api/docs/${projectId}/view`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageSlug: activePage.slug,
            sessionToken: getChatSessionToken(projectId),
          }),
        })
      } catch { /* analytics is best-effort */ }
    })()
  }, [projectId, activePage])

  const selectPage = useCallback((page: PublicPage) => {
    setActivePage(page)
    if (projectId) navigate(`/docs/${projectId}/${page.slug}`, { replace: true })
  }, [navigate, projectId])

  // Load the Google Font matching the stored design.font, if any. We
  // resolve the CSS family value against the curated allowlist
  // (src/shared/design/fonts.ts) — anything that doesn't match (legacy
  // data, hand-edited DB row) silently no-ops instead of hitting an
  // attacker-shaped URL.
  const designFont = project?.design?.font
  useEffect(() => {
    if (!designFont) return
    void (async () => {
      const { findByCssValue, googleFontStylesheetUrl } = await import('../../../../shared/design/fonts.js')
      const opt = findByCssValue(designFont)
      if (!opt?.googleName) return
      const href = googleFontStylesheetUrl(opt.googleName)
      if (!href) return
      const id = `gf-${opt.googleName.replace(/\s+/g, '-').toLowerCase()}`
      if (document.getElementById(id)) return
      const link = document.createElement('link')
      link.id = id
      link.rel = 'stylesheet'
      link.href = href
      link.crossOrigin = 'anonymous'
      link.referrerPolicy = 'no-referrer'
      document.head.appendChild(link)
    })()
  }, [designFont])

  if (loading) {
    return <div className={styles.center}><Spinner size="lg" /></div>
  }

  if (error || !project) {
    return <div className={styles.center}><EmptyState title="Not found" description="This documentation doesn't exist or isn't published yet." /></div>
  }

  if (pages.length === 0) {
    return <div className={styles.center}><EmptyState title="No published pages" description="This project hasn't published any documentation yet." /></div>
  }

  const design = project.design
  const themeStyle = design ? computeFullTheme(design) : undefined

  return (
    <div className={styles.shell} style={themeStyle} data-theme="light">
      <header className={styles.topbar}>
        {project.design?.logoUrl ? (
          <img src={project.design.logoUrl} alt={project.name} className={styles.logoImg} />
        ) : null}
        <span className={styles.logo}>{project.name}</span>
        <span className={styles.badge}>Documentation</span>
        <div className={styles.searchWrapper} ref={searchRef}>
          <div className={`${styles.searchBar} ${searchFocused ? styles.searchBarFocused : ''}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input className={styles.searchInput} placeholder="Search docs..." value={search} onChange={(e) => setSearch(e.target.value)} onFocus={() => setSearchFocused(true)} />
            {search && (
              <button className={styles.searchClear} onClick={() => { setSearch(''); setSearchFocused(false) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            )}
          </div>
          {searchFocused && search.length >= 2 && (() => {
            const results = searchPages(pages, search)
            return (
              <div className={styles.searchDropdown}>
                {results.length === 0 ? (
                  <div className={styles.searchEmpty}>No results</div>
                ) : results.map((r) => (
                  <button
                    key={r.page.id}
                    className={styles.searchResult}
                    onMouseEnter={() => prefetchPage(r.page)}
                    onFocus={() => prefetchPage(r.page)}
                    onClick={() => { selectPage(r.page); setSearch(''); setSearchFocused(false) }}
                  >
                    <span className={styles.searchResultTitle}>{r.page.title}</span>
                    <span className={styles.searchResultSnippet}>{r.snippet}</span>
                  </button>
                ))}
              </div>
            )
          })()}
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <nav className={styles.nav}>
            <NavTree items={buildPageTree(pages)} activePage={activePage} onSelect={selectPage} onPrefetch={prefetchPage} />
          </nav>
          <a
            className={styles.poweredBy}
            href="https://doclee.tech?utm_source=public-docs&utm_medium=powered-by"
            target="_blank"
            rel="noreferrer"
          >
            <span className={styles.poweredByLabel}>Powered by</span>
            <span className={styles.poweredByName}>doclee</span>
          </a>
        </aside>

        <div className={styles.contentWrapper} ref={contentRef}>
          {inChatMode ? (
            <div className={styles.chatContainer}>
              <ChatSurface
                projectId={project.id}
                projectName={project.name}
                api={chatApiRef.current}
                onSourceClick={(s) => {
                  const target = pages.find((p) => p.slug === s.pageSlug || p.id === s.pageId)
                  if (target) navigate(`/docs/${project.id}/${target.slug}`)
                }}
                // Attach the narrated video player inline when the cited
                // page has one — so answers like "check how to publish"
                // actually include the screen recording with voice-over.
                // Only cited pages already visited (or ones whose content
                // was warmed up elsewhere) can inline their video here.
                // For uncached pages we fall back to the link-only source
                // chip — same behaviour as any other unknown resource.
                resolveSourceMedia={(s) => {
                  const meta = pages.find((p) => p.id === s.pageId || p.slug === s.pageSlug)
                  if (!meta) return null
                  const cached = pageContents.get(meta.slug)
                  if (!cached?.videoUrl) return null
                  return { videoUrl: cached.videoUrl, audioUrl: cached.audioUrl ?? null }
                }}
              />
            </div>
          ) : (
          <div className={styles.content}>
            {activePage && (() => {
              const cached = pageContents.get(activePage.slug)
              return (
                <>
                  <h1 className={styles.pageTitle}>{activePage.title}</h1>
                  <div className={styles.articleIndent}>
                    {cached?.videoUrl && (
                      <NarratedVideo videoUrl={cached.videoUrl} audioUrl={cached.audioUrl ?? undefined} />
                    )}
                    {cached ? (
                      cached.content ? (
                        <MarkdownRenderer content={cached.content} />
                      ) : (
                        <p className={styles.empty}>This page has no content yet.</p>
                      )
                    ) : contentLoading ? (
                      <div style={{ padding: 'var(--space-xl) 0', display: 'flex', justifyContent: 'center' }}>
                        <Spinner size="md" />
                      </div>
                    ) : null}
                  </div>
                  {/* Notion-style child page links */}
                  {(() => {
                    const children = pages.filter((p) => p.parentId === activePage.id)
                    if (children.length === 0) return null
                    return (
                      <div className={styles.childPages}>
                        {children.map((child) => (
                          <button
                            key={child.id}
                            className={styles.childPageLink}
                            onMouseEnter={() => prefetchPage(child)}
                            onFocus={() => prefetchPage(child)}
                            onClick={() => selectPage(child)}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.342a2 2 0 0 0-.602-1.43l-4.44-4.342A2 2 0 0 0 13.56 2H6a2 2 0 0 0-2 2z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
                            {child.title}
                          </button>
                        ))}
                      </div>
                    )
                  })()}
                </>
              )
            })()}
          </div>
          )}
          {!inChatMode && activePage && pageContents.get(activePage.slug)?.content && (
            <TableOfContents content={pageContents.get(activePage.slug)!.content!} scrollContainer={contentRef.current} />
          )}
        </div>
      </div>

      {chatEnabled && !inChatMode && (
        <button
          className={styles.chatLauncher}
          onClick={() => navigate(`/docs/${project.id}/chat`)}
          aria-label="Chat with the documentation"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Chat with docs
        </button>
      )}
    </div>
  )
}
