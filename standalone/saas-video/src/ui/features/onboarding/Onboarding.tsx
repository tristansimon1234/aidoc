import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ColorPicker } from '../../design-system/components/index.js'
import { api, ApiError } from '../../shared/api/client.js'
import styles from './Onboarding.module.css'

/**
 * First-run brand setup. Dashboard hard-redirects here whenever the user
 * has no brands. Single-page form rather than a stepper — the fields are
 * concrete (name + 3 colors) so multi-step would feel padded. Once saved,
 * the user is sent to /dashboard which now has a brand to render videos
 * against.
 */
export function Onboarding(): React.ReactElement {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [accentColor, setAccentColor] = useState('#5B5BD6')
  const [bgColor, setBgColor] = useState('#0B0B0F')
  const [textColor, setTextColor] = useState('#F5F5F7')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.brands.create({
        name: name.trim(),
        websiteUrl: websiteUrl.trim() || null,
        accentColor,
        bgColor,
        textColor,
        // The first brand becomes the default automatically (handled in
        // the repository); no need to send isDefault here.
      })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Set up your brand</h1>
        <p className={styles.muted}>
          This drives the colors and look of every video you generate. You can change it later, or add
          more brands (one per product / client).
        </p>

        <form onSubmit={onSubmit} className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>Product name</span>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Linear, Vercel, your product"
              className={styles.input}
              autoFocus
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Website (optional)</span>
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://yourproduct.com"
              className={styles.input}
            />
          </label>

          <div className={styles.colorRow}>
            <div className={styles.colorField}>
              <span className={styles.label}>Accent</span>
              <ColorPicker value={accentColor} onChange={setAccentColor} />
            </div>
            <div className={styles.colorField}>
              <span className={styles.label}>Background</span>
              <ColorPicker value={bgColor} onChange={setBgColor} />
            </div>
            <div className={styles.colorField}>
              <span className={styles.label}>Text</span>
              <ColorPicker value={textColor} onChange={setTextColor} />
            </div>
          </div>

          <div className={styles.preview} style={{ background: bgColor, color: textColor }}>
            <span style={{ color: accentColor, fontWeight: 700 }}>{name || 'Your product'}</span>
            <span style={{ marginLeft: 8 }}>preview — these colors appear on every scene of your video.</span>
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
              {submitting ? 'Saving…' : 'Continue to dashboard'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
