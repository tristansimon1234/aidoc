import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient } from '@supabase/supabase-js'

/**
 * SSR handler for /docs/:projectId[/:slug] — returns the same SPA shell
 * (dist/client/index.html) with <title> + Open Graph + Twitter Card meta
 * tags injected per project/page.
 *
 * Why: LinkedIn, WhatsApp, Slack, Twitter and friends scrape the *initial*
 * HTML payload, without executing JavaScript. A pure SPA therefore always
 * renders the static `<title>doclee</title>` in their previews — no way to
 * tell one shared doc from another. This function runs on Vercel ahead of
 * the SPA and rewrites just the <head> so crawlers see a preview specific
 * to the page being shared. Real users still get the full SPA behind it.
 */

// vercel.json pins the HTML file into the function bundle via includeFiles.
// Cache on first read; cold starts only pay the disk hit once.
const HTML_PATH = path.join(process.cwd(), 'dist/client/index.html')
let htmlCache: string | null = null
function getBaseHtml(): string {
  if (htmlCache === null) {
    try {
      htmlCache = fs.readFileSync(HTML_PATH, 'utf8')
    } catch {
      // Last-resort fallback so we never 500 just because of a path miss.
      htmlCache = '<!DOCTYPE html><html><head><title>doclee</title></head><body><div id="root"></div></body></html>'
    }
  }
  return htmlCache
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Strip markdown syntax for use as an OG description. Not perfect — we're
 *  going for "mostly-readable sentence", not a full MD → text converter. */
function markdownToPreview(md: string, max = 180): string {
  const stripped = md
    .replace(/```[\s\S]*?```/g, ' ')     // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')         // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')// images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/^#{1,6}\s+/gm, '')         // headings
    .replace(/^>\s?/gm, '')              // quotes
    .replace(/^[-*+]\s+/gm, '')          // bullets
    .replace(/^\d+\.\s+/gm, '')          // ordered lists
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold / italic / strike
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= max) return stripped
  return stripped.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

interface MetaInput {
  title: string
  description: string
  url: string
  image: string | null
}

function buildMetaBlock(m: MetaInput): string {
  const t = escapeHtml(m.title)
  const d = escapeHtml(m.description)
  const u = escapeHtml(m.url)
  const lines = [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${u}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="doclee" />`,
    `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
  ]
  if (m.image) {
    const i = escapeHtml(m.image)
    lines.push(`<meta property="og:image" content="${i}" />`)
    lines.push(`<meta name="twitter:image" content="${i}" />`)
  }
  return lines.join('\n    ')
}

interface ProjectRow {
  id: string
  name: string
  description: string | null
  design: { logoUrl?: string | null } | null
}

interface PageRow {
  title: string
  content: string | null
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The rewrite strips the /docs prefix via destination=/api/docs-ssr but the
  // original URL (with projectId + slug) is forwarded as-is on req.url. Match
  // against both shapes so this works whether Vercel rewrites preserve /docs
  // or not.
  const rawUrl = req.url ?? ''
  const pathname = rawUrl.split('?')[0] ?? ''
  const match = /^\/(?:docs\/|api\/docs-ssr\/?)?([0-9a-f-]{36})(?:\/([a-z0-9-]+))?\/?$/i.exec(pathname)

  const sendHtml = (html: string, status = 200, cache = true): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (cache) {
      // 5-min edge cache + 1-day stale-while-revalidate — good enough for
      // doc updates to propagate without hammering Supabase on every crawl.
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400')
    } else {
      res.setHeader('Cache-Control', 'no-store')
    }
    res.end(html)
  }

  const base = getBaseHtml()

  const projectId = match?.[1]
  const slug = match?.[2]
  if (!projectId) {
    sendHtml(base, 200, false)
    return
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
    if (!supabaseUrl || !supabaseKey) {
      sendHtml(base, 200, false)
      return
    }
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: projectData } = await supabase
      .from('projects')
      .select('id, name, description, design')
      .eq('id', projectId)
      .maybeSingle()

    if (!projectData) {
      sendHtml(base, 200, false)
      return
    }
    const project = projectData as ProjectRow

    const projectName = project.name
    const logoUrl = project.design?.logoUrl ?? null

    let title = `${projectName} — Documentation`
    let description = project.description?.trim() || `Product documentation for ${projectName}. Powered by doclee.`
    let image = logoUrl

    if (slug) {
      const { data: pageData } = await supabase
        .from('doc_pages')
        .select('title, content')
        .eq('project_id', projectId)
        .eq('slug', slug)
        .eq('is_public', true)
        .maybeSingle()
      if (pageData) {
        const page = pageData as PageRow
        title = `${page.title} — ${projectName}`
        const preview = markdownToPreview(page.content ?? '')
        if (preview) description = preview
      }
    }

    // Absolute URL for og:url + canonical. PUBLIC_APP_URL is the canonical
    // prod origin; fall back to the Host header for preview deploys.
    const envOrigin = process.env.PUBLIC_APP_URL?.replace(/\/$/, '')
    const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host
    const hostOrigin = hostHeader ? `https://${String(hostHeader).split(',')[0]}` : null
    const origin = envOrigin ?? hostOrigin ?? 'https://app.doclee.tech'
    const url = slug ? `${origin}/docs/${projectId}/${slug}` : `${origin}/docs/${projectId}`

    const meta = buildMetaBlock({ title, description, url, image })

    // Replace the default <title>doclee</title> (plus the following
    // meta/link siblings) with our dynamic block. Match leniently so minor
    // formatting changes in index.html don't break the injection.
    const html = base.replace(/<title>[^<]*<\/title>/i, meta)

    sendHtml(html)
  } catch (err) {
    // Never let an SSR glitch break the page — fall back to the vanilla
    // SPA shell so the user (and crawler) still gets something.
    console.error('[docs-ssr] failed:', (err as Error).message)
    sendHtml(base, 200, false)
  }
}
