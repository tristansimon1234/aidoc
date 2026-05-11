import { env } from '../../shared/config/env.js'
import { sendEmail } from '../../shared/email/resend.client.js'
import { buildWelcomeAllowlistEmail } from '../../shared/email/templates/welcome-allowlist.js'
import { findProfileById, findAuthUserEmail } from '../profile/profile.repository.js'
import * as allowlistRepo from './allowlist.repository.js'
import type { AllowedEmail } from './allowlist.types.js'

export interface AddAllowedEmailOptions {
  /**
   * When true, send the "you've been added to the allowlist" email — but
   * only if the row is actually new. Re-adding the same address (e.g. an
   * admin double-clicking) won't trigger a duplicate email.
   *
   * The team-invite path sets this to false: it already sends its own
   * dedicated invite email, and a second welcome message would just be
   * noise.
   */
  sendWelcome: boolean
}

/**
 * Idempotent add: upserts the row, returns whether it was newly created,
 * and (optionally) sends the welcome email when new.
 *
 * Email is best-effort — a Resend outage or missing config never fails the
 * allowlist write itself. The admin can always re-trigger a welcome by
 * removing + re-adding, which is rare enough that we don't bother surfacing
 * a "resend" button.
 */
export async function addAllowedEmail(
  email: string,
  note: string | null,
  createdBy: string,
  options: AddAllowedEmailOptions,
): Promise<{ row: AllowedEmail; created: boolean; emailSent: boolean }> {
  const normalized = email.trim().toLowerCase()
  const existing = await allowlistRepo.findAllowedEmail(normalized)
  const row = await allowlistRepo.addAllowedEmail(normalized, note, createdBy)
  const created = existing === null

  let emailSent = false
  if (options.sendWelcome && created) {
    try {
      const inviter = await findProfileById(createdBy)
      const inviterName =
        inviter?.fullName ?? (await findAuthUserEmail(createdBy)) ?? null
      const signupUrl = `${env.PUBLIC_APP_URL ?? ''}/login`
      const { subject, html } = buildWelcomeAllowlistEmail({
        email: normalized,
        signupUrl,
        inviterName,
      })
      const result = await sendEmail({ to: normalized, subject, html })
      emailSent = result.sent
    } catch (err) {
      // Don't fail the allowlist write on email errors — log and move on.
      console.warn(`[allowlist] welcome email failed for ${normalized}: ${(err as Error).message}`)
    }
  }

  return { row, created, emailSent }
}
