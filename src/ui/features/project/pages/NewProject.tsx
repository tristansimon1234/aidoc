import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Spinner } from '../../../design-system/components/index.js'
import { createProject } from '../../../shared/api/db.js'
import { api } from '../../../shared/api/client.js'

interface Credential {
  label: string
  username: string
  password: string
}

export function NewProject(): React.ReactElement {
  const navigate = useNavigate()

  // Step 1 — product identity
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  // Analysis
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)

  // Step 2 — review & configure (auto-filled from analysis)
  const [description, setDescription] = useState('')
  const [audience, setAudience] = useState('')
  const [workflow, setWorkflow] = useState('')

  // Design (extracted from website)
  const [design, setDesign] = useState<{ accentColor: string; bgColor: string; textColor: string; font: string } | null>(null)

  // Test environment
  const [credentials, setCredentials] = useState<Credential[]>([])

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAnalyze = async (): Promise<void> => {
    if (!baseUrl) return
    setAnalyzing(true)
    setError(null)
    try {
      const result = await api.projects.analyzeUrl(baseUrl)
      if (result.name && !name) setName(result.name)
      if (result.description) setDescription(result.description)
      if (result.audience) setAudience(result.audience)
      if (result.workflow) setWorkflow(result.workflow)
      if (result.design) setDesign(result.design)
      setAnalyzed(true)
    } catch (err) {
      setError((err as Error).message)
      // Still show step 2 so user can fill manually
      setAnalyzed(true)
    } finally {
      setAnalyzing(false)
    }
  }

  const addCredential = (): void => {
    setCredentials([...credentials, { label: '', username: '', password: '' }])
  }

  const updateCredential = (index: number, field: keyof Credential, value: string): void => {
    setCredentials(credentials.map((c, i) => i === index ? { ...c, [field]: value } : c))
  }

  const removeCredential = (index: number): void => {
    setCredentials(credentials.filter((_, i) => i !== index))
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!name || !baseUrl) return
    setSubmitting(true)
    setError(null)

    const validCreds = credentials.filter((c) => c.label && c.username && c.password)
    const context = (audience || workflow) ? { audience, workflow, quirks: '' } : undefined

    createProject({
        name,
        baseUrl,
        description: description || undefined,
        context,
        credentials: validCreds.length > 0 ? validCreds : undefined,
      })
      .then(async (p) => {
        // Apply discovered design if available
        if (design) {
          const { updateProject } = await import('../../../shared/api/db.js')
          await updateProject(p.id, { design }).catch(() => { /* non-critical */ })
        }
        navigate(`/projects/${p.id}`)
      })
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <Shell>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>New Project</h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', margin: '0 0 var(--space-xl)' }}>
          Add your product URL and we&apos;ll analyze it to set up your documentation.
        </p>

        <form onSubmit={handleSubmit}>
          {/* Step 1 — Product identity */}
          <div style={{
            padding: 'var(--space-lg)', background: 'var(--color-card)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-md)',
          }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)' }}>
              Your product
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. My SaaS App"
                  style={{
                    width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-sm)',
                    color: 'var(--color-fg)', background: 'var(--color-secondary)',
                    border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                    fontFamily: 'var(--font-sans)', outline: 'none',
                  }} />
              </div>
              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>URL</label>
                <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://myapp.com"
                  style={{
                    width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-xs)',
                    color: 'var(--color-fg)', background: 'var(--color-secondary)',
                    border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                    fontFamily: 'var(--font-mono)', outline: 'none',
                  }} />
              </div>
            </div>

            {!analyzed && (
              <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                <Button type="button" disabled={!baseUrl || analyzing} onClick={() => void handleAnalyze()}>
                  {analyzing ? 'Analyzing...' : 'Analyze website'}
                </Button>
                {analyzing && <Spinner size="sm" />}
                <button type="button" onClick={() => setAnalyzed(true)} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', fontFamily: 'var(--font-sans)',
                }}>
                  Skip — I&apos;ll fill it myself
                </button>
              </div>
            )}
          </div>

          {/* Step 2 — Review & Test Environment (shown after analysis or skip) */}
          {analyzed && (
            <div style={{
              padding: 'var(--space-lg)', background: 'var(--color-card)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)',
              display: 'flex', flexDirection: 'column', gap: 'var(--space-md)',
              marginTop: 'var(--space-md)',
            }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)' }}>
                About your product
              </div>

              <div>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does your product do?"
                  rows={2}
                  style={{
                    width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-sm)',
                    color: 'var(--color-fg)', background: 'var(--color-secondary)',
                    border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                    fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
                  }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
                <div>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Target audience</label>
                  <textarea value={audience} onChange={(e) => setAudience(e.target.value)}
                    placeholder="Who uses this product?"
                    rows={2}
                    style={{
                      width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-sm)',
                      color: 'var(--color-fg)', background: 'var(--color-secondary)',
                      border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                      fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
                    }} />
                </div>
                <div>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Key workflow</label>
                  <textarea value={workflow} onChange={(e) => setWorkflow(e.target.value)}
                    placeholder="Most important user journey"
                    rows={2}
                    style={{
                      width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-sm)',
                      color: 'var(--color-fg)', background: 'var(--color-secondary)',
                      border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                      fontFamily: 'var(--font-sans)', outline: 'none', resize: 'vertical',
                    }} />
                </div>
              </div>

              {/* Design preview */}
              {design && (
                <div style={{
                  borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-md)',
                  marginTop: 'var(--space-xs)',
                }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)', marginBottom: 'var(--space-sm)' }}>
                    Detected brand
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                      <div style={{ width: 24, height: 24, borderRadius: 'var(--radius-sm)', background: design.accentColor, border: '1px solid var(--color-border)' }} />
                      <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)' }}>{design.accentColor}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                      <div style={{ width: 24, height: 24, borderRadius: 'var(--radius-sm)', background: design.bgColor, border: '1px solid var(--color-border)' }} />
                      <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)' }}>{design.bgColor}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                      <div style={{ width: 24, height: 24, borderRadius: 'var(--radius-sm)', background: design.textColor, border: '1px solid var(--color-border)' }} />
                      <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)' }}>{design.textColor}</span>
                    </div>
                    {design.font && (
                      <span style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted-fg)', background: 'var(--color-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                        {design.font}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Test environment */}
              <div style={{
                borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-md)',
                marginTop: 'var(--space-xs)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-fg)' }}>
                    Test credentials
                  </div>
                  <button type="button" onClick={addCredential} style={{
                    background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)',
                    fontFamily: 'var(--font-mono)', padding: '2px 8px',
                  }}>+ add</button>
                </div>
                <p style={{
                  fontSize: 'var(--text-xs)', color: 'var(--color-warning)',
                  margin: '0 0 var(--space-sm)', lineHeight: 1.4,
                  padding: '6px 10px', background: 'var(--color-status-blocked-bg)',
                  borderRadius: 'var(--radius-md)',
                }}>
                  Non-production environment only — never use real user data or production credentials.
                </p>
                {credentials.map((cred, i) => (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto',
                    gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)', alignItems: 'center',
                  }}>
                    <input type="text" value={cred.label} onChange={(e) => updateCredential(i, 'label', e.target.value)}
                      placeholder="e.g. admin"
                      style={{
                        width: '100%', padding: '8px var(--space-sm)', fontSize: 'var(--text-xs)',
                        color: 'var(--color-fg)', background: 'var(--color-secondary)',
                        border: '1px solid transparent', borderRadius: 'var(--radius-md)',
                        fontFamily: 'var(--font-sans)', outline: 'none',
                      }} />
                    <input type="text" value={cred.username} onChange={(e) => updateCredential(i, 'username', e.target.value)}
                      placeholder="user@example.com"
                      style={{
                        width: '100%', padding: '8px var(--space-sm)', fontSize: 'var(--text-xs)',
                        color: 'var(--color-fg)', background: 'var(--color-secondary)',
                        border: '1px solid transparent', borderRadius: 'var(--radius-md)',
                        fontFamily: 'var(--font-mono)', outline: 'none',
                      }} />
                    <input type="password" value={cred.password} onChange={(e) => updateCredential(i, 'password', e.target.value)}
                      placeholder="password"
                      style={{
                        width: '100%', padding: '8px var(--space-sm)', fontSize: 'var(--text-xs)',
                        color: 'var(--color-fg)', background: 'var(--color-secondary)',
                        border: '1px solid transparent', borderRadius: 'var(--radius-md)',
                        fontFamily: 'var(--font-mono)', outline: 'none',
                      }} />
                    <button type="button" onClick={() => removeCredential(i)} style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', padding: 4,
                    }}>x</button>
                  </div>
                ))}
                {credentials.length === 0 && (
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', fontStyle: 'italic', margin: 0 }}>
                    No credentials yet — add them here or later in Settings.
                  </p>
                )}
              </div>
            </div>
          )}

          {error && <p style={{ color: 'var(--color-destructive)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-md)' }}>{error}</p>}

          {analyzed && (
            <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-lg)' }}>
              <Button type="submit" disabled={submitting || !name || !baseUrl}>
                {submitting ? 'Creating...' : 'Create Project'}
              </Button>
              <Button variant="ghost" type="button" onClick={() => navigate('/')}>Cancel</Button>
            </div>
          )}
        </form>
      </div>
    </Shell>
  )
}
