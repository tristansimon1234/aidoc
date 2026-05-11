# Email Templates & SMTP Runbook

This doc captures the configuration you apply in the Supabase dashboard (plus the Resend account) so signups, password resets, and team invites arrive from your domain with the doclee branding. Nothing here is enforced by code — it's a reproducibility log.

---

## 1 · Resend (SMTP provider)

1. Create an account at [resend.com](https://resend.com) — free tier = 3 000 emails / month.
2. **Add your domain** (Domains → Add Domain → `doclee.tech`).
3. Paste the DNS records Resend gives you into your registrar:

   | Type  | Host                   | Value                                                |
   |-------|------------------------|------------------------------------------------------|
   | TXT   | `@`                    | `v=spf1 include:amazonses.com ~all`                  |
   | CNAME | `resend._domainkey`    | _(value from Resend dashboard)_                      |
   | MX    | `send` (optional, replies) | `feedback-smtp.us-east-1.amazonses.com` priority 10 |

4. Wait for the dashboard to mark the domain **Verified** (usually <5 min).
5. Create an API key scoped to **Sending access** — copy it once, it won't show again.

---

## 2 · Supabase SMTP

Supabase Dashboard → Project → **Authentication** → **SMTP Settings** → Enable Custom SMTP.

| Field          | Value                                   |
|----------------|-----------------------------------------|
| Host           | `smtp.resend.com`                       |
| Port           | `465`                                   |
| Username       | `resend`                                |
| Password       | `<Resend API key>`                      |
| Sender email   | `hello@doclee.tech`                       |
| Sender name    | `doclee`                                 |
| Minimum interval | `60` (seconds between emails per user)|

Save, then send yourself a test email from **Authentication → Users → Send magic link** to verify.

---

## 3 · Redirect URLs

Supabase Dashboard → **Authentication** → **URL Configuration**.

- **Site URL**: `https://app.doclee.tech`
- **Additional Redirect URLs**:
  - `http://localhost:3000/**`
  - `http://localhost:5173/**`
  - `https://*-tristans-projects-*.vercel.app/**` (preview deploys)
  - `https://app.doclee.tech/auth/reset`
  - `https://app.doclee.tech/invite/**`

The frontend asks Supabase to redirect password-reset emails to `${origin}/auth/reset` — that path must be in the allow-list or the link will 400.

---

## 4 · Email Templates

Supabase Dashboard → **Authentication** → **Email Templates**. Four templates to customise; all share a simple dark-header + CTA button design so they feel consistent with the team-invite email we build ourselves (`src/shared/email/templates/invite.ts`).

The templating language is Go's `text/template` inside HTML. Available variables: `.ConfirmationURL`, `.Email`, `.SiteURL`, `.TokenHash`, `.RedirectTo`.

### 4a · Confirm signup

**Subject**: `Confirm your doclee account`

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0c0c0e;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
        <tr><td style="background:#0c0c0e;padding:20px 32px;color:#fff;font-weight:600;font-size:14px;">doclee</td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;">Confirm your email</h1>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52525b;">
            Welcome to doclee. Click the button below to confirm your email address and sign in.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="border-radius:8px;background:#635BFF;">
              <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 24px;color:#fff;text-decoration:none;font-weight:600;font-size:14px;">Confirm email</a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;line-height:1.5;">
            If the button doesn't work, paste this in your browser:<br />
            <span style="color:#635BFF;word-break:break-all;">{{ .ConfirmationURL }}</span>
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e4e4e7;font-size:11px;color:#a1a1aa;">
          You received this email because someone signed up for doclee with this address. Ignore if it wasn't you.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
```

### 4b · Reset password

**Subject**: `Reset your doclee password`

Same shell as above — replace the heading / copy / CTA label:

- `<h1>Reset your password</h1>`
- body: `Someone (hopefully you) asked to reset the password for your doclee account. Click the button to choose a new one.`
- button: `Reset password` → `{{ .ConfirmationURL }}`
- footer: `If you didn't request this, you can ignore this email — your password won't change.`

### 4c · Invite user

**Subject**: `You're invited to doclee`

Used by Supabase's own invite flow (Auth → Users → Invite). Our own team-invite email (sent via Resend directly from `team.service.inviteMember`) matches this styling.

### 4d · Magic link (unused today, configured for future)

**Subject**: `Your doclee sign-in link`

Same shell. Button: `Sign in` → `{{ .ConfirmationURL }}`.

---

## 5 · Smoke test after config

1. Sign up with a fresh email → the confirm email arrives within ~30 s, branded, from `hello@doclee.tech`.
   *(Note: while the design-partner allowlist is on, the email must be added at `/admin/allowlist` first or the signup is rejected at the DB level.)*
2. Sign in, sign out, click "Forgot password?" → recovery email arrives, branded. Click → lands on `/auth/reset`, new password flow works.
3. Create a new team (non-personal), invite a second address → team-invite email arrives (this one is built by our own code in `src/shared/email/templates/invite.ts`, sent through the same Resend account via `src/shared/email/resend.client.ts`). The same call also auto-allowlists the invitee so the signup at step 1 passes.
4. From `/admin/allowlist`, add a fresh email → welcome email (`src/shared/email/templates/welcome-allowlist.ts`) arrives. Re-adding the same email is a no-op — no duplicate message.

---

## 6 · Env vars for our own Resend client

Only needed for transactional emails we send ourselves (team invites, future quota alerts) — auth emails go through Supabase's SMTP and don't need these.

```
RESEND_API_KEY=re_...
EMAIL_FROM=doclee <hello@doclee.tech>
PUBLIC_APP_URL=https://app.doclee.tech   # used to build invite accept links
```

Set on Vercel (Production + Preview) and in `.env.local` for local dev.

If `RESEND_API_KEY` or `EMAIL_FROM` is missing, `sendEmail()` is a no-op + logs a warning — the app still works, the owner just has to copy the invite acceptance link from the UI instead.
