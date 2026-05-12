import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { Spinner, EmptyState, MarkdownRenderer, TableOfContents, Tooltip } from '../../../design-system/components/index.js'
import type { ProjectDesignDTO, ChatResponseDTO, ChatStreamEventDTO } from '../../../shared/api/client.js'
import { computeFullTheme } from '../../../shared/theme/computeTheme.js'
import { ChatSurface, type ChatSurfaceApi } from '../../chat/components/ChatSurface.js'
import { DocsChatPanel } from '../components/DocsChatPanel.js'
import { StickyChatBar } from '../components/StickyChatBar.js'
import { useDocsChat } from '../hooks/useDocsChat.js'
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
  /** Tab this page belongs to — used to filter the sidebar by active
   *  tab and to resolve the canonical URL on legacy lookups. */
  tabId: string
}

interface PublicTab {
  id: string
  name: string
  slug: string
  sortOrder: number
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
        // Top-level pages with children read as section headers — they
        // group their sub-pages visually. Clicking the title still
        // navigates (some sites use the section page as an overview);
        // the chevron handles expand/collapse separately.
        const isSection = depth === 0 && hasChildren
        return (
          <div key={p.id}>
            <div
              className={`${styles.navRow} ${isSection ? styles.navRowSection : ''}`}
              style={isSection ? undefined : { paddingLeft: `${depth * 14 + 4}px` }}
            >
              {hasChildren ? (
                <button className={styles.navChevron} onClick={() => toggle(p.id)} aria-label={isCollapsed ? 'Expand' : 'Collapse'}>
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
              isSection ? (
                <div className={styles.navSubGroup}>
                  <NavTree items={p.children} activePage={activePage} onSelect={onSelect} onPrefetch={onPrefetch} depth={depth + 1} />
                </div>
              ) : (
                <NavTree items={p.children} activePage={activePage} onSelect={onSelect} onPrefetch={onPrefetch} depth={depth + 1} />
              )
            )}
          </div>
        )
      })}
    </>
  )
}

export function PublicDocs(): React.ReactElement {
  // React Router 7: the canonical route is /docs/:projectId/:tabSlug/:slug
  // while the legacy 2-segment route is /docs/:projectId/:slug. The
  // `tabSlug` param is only populated by the 3-segment route; we treat
  // its absence as "legacy URL, redirect to canonical once we know the
  // page's tab".
  const { projectId, slug, tabSlug: urlTabSlug } = useParams<{ projectId: string; slug?: string; tabSlug?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  // The /docs/:projectId/chat route renders the chat full-screen inside
  // the content area. Conversation state is still owned by the
  // useDocsChat hook so the user can switch between panel + fullpage
  // without losing context.
  const inChatMode = location.pathname.endsWith('/chat')
  const [project, setProject] = useState<PublicProject | null>(null)
  const [chatEnabled, setChatEnabled] = useState(false)
  const chatApiRef = useRef<ChatSurfaceApi>(buildPublicChatApi())
  const [pages, setPages] = useState<PublicPage[]>([])
  const [tabs, setTabs] = useState<PublicTab[]>([])
  const [activeTab, setActiveTab] = useState<PublicTab | null>(null)
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

  // Persistent chat state shared by the panel, the topbar button, the
  // sticky bar, and the full-page route. Conversation is mirrored to
  // sessionStorage so refreshes preserve it.
  const docsChat = useDocsChat(projectId)

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
        const data = await res.json() as { project: PublicProject; chatEnabled?: boolean; tabs?: PublicTab[]; pages: PublicPage[] }
        setProject(data.project)
        setChatEnabled(Boolean(data.chatEnabled))
        setPages(data.pages)
        const tabList = (data.tabs ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder)
        setTabs(tabList)

        // Pick the active tab. Priority:
        //   1. Explicit :tabSlug in the URL (canonical path).
        //   2. The tab containing the legacy :slug if only that was given.
        //   3. The first tab.
        let initialTab = tabList[0] ?? null
        if (urlTabSlug) {
          initialTab = tabList.find((t) => t.slug === urlTabSlug) ?? initialTab
        } else if (slug && slug !== 'chat') {
          const matchPage = data.pages.find((p) => p.slug === slug)
          if (matchPage) {
            initialTab = tabList.find((t) => t.id === matchPage.tabId) ?? initialTab
          }
        }
        setActiveTab(initialTab)

        if (data.pages.length > 0) {
          const pagesInTab = initialTab ? data.pages.filter((p) => p.tabId === initialTab!.id) : data.pages
          const initial = (slug && slug !== 'chat'
            ? pagesInTab.find((p) => p.slug === slug)
            : null) ?? pagesInTab[0] ?? data.pages[0] ?? null
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

  // Sync active page when the URL slug changes (back/forward, deep link).
  // Tab disambiguates when the slug repeats across tabs — restrict to
  // the active tab's pages when one is known, fall back to global match.
  useEffect(() => {
    if (!slug || pages.length === 0) return
    const scope = activeTab ? pages.filter((p) => p.tabId === activeTab.id) : pages
    const match = scope.find((p) => p.slug === slug) ?? pages.find((p) => p.slug === slug)
    if (match && match.id !== activePage?.id) {
      setActivePage(match)
      // If we landed via a legacy /docs/:projectId/:slug URL, swap to
      // the canonical /docs/:projectId/:tabSlug/:slug shape so refresh /
      // bookmarks pick up the right tab.
      if (!urlTabSlug && projectId && !inChatMode) {
        const tab = tabs.find((t) => t.id === match.tabId)
        if (tab) navigate(`/docs/${projectId}/${tab.slug}/${match.slug}`, { replace: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, pages, activePage?.id, activeTab?.id, urlTabSlug])

  // Track in-flight prefetches so hovering twice on the same nav item
  // doesn't fire duplicate requests. Shared between the hover prefetch
  // and the active-page effect so they collapse into a single fetch.
  const inFlightRef = useRef<Set<string>>(new Set())

  // Cache key includes the tab so slug-collisions across tabs land in
  // different buckets. Falls back to slug-only for legacy data points.
  const cacheKeyFor = useCallback((page: { tabId: string; slug: string }): string => `${page.tabId}/${page.slug}`, [])

  // Prefetch a page's content into the cache if we don't already have it.
  // Called from the nav tree on hover/focus so clicking feels instant,
  // and from the active-page effect on direct navigation.
  const prefetchPage = useCallback((page: PublicPage): void => {
    if (!projectId) return
    const key = cacheKeyFor(page)
    if (pageContents.has(key)) return
    if (inFlightRef.current.has(key)) return
    inFlightRef.current.add(key)
    const tabForPage = tabs.find((t) => t.id === page.tabId)
    void (async () => {
      try {
        // Prefer the tab-aware canonical endpoint when we know the tab —
        // it disambiguates when the same slug exists in two tabs. Fall
        // back to the legacy endpoint for early-loaded scenarios where
        // tabs[] hasn't landed yet.
        const url = tabForPage
          ? `/api/docs/${projectId}/tabs/${encodeURIComponent(tabForPage.slug)}/pages/${encodeURIComponent(page.slug)}`
          : `/api/docs/${projectId}/pages/${encodeURIComponent(page.slug)}`
        const res = await fetch(url)
        if (!res.ok) throw new Error('Page not found')
        const body = await res.json() as PublicPageContent & { tabId?: string }
        setPageContents((prev) => {
          const next = new Map(prev)
          next.set(`${body.tabId ?? page.tabId}/${body.slug}`, body)
          return next
        })
      } catch {
        // Soft-fail: the page shell still renders, just without content.
      } finally {
        inFlightRef.current.delete(key)
      }
    })()
  }, [projectId, pageContents, cacheKeyFor, tabs])

  // Drive the loading spinner for the currently-viewed page. Prefetch
  // dedupes with inFlightRef so this doesn't trigger a second request.
  useEffect(() => {
    if (!projectId || !activePage) return
    const key = cacheKeyFor(activePage)
    if (pageContents.has(key)) { setContentLoading(false); return }
    setContentLoading(true)
    prefetchPage(activePage)
  }, [projectId, activePage, pageContents, prefetchPage, cacheKeyFor])

  // Clear the spinner once the active page's content lands in cache.
  useEffect(() => {
    if (!activePage) return
    if (pageContents.has(cacheKeyFor(activePage))) setContentLoading(false)
  }, [activePage, pageContents, cacheKeyFor])

  // Fire-and-forget: ping the view endpoint so the owner sees page-view
  // analytics. Dedupe per slug so strict-mode / re-renders don't double-count.
  const viewedSlugsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!projectId || !activePage) return
    // Key views by (tab, slug) so the same slug across two tabs counts
    // separately for owner-facing analytics.
    const viewKey = `${activePage.tabId}/${activePage.slug}`
    if (viewedSlugsRef.current.has(viewKey)) return
    viewedSlugsRef.current.add(viewKey)
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
    if (!projectId) return
    // Always navigate to the canonical tab-aware URL so the link is
    // shareable. Fall back to flat path when somehow the tab metadata
    // hasn't loaded yet — shouldn't happen post-bootstrap.
    const tab = tabs.find((t) => t.id === page.tabId)
    if (tab) navigate(`/docs/${projectId}/${tab.slug}/${page.slug}`, { replace: true })
    else navigate(`/docs/${projectId}/${page.slug}`, { replace: true })
  }, [navigate, projectId, tabs])

  // Click handler for the top tab nav. Switches the active tab and
  // lands the user on the first page of the new tab so the content
  // pane never goes blank.
  const selectTab = useCallback((tab: PublicTab) => {
    setActiveTab(tab)
    const firstPage = pages.find((p) => p.tabId === tab.id && !p.parentId) ?? pages.find((p) => p.tabId === tab.id)
    if (!projectId) return
    if (firstPage) navigate(`/docs/${projectId}/${tab.slug}/${firstPage.slug}`)
    else navigate(`/docs/${projectId}/${tab.slug}`)
  }, [navigate, projectId, pages])

  const handleSourceClick = useCallback((s: { pageId: string; pageTitle: string; pageSlug: string }) => {
    const target = pages.find((p) => p.slug === s.pageSlug || p.id === s.pageId)
    if (target && projectId) navigate(`/docs/${projectId}/${target.slug}`)
  }, [pages, projectId, navigate])

  const resolveSourceMedia = useCallback((s: { pageId: string; pageSlug: string }) => {
    const meta = pages.find((p) => p.id === s.pageId || p.slug === s.pageSlug)
    if (!meta) return null
    const cached = pageContents.get(cacheKeyFor(meta))
    if (!cached?.videoUrl) return null
    return { videoUrl: cached.videoUrl, audioUrl: cached.audioUrl ?? null }
  }, [pages, pageContents, cacheKeyFor])

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
        {chatEnabled && !inChatMode && (
          <Tooltip content="Ask the assistant a question" placement="bottom">
            <button className={styles.askAi} onClick={() => docsChat.openChat()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 3v4" /><path d="M3 5h4" /><path d="M6 17v4" /><path d="M4 19h4" />
                <path d="m13 3 3.553 7.66L24 14l-7.447 3.34L13 25l-3.553-7.66L2 14l7.447-3.34Z" />
              </svg>
              Ask AI
            </button>
          </Tooltip>
        )}
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          {tabs.length > 1 && (
            <div className={styles.tabNav} role="tablist" aria-label="Documentation sections">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab?.id === t.id}
                  className={`${styles.tabNavItem} ${activeTab?.id === t.id ? styles.tabNavItemActive : ''}`}
                  onClick={() => selectTab(t)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <nav className={styles.nav}>
            <NavTree
              items={buildPageTree(activeTab ? pages.filter((p) => p.tabId === activeTab.id) : pages)}
              activePage={activePage}
              onSelect={selectPage}
              onPrefetch={prefetchPage}
            />
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
                onSourceClick={handleSourceClick}
                resolveSourceMedia={resolveSourceMedia}
                messages={docsChat.messages}
                onMessagesChange={docsChat.setMessages}
                pendingMessage={docsChat.pendingMessage}
                onPendingMessageConsumed={docsChat.consumePendingMessage}
              />
            </div>
          ) : (
          <div className={styles.rightInner}>
            <div className={styles.content}>
              {activePage && (() => {
                const cached = pageContents.get(cacheKeyFor(activePage))
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

                    {/* Sticky chat bar at the bottom of the article. Lives
                        inside the content column so it scrolls with the doc
                        but pins to the viewport while there's content below.
                        Hidden when the panel is already open. */}
                    {chatEnabled && !docsChat.open && (
                      <StickyChatBar
                        onSubmit={(msg) => docsChat.openChat(msg)}
                        onFocus={() => { /* opening on focus would steal the input — only on submit */ }}
                      />
                    )}
                  </>
                )
              })()}
            </div>

            {/* TOC column — lives INSIDE the scroll container so the
                doc scrollbar sits flush with the right edge of the
                window, not between content and TOC. `position: sticky`
                pins it to the top while the article scrolls. */}
            {activePage && pageContents.get(cacheKeyFor(activePage))?.content && (
              <div className={styles.tocColumn}>
                <TableOfContents
                  mode="sticky"
                  content={pageContents.get(cacheKeyFor(activePage))!.content!}
                  scrollContainer={contentRef.current}
                />
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {chatEnabled && !inChatMode && projectId && (
        <DocsChatPanel
          open={docsChat.open}
          onClose={docsChat.closeChat}
          onExpand={() => {
            docsChat.closeChat()
            navigate(`/docs/${projectId}/chat`)
          }}
          projectId={project.id}
          projectName={project.name}
          api={chatApiRef.current}
          messages={docsChat.messages}
          onMessagesChange={docsChat.setMessages}
          pendingMessage={docsChat.pendingMessage}
          onPendingMessageConsumed={docsChat.consumePendingMessage}
          onSourceClick={handleSourceClick}
          onReset={docsChat.reset}
          resolveSourceMedia={resolveSourceMedia}
        />
      )}
    </div>
  )
}
