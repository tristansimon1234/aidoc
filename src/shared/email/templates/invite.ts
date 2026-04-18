interface InviteEmailInput {
  teamName: string
  inviterName: string
  acceptUrl: string
}

/**
 * HTML for the team-invite email. Matches the visual language of the
 * Supabase auth templates (dark header, single CTA button, plain footer).
 * Table-based + inlined CSS so every mail client renders it.
 */
export function buildInviteEmail(input: InviteEmailInput): { subject: string; html: string } {
  const subject = `${input.inviterName} invited you to ${input.teamName} on aidoc`

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0c0c0e;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.04);">
          <tr>
            <td style="background:#0c0c0e;padding:20px 32px;color:#ffffff;font-weight:600;font-size:14px;letter-spacing:-0.01em;">
              aidoc
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:600;color:#0c0c0e;">You've been invited to ${escape(input.teamName)}</h1>
              <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52525b;">
                <strong style="color:#0c0c0e;">${escape(input.inviterName)}</strong> has invited you to collaborate on <strong style="color:#0c0c0e;">${escape(input.teamName)}</strong> in aidoc.
                Accept to start working together on their documentation.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                <tr>
                  <td style="border-radius:8px;background:#635BFF;">
                    <a href="${input.acceptUrl}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">Accept invitation</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#a1a1aa;">
                This invitation expires in 14 days. If the button doesn't work, paste this link in your browser:<br />
                <span style="color:#635BFF;word-break:break-all;">${input.acceptUrl}</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;border-top:1px solid #e4e4e7;font-size:11px;color:#a1a1aa;line-height:1.5;">
              You received this email because someone invited you to their aidoc team. If this wasn't expected, you can ignore this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  return { subject, html }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
