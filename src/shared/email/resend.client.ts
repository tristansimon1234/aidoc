import { env } from '../config/env.js'

export interface SendEmailInput {
  to: string
  subject: string
  html: string
  replyTo?: string
}

/**
 * Send a transactional email via Resend. No-ops with a warning log when
 * RESEND_API_KEY or EMAIL_FROM isn't set (dev mode, or before the DNS is
 * configured) — lets every caller wire it up without gating signup / team
 * invites on missing infra.
 *
 * Not used for auth emails — those go through Supabase's built-in SMTP (also
 * pointed at Resend). This client is for our own transactional mail (team
 * invites, future quota alerts, doc-ready notifications).
 */
export async function sendEmail(input: SendEmailInput): Promise<{ sent: boolean; reason?: string }> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.warn(`[email] skipped (no RESEND_API_KEY / EMAIL_FROM) to=${input.to} subject=${input.subject}`)
    return { sent: false, reason: 'not_configured' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[email] resend rejected ${res.status}: ${body}`)
      return { sent: false, reason: `http_${res.status}` }
    }
    return { sent: true }
  } catch (err) {
    console.warn(`[email] resend call failed: ${(err as Error).message}`)
    return { sent: false, reason: 'network' }
  }
}
