import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button } from '../../../design-system/components/index.js'
import { createProject } from '../../../shared/api/db.js'

interface Credential {
  label: string
  username: string
  password: string
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: 'var(--space-sm)',
  fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)',
  background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)', fontFamily: 'var(--font-sans)', outline: 'none',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle, resize: 'vertical' as const, minHeight: '60px',
}

const stepNumStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
  backgroundColor: 'var(--color-accent-blue)', color: 'white',
  fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)',
}

const helpStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
  margin: '0 0 var(--space-sm)', lineHeight: 1.4,
}

export function NewProject(): React.ReactElement {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [context, setContext] = useState({ audience: '', workflow: '', quirks: '' })
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    setSubmitting(true)
    setError(null)

    const validCreds = credentials.filter((c) => c.label && c.username && c.password)

    createProject({
        name,
        baseUrl,
        context: (context.audience || context.workflow || context.quirks) ? context : undefined,
        credentials: validCreds.length > 0 ? validCreds : undefined,
      })
      .then((p) => navigate(`/projects/${p.id}`))
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <Shell>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>New Project</h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-xl)' }}>
          Set up your product so the AI knows what to explore and who the documentation is for.
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{
            padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-xl)',
          }}>

            {/* Step 1: Product */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                <span style={stepNumStyle}>1</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Your product</span>
              </div>
              <p style={helpStyle}>Name and URL of the web application the AI will explore.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
                <div>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                    placeholder="e.g. My SaaS App" style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>URL</label>
                  <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required
                    placeholder="https://myapp.com" style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }} />
                </div>
              </div>
            </div>

            {/* Step 2: Audience */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                <span style={stepNumStyle}>2</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Who is this for?</span>
              </div>
              <p style={helpStyle}>The AI writes documentation adapted to this audience. Be specific about their role and what they need to accomplish.</p>
              <textarea value={context.audience} onChange={(e) => setContext({ ...context, audience: e.target.value })}
                placeholder="e.g. SaaS product managers who need to track feature adoption and report to stakeholders"
                rows={2} style={textareaStyle} />
            </div>

            {/* Step 3: Workflow */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                <span style={stepNumStyle}>3</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Key workflow</span>
              </div>
              <p style={helpStyle}>The most important user journey. The AI prioritizes exploring and documenting this flow.</p>
              <textarea value={context.workflow} onChange={(e) => setContext({ ...context, workflow: e.target.value })}
                placeholder="e.g. User creates a project, adds team members, sets up integrations, runs first report"
                rows={2} style={textareaStyle} />
            </div>

            {/* Step 4: Quirks */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
                <span style={stepNumStyle}>4</span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Non-obvious behaviors</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>optional</span>
              </div>
              <p style={helpStyle}>Terms, hidden features, or domain-specific knowledge the AI can&apos;t guess from the UI.</p>
              <textarea value={context.quirks} onChange={(e) => setContext({ ...context, quirks: e.target.value })}
                placeholder="e.g. 'Workspace' means a team account. The 'Archive' button is hidden until 5+ items exist."
                rows={2} style={textareaStyle} />
            </div>

            {/* Step 5: Credentials */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
                  <span style={stepNumStyle}>5</span>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Test credentials</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>optional</span>
                </div>
                <button type="button" onClick={addCredential} style={{
                  background: 'none', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)',
                  padding: '2px 8px',
                }}>+ add</button>
              </div>
              <p style={helpStyle}>The AI uses these to log in during exploration. You can also add them later in Settings.</p>
              {credentials.map((cred, i) => (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto',
                  gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)', alignItems: 'center',
                }}>
                  <input type="text" value={cred.label} onChange={(e) => updateCredential(i, 'label', e.target.value)}
                    placeholder="e.g. admin" style={{ ...inputStyle, fontSize: 'var(--text-xs)' }} />
                  <input type="text" value={cred.username} onChange={(e) => updateCredential(i, 'username', e.target.value)}
                    placeholder="user@example.com" style={{ ...inputStyle, fontSize: 'var(--text-xs)' }} />
                  <input type="password" value={cred.password} onChange={(e) => updateCredential(i, 'password', e.target.value)}
                    placeholder="••••••••" style={{ ...inputStyle, fontSize: 'var(--text-xs)' }} />
                  <button type="button" onClick={() => removeCredential(i)} style={{
                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
                  }}>x</button>
                </div>
              ))}
              {credentials.length === 0 && (
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontStyle: 'italic', margin: 0 }}>No credentials added</p>
              )}
            </div>
          </div>

          {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-md)' }}>{error}</p>}

          <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-lg)' }}>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Project'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => navigate('/')}>Cancel</Button>
          </div>
        </form>
      </div>
    </Shell>
  )
}
