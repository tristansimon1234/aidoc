import { type ChangeEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../../../shared/layout/Shell.js'
import { Button, Field } from '../../../design-system/components/index.js'
import { api } from '../../../shared/api/client.js'
import styles from './NewRun.module.css'

export function NewRun(): React.ReactElement {
  const navigate = useNavigate()
  const [featureName, setFeatureName] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [goal, setGoal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    api.runs
      .create({ featureName, startUrl, goal })
      .then((run) => navigate(`/runs/${run.id}`))
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  return (
    <Shell>
      <div className={styles.container}>
        <h1 className={styles.title}>New Run</h1>

        <form className={styles.form} onSubmit={handleSubmit}>
          <Field
            label="feature_name"
            type="text"
            placeholder="e.g. Checkout Flow"
            value={featureName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFeatureName(e.target.value)}
            required
          />

          <Field
            label="start_url"
            type="url"
            placeholder="https://example.com/feature"
            value={startUrl}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setStartUrl(e.target.value)}
            required
          />

          <Field
            label="goal"
            multiline
            placeholder="Document the complete checkout flow including payment and confirmation"
            value={goal}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)}
            rows={4}
            required
          />

          {error && <p style={{ color: 'var(--color-accent-red)', fontSize: 'var(--text-sm)' }}>{error}</p>}

          <div className={styles.actions}>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Starting...' : 'Start Run'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => navigate('/')}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </Shell>
  )
}
