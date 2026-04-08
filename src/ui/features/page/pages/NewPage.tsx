import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { createPage } from '../../../shared/api/db.js'

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

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)',
  display: 'block', marginBottom: 4,
}

export function NewPage(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [goal, setGoal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTitleChange = (val: string): void => {
    setTitle(val)
    if (!slug || slug === toSlug(title)) {
      setSlug(toSlug(val))
    }
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!projectId) return
    setSubmitting(true)
    setError(null)

    createPage(projectId, {
        title,
        slug,
        startUrl: startUrl || undefined,
        goal: goal || undefined,
      })
      .then((page) => navigate(`/projects/${projectId}/pages/${page.id}`))
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>New Page</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-xl)' }}>
        Create a documentation page. The AI will explore the URL and generate content based on your goal.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={{
          padding: 'var(--space-md)', backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-lg)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-xl)',
          maxWidth: '560px',
        }}>

          {/* Step 1: Page identity */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              <span style={stepNumStyle}>1</span>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Page identity</span>
            </div>
            <p style={helpStyle}>The title appears in the sidebar and as the page heading. The slug is used in the URL.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
              <div>
                <label style={labelStyle}>Title</label>
                <input type="text" value={title} onChange={(e) => handleTitleChange(e.target.value)} required
                  placeholder="e.g. Getting Started" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Slug</label>
                <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} required
                  placeholder="e.g. getting-started" style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }} />
              </div>
            </div>
          </div>

          {/* Step 2: Where to explore */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              <span style={stepNumStyle}>2</span>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>Where to explore</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>optional</span>
            </div>
            <p style={helpStyle}>The URL where the AI agent starts exploring. Leave empty to use the project&apos;s base URL.</p>
            <input type="text" value={startUrl} onChange={(e) => setStartUrl(e.target.value)}
              placeholder="e.g. /pricing or https://myapp.com/settings"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }} />
          </div>

          {/* Step 3: Goal */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              <span style={stepNumStyle}>3</span>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-text-primary)' }}>What to document</span>
            </div>
            <p style={helpStyle}>
              Be specific — the agent uses this to decide what to explore. You can refine this later in the page&apos;s Exploration tab with a full briefing.
            </p>
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Document how a new user creates an account, verifies their email, and completes onboarding"
              rows={3} style={textareaStyle} />
          </div>
        </div>

        {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-md)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-lg)' }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Page'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => navigate(`/projects/${projectId}`)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
