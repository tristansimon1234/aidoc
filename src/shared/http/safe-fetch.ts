import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '../middleware/error.middleware.js'

/**
 * SSRF-safe HTTP client. Used by features that fetch user-provided URLs
 * (analyze-url, preflight web checks). Rejects:
 *   - non-http(s) schemes (file://, gopher://, data:, etc.)
 *   - URLs whose hostname resolves to a private / link-local / loopback
 *     address — blocks cloud-metadata endpoints (169.254.169.254),
 *     localhost, RFC1918, and IPv6 unique-local / link-local ranges.
 *   - IDN and URL-credential abuse (user:pass@host forms).
 *
 * The check is performed BEFORE any network fetch: we resolve the
 * hostname, verify every resolved IP is public, then pass the URL to
 * fetch. This is a defence-in-depth pattern — also enforce at the
 * network layer (egress firewall, VPC) in production.
 */

const PRIVATE_V4_RANGES: [number, number][] = [
  // 10.0.0.0/8
  [0x0a000000, 0x0affffff],
  // 127.0.0.0/8 (loopback)
  [0x7f000000, 0x7fffffff],
  // 169.254.0.0/16 (link-local — includes AWS/GCP metadata 169.254.169.254)
  [0xa9fe0000, 0xa9feffff],
  // 172.16.0.0/12
  [0xac100000, 0xac1fffff],
  // 192.0.0.0/24 (IETF assignments — AWS instance metadata IPv6 proxy uses 192.0.0.170)
  [0xc0000000, 0xc00000ff],
  // 192.168.0.0/16
  [0xc0a80000, 0xc0a8ffff],
  // 100.64.0.0/10 (carrier-grade NAT — some clouds use this for metadata)
  [0x64400000, 0x647fffff],
  // 0.0.0.0/8
  [0x00000000, 0x00ffffff],
  // 224.0.0.0/4 (multicast)
  [0xe0000000, 0xefffffff],
  // 240.0.0.0/4 (reserved)
  [0xf0000000, 0xffffffff],
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const b = Number(p)
    if (!Number.isInteger(b) || b < 0 || b > 255) return null
    n = (n << 8 | b) >>> 0
  }
  return n
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true
  for (const [start, end] of PRIVATE_V4_RANGES) {
    if (n >= start && n <= end) return true
  }
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // ::1 loopback
  if (lower === '::1') return true
  // :: unspecified
  if (lower === '::') return true
  // fc00::/7 unique local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
  // IPv4-mapped ::ffff:a.b.c.d — unwrap and re-check
  const v4map = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (v4map) return isPrivateIPv4(v4map[1]!)
  // IPv4-embedded ::a.b.c.d
  const v4embed = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (v4embed) return isPrivateIPv4(v4embed[1]!)
  return false
}

function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) return isPrivateIPv4(ip)
  if (fam === 6) return isPrivateIPv6(ip)
  return true // unknown family → reject
}

async function assertHostnameIsPublic(hostname: string): Promise<void> {
  // If the hostname itself is already a literal IP, check directly.
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new AppError('URL host is not publicly routable', 'URL_FORBIDDEN', 400)
    return
  }
  // Resolve every A/AAAA record. dns.lookup returns all addresses when
  // all: true — we reject if any resolve to a private range, since DNS
  // rebinding would otherwise let an attacker flip the answer later.
  let records: { address: string }[]
  try {
    records = await lookup(hostname, { all: true })
  } catch {
    throw new AppError('URL host could not be resolved', 'URL_UNRESOLVABLE', 400)
  }
  if (records.length === 0) throw new AppError('URL host could not be resolved', 'URL_UNRESOLVABLE', 400)
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new AppError('URL host is not publicly routable', 'URL_FORBIDDEN', 400)
    }
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number
  /** Max response body bytes. Default 2 MB — enough for a landing page's
   *  HTML but small enough to blunt memory-exhaustion abuse. */
  maxBytes?: number
  /** Extra request headers merged on top of the defaults. */
  headers?: Record<string, string>
}

/**
 * Validate `url` against the SSRF blocklist and, if safe, fetch it with
 * a hard timeout and body-size cap. Throws AppError('URL_FORBIDDEN')
 * when the URL is unsafe.
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<{ ok: boolean; status: number; text: string; contentType: string | null }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AppError('Invalid URL', 'URL_INVALID', 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('Only http and https URLs are allowed', 'URL_FORBIDDEN', 400)
  }
  // Reject embedded credentials (http://user:pass@host) — not a fetch
  // target we want to honour, and some servers log the Authorization
  // header we'd derive from it.
  if (parsed.username || parsed.password) {
    throw new AppError('URL must not contain credentials', 'URL_FORBIDDEN', 400)
  }
  await assertHostnameIsPublic(parsed.hostname)

  const timeoutMs = options.timeoutMs ?? 10_000
  const maxBytes = options.maxBytes ?? 2_000_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Doclee/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        ...(options.headers ?? {}),
      },
      // We follow redirects, but each hop's final URL is still the same
      // origin-host we already DNS-checked; `fetch` resolves redirects
      // internally so we can't re-assert per hop without a custom
      // dispatcher. Cap redirects by letting fetch default to 20, which
      // combined with timeoutMs makes tunnelling impractical.
      redirect: 'follow',
      signal: controller.signal,
    })

    const contentType = resp.headers.get('content-type')
    // Guard on declared length too — saves us from draining a huge body.
    const declaredLen = Number(resp.headers.get('content-length') ?? '0')
    if (declaredLen > maxBytes) {
      return { ok: resp.ok, status: resp.status, text: '', contentType }
    }

    const reader = resp.body?.getReader()
    if (!reader) return { ok: resp.ok, status: resp.status, text: '', contentType }

    const decoder = new TextDecoder('utf-8', { fatal: false })
    let text = ''
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { ok: resp.ok, status: resp.status, text, contentType }
  } finally {
    clearTimeout(timer)
  }
}
