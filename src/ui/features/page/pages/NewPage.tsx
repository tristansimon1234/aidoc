import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '../../../design-system/components/index.js'
import { createPage } from '../../../shared/api/db.js'

export function NewPage(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTitleChange = (val: string): void => {
    setTitle(val)
    if (!slug || slug === toSlug(title)) {
      setSlug(toSlug(val))
    }
  }

  const handleCreate = (mode: 'record' | 'manual'): void => {
    if (!projectId || !title || !slug) return
    setSubmitting(true)
    setError(null)

    createPage(projectId, { title, slug })
      .then((page) => {
        if (mode === 'record') {
          navigate(`/projects/${projectId}/pages/${page.id}?tab=exploration`)
        } else {
          navigate(`/projects/${projectId}/pages/${page.id}`)
        }
      })
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>New Page</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted-fg)', margin: '0 0 var(--space-lg)' }}>
        Create a documentation page. You can configure the AI briefing later in the Generate tab.
      </p>

      <form onSubmit={(e) => e.preventDefault()}>
        <div style={{
          padding: 'var(--space-lg)', background: 'var(--color-card)',
          border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)',
          maxWidth: '480px',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
            <div>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Title</label>
              <input type="text" value={title} onChange={(e) => handleTitleChange(e.target.value)} required
                placeholder="e.g. Getting Started"
                style={{
                  width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-sm)',
                  color: 'var(--color-fg)', background: 'var(--color-secondary)',
                  border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                  fontFamily: 'var(--font-sans)', outline: 'none',
                }} />
            </div>
            <div>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-muted-fg)', display: 'block', marginBottom: 4 }}>Slug</label>
              <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} required
                placeholder="e.g. getting-started"
                style={{
                  width: '100%', padding: '10px var(--space-md)', fontSize: 'var(--text-xs)',
                  color: 'var(--color-fg)', background: 'var(--color-secondary)',
                  border: '1px solid transparent', borderRadius: 'var(--radius-lg)',
                  fontFamily: 'var(--font-mono)', outline: 'none',
                }} />
            </div>
          </div>
        </div>

        {error && <p style={{ color: 'var(--color-destructive)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-md)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-lg)', alignItems: 'center' }}>
          <Button disabled={submitting || !title || !slug} onClick={() => handleCreate('record')}>
            Create & Record
          </Button>
          <Button variant="secondary" type="button" disabled={submitting || !title || !slug} onClick={() => handleCreate('manual')}>
            Create
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
