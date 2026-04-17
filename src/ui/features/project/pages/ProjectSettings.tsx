import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useOutletContext } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { api, type ProjectDTO, type DiscoveredContextDTO } from '../../../shared/api/client.js'
import { updateProject } from '../../../shared/api/db.js'
import styles from './ProjectSettings.module.css'

import { supabase } from '../../../shared/api/supabase.js'

interface Credential { label: string; username: string; password: string }
interface Resource { type: 'url' | 'file' | 'note'; label: string; value: string }

const RESOURCE_FILE_EXTENSIONS = [
  '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.xml',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp4', '.webm', '.mov',
  '.xlsx', '.xls',
  '.pptx', '.ppt',
  '.docx', '.doc',
]
const RESOURCE_MAX_FILE_SIZE = 50 * 1024 * 1024

type SettingsTab = 'general' | 'knowledge' | 'credentials' | 'usage'

export function ProjectSettings(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const { project: outletProject, setProject: setParentProject } = useOutletContext<{ project: ProjectDTO; setProject: (p: ProjectDTO) => void }>()
  const [project, setProject] = useState<ProjectDTO>(outletProject)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [name, setName] = useState(outletProject.name)
  const [description, setDescription] = useState(outletProject.description ?? '')
  const [baseUrl, setBaseUrl] = useState(outletProject.baseUrl)
  const [context, setContext] = useState(outletProject.context ?? { audience: '', workflow: '', quirks: '' })
  const [credentials, setCredentials] = useState<Credential[]>(
    outletProject.credentials ?? [],
  )
  const [resources, setResources] = useState<Resource[]>(
    outletProject.resources ?? [],
  )
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [walkthroughEnabled, setWalkthroughEnabled] = useState(outletProject.walkthroughEnabled ?? false)
  const [language, setLanguage] = useState(outletProject.language ?? 'en')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setProject(outletProject)
    setName(outletProject.name)
    setDescription(outletProject.description ?? '')
    setBaseUrl(outletProject.baseUrl)
    setContext(outletProject.context ?? { audience: '', workflow: '', quirks: '' })
    setCredentials(outletProject.credentials ?? [])
    setResources(outletProject.resources ?? [])
    setWalkthroughEnabled(outletProject.walkthroughEnabled ?? false)
    setLanguage(outletProject.language ?? 'en')
  }, [outletProject])

  const handleSave = async (): Promise<void> => {
    if (!projectId) return
    setSaving(true); setError(null); setSaved(false)
    try {
      const validCreds = credentials.filter((c) => c.label && c.username && c.password)
      const validResources = resources.filter((r) => r.label && r.value)
      const updated = await updateProject(projectId, {
        name, baseUrl, description: description || undefined,
        context: (context.audience || context.workflow || context.quirks) ? context : undefined,
        credentials: validCreds.length > 0 ? validCreds : undefined,
        resources: validResources,
        walkthroughEnabled,
        language,
      })
      setProject(updated)
      setParentProject(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) { setError((err as Error).message) }
    finally { setSaving(false) }
  }

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'credentials', label: 'Test Environment' },
    { id: 'usage', label: 'Usage' },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
      </div>

        <div className={styles.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          {activeTab === 'general' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>General</h2>
                <p className={styles.sectionDesc}>Basic project information.</p>
              </div>
              <div className={styles.fieldGrid}>
                <div className={styles.field}>
                  <label className={styles.label}>Project name</label>
                  <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Website URL</label>
                  <input className={styles.inputMono} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://yourproduct.com" />
                  <p className={styles.sectionDesc} style={{ marginTop: 4 }}>Your production website. Used for analysis and public docs branding.</p>
                </div>
              </div>
              <div className={`${styles.field} ${styles.fieldFull}`} style={{ marginTop: 'var(--space-sm)' }}>
                <label className={styles.label}>Description</label>
                <textarea className={styles.textarea} value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does your product do?" rows={2} />
              </div>
              <div className={styles.field} style={{ marginTop: 'var(--space-md)' }}>
                <label className={styles.label}>Language</label>
                <select className={styles.input} value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="en">English</option>
                  <option value="fr">Français</option>
                </select>
                <p className={styles.sectionDesc} style={{ marginTop: 4 }}>
                  Language for generated documentation, voice-over, and the embedded widget's chat answers.
                </p>
              </div>
              <div className={styles.field} style={{ marginTop: 'var(--space-md)' }}>
                <label className={styles.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={walkthroughEnabled} onChange={(e) => setWalkthroughEnabled(e.target.checked)} />
                  Enable interactive walkthrough in widget
                </label>
                <p className={styles.sectionDesc} style={{ marginTop: '4px' }}>
                  When enabled, the widget can guide users step-by-step through your app by highlighting UI elements. The AI reads interactive elements on the page (buttons, links, form fields) to provide visual guidance.
                </p>
              </div>
              <div className={styles.saveBar}>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
                {error && <span className={`${styles.saveMsg} ${styles.error}`}>{error}</span>}
              </div>
            </div>
          )}

          {activeTab === 'knowledge' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              {/* Your context — manual */}
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>Your context</h2>
                  <p className={styles.sectionDesc}>Help the AI understand your product. Better context = better documentation and chat.</p>
                </div>
                {description && (
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', margin: '0 0 var(--space-md)', lineHeight: 1.5, fontStyle: 'italic' }}>
                    {description}
                  </p>
                )}
                <div className={styles.fieldGrid}>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label className={styles.label}>Target audience</label>
                    <textarea className={styles.textarea} value={context.audience}
                      onChange={(e) => setContext({ ...context, audience: e.target.value })}
                      placeholder="e.g. SaaS product managers who need to track feature adoption" rows={2} />
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label className={styles.label}>Key workflow</label>
                    <textarea className={styles.textarea} value={context.workflow}
                      onChange={(e) => setContext({ ...context, workflow: e.target.value })}
                      placeholder="e.g. User creates a project, adds team members, runs first report" rows={2} />
                  </div>
                  <div className={`${styles.field} ${styles.fieldFull}`}>
                    <label className={styles.label}>Domain knowledge</label>
                    <textarea className={styles.textarea} value={context.quirks}
                      onChange={(e) => setContext({ ...context, quirks: e.target.value })}
                      placeholder="e.g. 'Workspace' means a team account. Archive is hidden until 5+ items." rows={2} />
                  </div>
                </div>
                <div className={styles.saveBar}>
                  <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                  {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
                </div>
              </div>

              {/* Discovered — auto-generated */}
              <KnowledgeTab context={project.discoveredContext} projectId={projectId!}
                onSaved={(updated) => { setProject({ ...project, discoveredContext: updated }); setParentProject({ ...project, discoveredContext: updated }) }} />
            </div>
          )}

          {activeTab === 'credentials' && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Test Environment</h2>
                <p className={styles.sectionDesc}>The AI agent uses this URL and credentials to explore your product.</p>
              </div>
              <div className={styles.field} style={{ marginBottom: 'var(--space-md)' }}>
                <label className={styles.label}>Test / staging URL</label>
                <input className={styles.inputMono} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://staging.myapp.com" />
                <p className={styles.sectionDesc} style={{ marginTop: 4, color: 'var(--color-warning)' }}>
                  Non-production only — the AI will interact with this URL.
                </p>
              </div>
              <label className={styles.label}>Credentials</label>
              {credentials.map((cred, i) => (
                <div key={i} className={styles.credRow}>
                  <input className={styles.credInput} value={cred.label}
                    onChange={(e) => setCredentials(credentials.map((c, j) => j === i ? { ...c, label: e.target.value } : c))}
                    placeholder="Label" />
                  <input className={styles.credInput} value={cred.username}
                    onChange={(e) => setCredentials(credentials.map((c, j) => j === i ? { ...c, username: e.target.value } : c))}
                    placeholder="Email" />
                  <input className={styles.credInput} type="password" value={cred.password}
                    onChange={(e) => setCredentials(credentials.map((c, j) => j === i ? { ...c, password: e.target.value } : c))}
                    placeholder="Password" />
                  <button className={styles.removeBtn} onClick={() => setCredentials(credentials.filter((_, j) => j !== i))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                  </button>
                </div>
              ))}
              <button className={styles.addBtn} onClick={() => setCredentials([...credentials, { label: '', username: '', password: '' }])}>
                + Add credential
              </button>

              <label className={styles.label} style={{ marginTop: 'var(--space-lg)' }}>Test Resources</label>
              <p className={styles.sectionDesc} style={{ marginBottom: 'var(--space-sm)' }}>
                Files, URLs, or notes available to the AI agent during all tests across pages.
              </p>
              {uploadError && <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-destructive)', margin: '0 0 var(--space-sm)' }}>{uploadError}</p>}
              {resources.map((r, i) => (
                <div key={i} className={styles.credRow}>
                  <div className={styles.typeToggle}>
                    {(['url', 'file', 'note'] as const).map((t) => (
                      <button key={t} type="button"
                        className={`${styles.typeBtn} ${r.type === t ? styles.typeBtnActive : ''}`}
                        onClick={() => setResources((prev) => prev.map((res, j) => j === i ? { ...res, type: t } : res))}
                      >{t === 'url' ? 'URL' : t === 'file' ? 'File' : 'Note'}</button>
                    ))}
                  </div>
                  <input className={styles.credInput} value={r.label}
                    onChange={(e) => {
                      const val = e.target.value
                      setResources((prev) => prev.map((res, j) => j === i ? { ...res, label: val } : res))
                    }}
                    placeholder="Label" />
                  {r.type === 'file' ? (
                    r.value ? (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.value.split('/').pop()}
                      </span>
                    ) : (
                      <input type="file" accept={RESOURCE_FILE_EXTENSIONS.join(',')}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          setUploadError(null)
                          const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
                          if (!RESOURCE_FILE_EXTENSIONS.includes(ext)) { setUploadError(`Unsupported type. Accepted: ${RESOURCE_FILE_EXTENSIONS.join(', ')}`); return }
                          if (file.size > RESOURCE_MAX_FILE_SIZE) { setUploadError('File too large (max 50MB)'); return }
                          const path = `projects/${projectId}/resources/${file.name}`
                          void supabase.storage.from('briefing-files').upload(path, file, { upsert: true }).then(({ error: uploadErr }) => {
                            if (uploadErr) { setUploadError(`Upload failed: ${uploadErr.message}`); return }
                            setResources((prev) => prev.map((res, j) => j === i ? { ...res, value: path, label: res.label || file.name } : res))
                          })
                        }}
                        style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }} />
                    )
                  ) : (
                    <input className={styles.credInput} value={r.value}
                      onChange={(e) => {
                        const val = e.target.value
                        setResources((prev) => prev.map((res, j) => j === i ? { ...res, value: val } : res))
                      }}
                      placeholder={r.type === 'url' ? 'https://...' : 'info...'} style={{ fontFamily: r.type === 'url' ? 'var(--font-mono)' : 'var(--font-sans)' }} />
                  )}
                  <button className={styles.removeBtn} onClick={() => setResources((prev) => prev.filter((_, j) => j !== i))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                  </button>
                </div>
              ))}
              <button className={styles.addBtn} onClick={() => setResources([...resources, { type: 'note', label: '', value: '' }])}>
                + Add resource
              </button>

              <div className={styles.saveBar}>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
              </div>
            </div>
          )}

          {activeTab === 'usage' && (
            <UsageTab projectId={projectId!} />
          )}

        </div>
    </div>
  )
}

// --- Usage Tab ---

function UsageTab({ projectId }: { projectId: string }): React.ReactElement {
  const [usage, setUsage] = useState<{ totalTokens: number; runs: number; estimatedCost: number; breakdown: { label: string; tokens: number; runs: number; cost: number }[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.projects.usage(projectId)
        setUsage(data)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    })()
  }, [projectId])

  if (loading) return <div style={{ padding: 'var(--space-lg)', textAlign: 'center', color: 'var(--color-muted-fg)', fontSize: 'var(--text-sm)' }}>Loading usage data...</div>
  if (!usage) return <div style={{ padding: 'var(--space-lg)', textAlign: 'center', color: 'var(--color-muted-fg)', fontSize: 'var(--text-sm)' }}>Failed to load usage data</div>

  const fmtTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>AI Usage</h2>
        <p className={styles.sectionDesc}>Token consumption and estimated costs for this project.</p>
      </div>

      <div className={styles.statRow}>
        <span className={styles.stat}>{fmtTokens(usage.totalTokens)} tokens</span>
        <span className={styles.stat}>{usage.runs} runs</span>
        <span className={styles.stat}>~${usage.estimatedCost.toFixed(2)} estimated</span>
      </div>

      {usage.breakdown.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-md)' }}>
          {usage.breakdown.map((b) => (
            <div key={b.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--color-bg)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)' }}>
              <div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-fg)' }}>{b.label}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)' }}>{b.runs} runs · {fmtTokens(b.tokens)} tokens</div>
              </div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-fg)' }}>
                ${b.cost.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', marginTop: 'var(--space-md)', lineHeight: 1.6 }}>
        Costs are estimates based on Gemini 2.5 Flash (~$0.35/1M tokens) and Claude Sonnet (~$9/1M tokens). Actual costs may vary. Voice-over (ElevenLabs) costs are not included.
      </p>
    </div>
  )
}

// --- Knowledge Tab ---

function KnowledgeTab({ context, projectId, onSaved }: {
  context: DiscoveredContextDTO | null; projectId: string; onSaved: (ctx: DiscoveredContextDTO) => void
}): React.ReactElement {
  const [summary, setSummary] = useState(context?.summary ?? '')
  const [terminology, setTerminology] = useState<[string, string][]>(
    context?.terminology ? Object.entries(context.terminology) as [string, string][] : [],
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!context) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Discovered by AI</h2>
          <p className={styles.sectionDesc}>
            Auto-generated as the AI explores and generates documentation. Generate docs for any page to get started.
          </p>
        </div>
      </div>
    )
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true); setSaved(false)
    try {
      const updated: DiscoveredContextDTO = {
        ...context, summary,
        terminology: Object.fromEntries(terminology.filter(([k]) => k.trim())),
      }
      await updateProject(projectId, { discoveredContext: updated })
      onSaved(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally { setSaving(false) }
  }

  const ago = context.lastUpdated ? formatTimeAgo(context.lastUpdated) : ''

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Discovered by AI</h2>
        <p className={styles.sectionDesc}>Auto-generated as the AI generates documentation. You can edit to correct mistakes.</p>
      </div>

      <div className={styles.statRow}>
        <span className={styles.stat}>{context.features?.length ?? 0} features</span>
        <span className={styles.stat}>{context.siteStructure?.length ?? 0} pages</span>
        <span className={styles.stat}>{Object.keys(context.terminology ?? {}).length} terms</span>
        {ago && <span className={styles.stat}>updated {ago}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div className={styles.field}>
          <p className={styles.subLabel}>Summary</p>
          <textarea className={styles.textarea} value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p className={styles.subLabel}>Terminology</p>
            <button className={styles.addBtn} style={{ width: 'auto', padding: '2px 8px' }}
              onClick={() => setTerminology([...terminology, ['', '']])}>+ add</button>
          </div>
          {terminology.map(([term, def], i) => (
            <div key={i} className={styles.termRow}>
              <input className={styles.credInput} style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}
                value={term} onChange={(e) => setTerminology(terminology.map((t, j) => j === i ? [e.target.value, t[1]] : t))}
                placeholder="term" />
              <input className={styles.credInput} value={def}
                onChange={(e) => setTerminology(terminology.map((t, j) => j === i ? [t[0], e.target.value] : t))}
                placeholder="definition" />
              <button className={styles.removeBtn} onClick={() => setTerminology(terminology.filter((_, j) => j !== i))}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>
          ))}
        </div>

        {(context.features?.length ?? 0) > 0 && (
          <div>
            <p className={styles.subLabel}>Features</p>
            <div className={styles.tagList}>
              {context.features.map((f, i) => <span key={i} className={styles.stat}>{f}</span>)}
            </div>
          </div>
        )}

        {(context.siteStructure?.length ?? 0) > 0 && (
          <div>
            <p className={styles.subLabel}>Site structure</p>
            <div className={styles.urlList}>
              {context.siteStructure.map((url, i) => <span key={i}>{url}</span>)}
            </div>
          </div>
        )}

        <div className={styles.saveBar}>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving...' : 'Save Knowledge'}
          </Button>
          {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
        </div>
      </div>
    </div>
  )
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
