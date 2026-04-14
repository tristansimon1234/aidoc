import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useOutletContext } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { type ProjectDTO, type DiscoveredContextDTO } from '../../../shared/api/client.js'
import { updateProject } from '../../../shared/api/db.js'
import styles from './ProjectSettings.module.css'

interface Credential { label: string; username: string; password: string }

type SettingsTab = 'general' | 'knowledge' | 'credentials'

export function ProjectSettings(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const { project: outletProject, setProject: setParentProject } = useOutletContext<{ project: ProjectDTO; setProject: (p: ProjectDTO) => void }>()
  const [project, setProject] = useState<ProjectDTO>(outletProject)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [name, setName] = useState(outletProject.name)
  const [baseUrl, setBaseUrl] = useState(outletProject.baseUrl)
  const [context, setContext] = useState(outletProject.context ?? { audience: '', workflow: '', quirks: '' })
  const [credentials, setCredentials] = useState<Credential[]>(
    (outletProject as ProjectDTO & { credentials?: Credential[] | null }).credentials ?? [],
  )
  const [walkthroughEnabled, setWalkthroughEnabled] = useState(outletProject.walkthroughEnabled ?? false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setProject(outletProject)
    setName(outletProject.name)
    setBaseUrl(outletProject.baseUrl)
    setContext(outletProject.context ?? { audience: '', workflow: '', quirks: '' })
    setCredentials((outletProject as ProjectDTO & { credentials?: Credential[] | null }).credentials ?? [])
    setWalkthroughEnabled(outletProject.walkthroughEnabled ?? false)
  }, [outletProject])

  const handleSave = async (): Promise<void> => {
    if (!projectId) return
    setSaving(true); setError(null); setSaved(false)
    try {
      const validCreds = credentials.filter((c) => c.label && c.username && c.password)
      const updated = await updateProject(projectId, {
        name, baseUrl,
        context: (context.audience || context.workflow || context.quirks) ? context : undefined,
        credentials: validCreds.length > 0 ? validCreds : undefined,
        walkthroughEnabled,
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
    { id: 'credentials', label: 'Credentials' },
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
                  <label className={styles.label}>URL</label>
                  <input className={styles.inputMono} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </div>
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
                <h2 className={styles.sectionTitle}>Test Credentials</h2>
                <p className={styles.sectionDesc}>Used by the AI agent to log in during auto-exploration.</p>
              </div>
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
              <div className={styles.saveBar}>
                <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {saved && <span className={`${styles.saveMsg} ${styles.success}`}>Saved</span>}
              </div>
            </div>
          )}

        </div>
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
