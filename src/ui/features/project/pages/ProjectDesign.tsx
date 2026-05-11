import { useState, useRef, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { type ProjectDTO, type ProjectDesignDTO } from '../../../shared/api/client.js'
import { updateProject } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import {
  ALL_FONTS,
  SYSTEM_FONTS,
  GOOGLE_FONTS,
  findByCssValue,
  googleFontStylesheetUrl,
  DEFAULT_FONT,
} from '../../../../shared/design/fonts.js'
import { normalizeHex } from '../../../../shared/design/colors.js'
import styles from './ProjectDesign.module.css'

const DEFAULTS: ProjectDesignDTO = {
  accentColor: '#635BFF',
  bgColor: '#0C0C0E',
  textColor: '#E5E5E5',
  font: DEFAULT_FONT.cssValue,
}

const COLOR_PRESETS = [
  { label: 'Indigo', value: '#635BFF' },
  { label: 'Blue', value: '#2563EB' },
  { label: 'Emerald', value: '#059669' },
  { label: 'Rose', value: '#E11D48' },
  { label: 'Amber', value: '#D97706' },
  { label: 'Violet', value: '#7C3AED' },
  { label: 'Slate', value: '#475569' },
  { label: 'Cyan', value: '#0891B2' },
]

const BG_PRESETS = [
  { label: 'Dark', value: '#0C0C0E' },
  { label: 'Charcoal', value: '#1A1A1E' },
  { label: 'Midnight', value: '#0F172A' },
  { label: 'Graphite', value: '#1C1C1F' },
  { label: 'White', value: '#FFFFFF' },
  { label: 'Light', value: '#F8FAFC' },
  { label: 'Warm', value: '#FFFBF5' },
  { label: 'Cool', value: '#F0F4F8' },
]

const TEXT_PRESETS = [
  { label: 'Light', value: '#E5E5E5' },
  { label: 'White', value: '#FFFFFF' },
  { label: 'Muted', value: '#A1A1AA' },
  { label: 'Dark', value: '#1A1A2E' },
  { label: 'Charcoal', value: '#374151' },
  { label: 'Ink', value: '#0A0A0A' },
]

/**
 * Inject a Google Fonts `<link>` for an allowlisted font name. The URL is
 * built by `googleFontStylesheetUrl` which (a) checks the name is in our
 * allowlist and (b) checks it against a strict regex before encoding it
 * into the path component of `https://fonts.googleapis.com/...`. If both
 * gates fail it returns null and we don't inject anything — silently
 * falling back to the CSS family's own fallback chain.
 */
function loadGoogleFont(fontName: string): void {
  const href = googleFontStylesheetUrl(fontName)
  if (!href) return
  const id = `gf-${fontName.replace(/\s+/g, '-').toLowerCase()}`
  if (document.getElementById(id)) return
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = href
  // crossorigin + referrerpolicy keep the load private + cache-friendly.
  link.crossOrigin = 'anonymous'
  link.referrerPolicy = 'no-referrer'
  document.head.appendChild(link)
}

export function ProjectDesign(): React.ReactElement {
  const { project, setProject } = useOutletContext<{ project: ProjectDTO; setProject: (p: ProjectDTO) => void }>()
  const existing = project.design ?? DEFAULTS

  const [design, setDesign] = useState<ProjectDesignDTO>(existing)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [fontQuery, setFontQuery] = useState('')

  // Resolve the currently-selected font from the allowlist. When the stored
  // value doesn't match (legacy data, AI auto-fill that dodged the
  // sanitizer, manual DB edit) we fall back to the System default for the
  // UI — the actual CSS value still renders via its own fallback chain.
  const selectedFont = useMemo(() => findByCssValue(design.font) ?? DEFAULT_FONT, [design.font])

  // Pre-load every Google Font in the picker once, so previews show the
  // real face instead of flashing the fallback. ~30 fonts at 5-20kB each
  // = ~300kB once cached; comparable to a single hero image and only paid
  // by users who actually open the Design tab. The loader is allowlist-
  // gated so this loop can't be tricked into fetching arbitrary URLs.
  useMemo(() => {
    GOOGLE_FONTS.forEach((f) => { if (f.googleName) loadGoogleFont(f.googleName) })
    // also load the currently-selected font (covers the legacy case above)
    if (selectedFont.googleName) loadGoogleFont(selectedFont.googleName)
  }, [selectedFont])

  // Filter for the picker search — case-insensitive substring on the label.
  const filteredFonts = useMemo(() => {
    const q = fontQuery.trim().toLowerCase()
    if (!q) return ALL_FONTS
    return ALL_FONTS.filter((f) => f.label.toLowerCase().includes(q))
  }, [fontQuery])

  const update = (partial: Partial<ProjectDesignDTO>): void => {
    setDesign((prev) => {
      // Force any color field to canonical #RRGGBB before it lands in
      // state — keeps the preview, the save payload, and the eventual
      // server-side validation all aligned.
      const cleaned: Partial<ProjectDesignDTO> = { ...partial }
      for (const key of ['accentColor', 'bgColor', 'textColor', 'accentSecondary'] as const) {
        const v = cleaned[key]
        if (typeof v === 'string') {
          const norm = normalizeHex(v)
          if (norm) cleaned[key] = norm
        }
      }
      const next = { ...prev, ...cleaned }
      if (partial.font) {
        const opt = findByCssValue(partial.font)
        if (opt?.googleName) loadGoogleFont(opt.googleName)
      }
      return next
    })
    setSaved(false)
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const updated = await updateProject(project.id, { design })
      setProject(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally { setSaving(false) }
  }

  const logoInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      // Logo upload sends the raw file as the body (not JSON), so it can't
      // go through the typed api client. Build the auth header manually so
      // verifyProjectOwnership on the server doesn't 401.
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      const res = await fetch(`/api/projects/${project.id}/logo`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: file,
      })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json() as { logoUrl: string | null }
      if (data.logoUrl) update({ logoUrl: data.logoUrl })
    } finally {
      setUploading(false)
      if (logoInputRef.current) logoInputRef.current.value = ''
    }
  }

  const handleLogoRemove = (): void => {
    update({ logoUrl: undefined })
  }

  const handleReset = (): void => {
    setDesign(DEFAULTS)
    setSaved(false)
  }

  const isDark = isColorDark(design.bgColor)

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Design</h1>
          <p className={styles.subtitle}>Customize the look of your widget and public docs.</p>
        </div>
      </div>

      <div className={styles.grid}>
        {/* Left — Controls */}
        <div className={styles.controls}>

          {/* Logo */}
          <div className={styles.section}>
            <label className={styles.label}>Logo</label>
            <p className={styles.hint}>Displayed in the public docs topbar</p>
            <div className={styles.logoRow}>
              {design.logoUrl && (
                <img src={design.logoUrl} alt="Logo" className={styles.logoPreview} />
              )}
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => void handleLogoUpload(e)}
                hidden
              />
              <Button size="sm" variant="ghost" onClick={() => logoInputRef.current?.click()} disabled={uploading}>
                {uploading ? 'Uploading...' : design.logoUrl ? 'Change' : 'Upload'}
              </Button>
              {design.logoUrl && (
                <Button size="sm" variant="ghost" onClick={handleLogoRemove}>Remove</Button>
              )}
            </div>
          </div>

          {/* Accent color */}
          <div className={styles.section}>
            <label className={styles.label}>Accent color</label>
            <p className={styles.hint}>Buttons, links, highlights</p>
            <div className={styles.swatchRow}>
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c.value}
                  className={`${styles.swatch} ${design.accentColor === c.value ? styles.swatchActive : ''}`}
                  style={{ background: c.value }}
                  onClick={() => update({ accentColor: c.value })}
                  title={c.label}
                />
              ))}
              <label className={styles.customColor}>
                <input type="color" value={design.accentColor} onChange={(e) => update({ accentColor: e.target.value })} className={styles.colorPicker} />
              </label>
            </div>
          </div>

          {/* Background */}
          <div className={styles.section}>
            <label className={styles.label}>Background</label>
            <p className={styles.hint}>Widget panel and doc page background</p>
            <div className={styles.swatchRow}>
              {BG_PRESETS.map((c) => (
                <button
                  key={c.value}
                  className={`${styles.swatch} ${design.bgColor === c.value ? styles.swatchActive : ''} ${c.value === '#FFFFFF' || c.value === '#F8FAFC' || c.value === '#FFFBF5' || c.value === '#F0F4F8' ? styles.swatchLight : ''}`}
                  style={{ background: c.value }}
                  onClick={() => update({ bgColor: c.value })}
                  title={c.label}
                />
              ))}
              <label className={styles.customColor}>
                <input type="color" value={design.bgColor} onChange={(e) => update({ bgColor: e.target.value })} className={styles.colorPicker} />
              </label>
            </div>
          </div>

          {/* Text color */}
          <div className={styles.section}>
            <label className={styles.label}>Text color</label>
            <p className={styles.hint}>Main text in widget and docs</p>
            <div className={styles.swatchRow}>
              {TEXT_PRESETS.map((c) => (
                <button
                  key={c.value}
                  className={`${styles.swatch} ${design.textColor === c.value ? styles.swatchActive : ''} ${c.value === '#E5E5E5' || c.value === '#FFFFFF' || c.value === '#A1A1AA' ? styles.swatchLight : ''}`}
                  style={{ background: c.value }}
                  onClick={() => update({ textColor: c.value })}
                  title={c.label}
                />
              ))}
              <label className={styles.customColor}>
                <input type="color" value={design.textColor} onChange={(e) => update({ textColor: e.target.value })} className={styles.colorPicker} />
              </label>
            </div>
          </div>

          {/* Font */}
          <div className={styles.section}>
            <label className={styles.label}>Font</label>
            <p className={styles.hint}>
              {SYSTEM_FONTS.length} system + {GOOGLE_FONTS.length} Google Fonts. Search to filter.
            </p>
            <input
              type="search"
              placeholder="Search fonts…"
              value={fontQuery}
              onChange={(e) => setFontQuery(e.target.value)}
              className={styles.fontSearch}
            />
            <div className={styles.fontGrid}>
              {filteredFonts.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.fontOption} ${design.font === f.cssValue ? styles.fontOptionActive : ''}`}
                  style={{ fontFamily: f.cssValue }}
                  onClick={() => update({ font: f.cssValue })}
                  title={`${f.label} · ${f.category}`}
                >
                  {f.label}
                </button>
              ))}
              {filteredFonts.length === 0 && (
                <p className={styles.hint} style={{ gridColumn: '1 / -1' }}>
                  No font matches "{fontQuery}". Try fewer characters, or open an issue if it's a Google Font we should add.
                </p>
              )}
            </div>
          </div>

          {/* Secondary accent (marketing video brand-kit) */}
          <div className={styles.section}>
            <label className={styles.label}>Secondary accent</label>
            <p className={styles.hint}>Two-tone gradients in marketing videos. Optional — falls back to a darker shade of the main accent.</p>
            <div className={styles.swatchRow}>
              <label className={styles.customColor}>
                <input
                  type="color"
                  value={design.accentSecondary ?? design.accentColor}
                  onChange={(e) => update({ accentSecondary: e.target.value })}
                  className={styles.colorPicker}
                />
              </label>
              {design.accentSecondary && (
                <Button size="sm" variant="ghost" onClick={() => update({ accentSecondary: undefined })}>Clear</Button>
              )}
            </div>
          </div>

          {/* Corner radius (marketing video brand-kit) */}
          <div className={styles.section}>
            <label className={styles.label}>Corner radius</label>
            <p className={styles.hint}>Marketing-video primitives + Cta button. {design.radius ?? 14}px</p>
            <input
              type="range"
              min={0}
              max={32}
              step={1}
              value={design.radius ?? 14}
              onChange={(e) => update({ radius: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          {/* Actions */}
          <div className={styles.actions}>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving...' : 'Save Design'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleReset}>Reset to defaults</Button>
            {saved && <span className={styles.savedMsg}>Saved</span>}
          </div>
        </div>

        {/* Right — Preview */}
        <div className={styles.previewWrapper}>
          <span className={styles.previewLabel}>Preview</span>
          <div className={styles.preview} style={{ background: '#E8ECF0' }}>
            {/* Mini widget preview */}
            <div className={styles.previewPanel} style={{ background: design.bgColor, fontFamily: design.font }}>
              <div className={styles.previewHeader} style={{ borderColor: isDark ? '#2a2a2e' : '#e5e7eb' }}>
                <span style={{ color: design.textColor, fontSize: 11, fontWeight: 600 }}>Ask about the docs</span>
                <span style={{ color: isDark ? '#666' : '#999', fontSize: 14 }}>&times;</span>
              </div>
              <div className={styles.previewBody}>
                <p style={{ color: design.textColor, fontSize: 10, fontWeight: 600, margin: '0 0 4px', textAlign: 'center' }}>
                  Hi! Ask me anything.
                </p>
                <p style={{ color: isDark ? '#888' : '#999', fontSize: 8, textAlign: 'center', margin: '0 0 8px' }}>
                  I can help you with {project.name}
                </p>
                <div className={styles.previewSuggestions}>
                  <div className={styles.previewSuggestion} style={{ borderColor: isDark ? '#2a2a2e' : '#e5e7eb', color: isDark ? '#aaa' : '#666', background: isDark ? '#141416' : '#f3f4f6' }}>
                    How does it work?
                  </div>
                  <div className={styles.previewSuggestion} style={{ borderColor: isDark ? '#2a2a2e' : '#e5e7eb', color: isDark ? '#aaa' : '#666', background: isDark ? '#141416' : '#f3f4f6' }}>
                    Getting started guide
                  </div>
                </div>
              </div>
              <div className={styles.previewInput} style={{ borderColor: isDark ? '#2a2a2e' : '#e5e7eb', background: isDark ? '#111113' : '#f9fafb' }}>
                <div className={styles.previewInputField} style={{ background: isDark ? '#1C1C1F' : '#fff', borderColor: isDark ? '#2a2a2e' : '#e5e7eb' }}>Ask a question...</div>
                <div className={styles.previewSendBtn} style={{ background: design.accentColor }}>Send</div>
              </div>
            </div>
            <div className={styles.previewBtn} style={{ background: design.accentColor }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function isColorDark(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}
