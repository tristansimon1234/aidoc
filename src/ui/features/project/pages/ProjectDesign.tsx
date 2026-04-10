import { useState, useRef } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { type ProjectDTO, type ProjectDesignDTO } from '../../../shared/api/client.js'
import { updateProject } from '../../../shared/api/db.js'
import { supabase } from '../../../shared/api/supabase.js'
import styles from './ProjectDesign.module.css'

const DEFAULTS: ProjectDesignDTO = {
  accentColor: '#635BFF',
  bgColor: '#0C0C0E',
  textColor: '#E5E5E5',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
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

const FONT_OPTIONS = [
  { label: 'System', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', preview: 'System UI' },
  { label: 'Inter', value: '"Inter", sans-serif', preview: 'Inter' },
  { label: 'DM Sans', value: '"DM Sans", sans-serif', preview: 'DM Sans' },
  { label: 'Geist', value: '"Geist", sans-serif', preview: 'Geist' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif', preview: 'Serif' },
  { label: 'Mono', value: '"JetBrains Mono", "Fira Code", monospace', preview: 'Monospace' },
]

export function ProjectDesign(): React.ReactElement {
  const { project, setProject } = useOutletContext<{ project: ProjectDTO; setProject: (p: ProjectDTO) => void }>()
  const existing = project.design ?? DEFAULTS

  const [design, setDesign] = useState<ProjectDesignDTO>(existing)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const update = (partial: Partial<ProjectDesignDTO>): void => {
    setDesign((prev) => ({ ...prev, ...partial }))
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
      const path = `projects/${project.id}/logo`
      await supabase.storage.from('artifacts').upload(path, file, { upsert: true, contentType: file.type })
      const { data: urlData } = supabase.storage.from('artifacts').getPublicUrl(path)
      update({ logoUrl: urlData.publicUrl })
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
            <p className={styles.hint}>Typography for widget and doc content</p>
            <div className={styles.fontGrid}>
              {FONT_OPTIONS.map((f) => (
                <button
                  key={f.label}
                  className={`${styles.fontOption} ${design.font === f.value ? styles.fontOptionActive : ''}`}
                  style={{ fontFamily: f.value }}
                  onClick={() => update({ font: f.value })}
                >
                  {f.preview}
                </button>
              ))}
            </div>
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
