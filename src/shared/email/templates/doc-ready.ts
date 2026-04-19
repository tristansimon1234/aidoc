interface DocReadyEmailInput {
  teamName: string
  triggeredByName: string
  projectName: string
  pageTitle: string
  reviewUrl: string
}

/**
 * HTML for the "a new doc was generated" notification. Sent to every team
 * member except the one who triggered the generation, so reviewers get a
 * ping without the author spamming themselves.
 */
export function buildDocReadyEmail(input: DocReadyEmailInput): { subject: string; html: string } {
  const subject = `New doc ready: ${input.pageTitle} — ${input.projectName}`

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
              doclee
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:600;color:#0c0c0e;">A new doc is ready to review</h1>
              <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#52525b;">
                <strong style="color:#0c0c0e;">${escape(input.triggeredByName)}</strong> generated <strong style="color:#0c0c0e;">${escape(input.pageTitle)}</strong> in <strong style="color:#0c0c0e;">${escape(input.projectName)}</strong> (${escape(input.teamName)}).
              </p>
              <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52525b;">
                Take a minute to review the doc, tweak the voice-over, or publish it.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                <tr>
                  <td style="border-radius:8px;background:#635BFF;">
                    <a href="${input.reviewUrl}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">Review the doc</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#a1a1aa;">
                Don't want these emails? You can adjust notification preferences from your account settings (coming soon).
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;border-top:1px solid #e4e4e7;font-size:11px;color:#a1a1aa;line-height:1.5;">
              You received this because you're a member of ${escape(input.teamName)}.
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
