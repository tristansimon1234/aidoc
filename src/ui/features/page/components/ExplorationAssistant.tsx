import { type ChangeEvent, useState } from 'react'
import { Button, Field } from '../../../design-system/components/index.js'
import type { RunDTO } from '../../../shared/api/client.js'
import { api } from '../../../shared/api/client.js'

interface ExplorationAssistantProps {
  run: RunDTO
  onContinue: (context?: string) => Promise<void>
  onSkipAndGenerate: () => Promise<void>
  onReExplore: () => Promise<void>
}

export function ExplorationAssistant({
  run,
  onContinue,
  onSkipAndGenerate,
  onReExplore,
}: ExplorationAssistantProps): React.ReactElement {
  const [userResponse, setUserResponse] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const summary = run.summaryJson
  const hasBlockers = summary && summary.blockers.length > 0
  const isBlocked = run.status === 'blocked' || run.status === 'failed'

  const handleProvideAndContinue = async (): Promise<void> => {
    if (!userResponse.trim()) return
    setSubmitting(true)
    try {
      // Save the response as an answered question
      const questions = await api.runs.questions(run.id)
      const unanswered = questions.find((q) => !q.answer)
      if (unanswered) {
        await api.questions.answer(run.id, unanswered.id, userResponse)
      }
      // Continue with context
      await onContinue(userResponse)
    } finally {
      setSubmitting(false)
    }
  }

  // No summary — show simple status with re-explore button
  if (!summary) {
    return (
      <div style={{
        padding: 'var(--space-lg)',
        backgroundColor: 'var(--color-bg-surface)',
        border: `1px solid ${isBlocked ? 'var(--color-accent-amber)' : 'var(--color-accent-green)'}`,
        borderRadius: 'var(--radius-lg)',
        marginBottom: 'var(--space-lg)',
      }}>
        <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 600, margin: '0 0 var(--space-sm)', color: isBlocked ? 'var(--color-accent-amber)' : 'var(--color-accent-green)' }}>
          {run.status === 'completed' ? 'Exploration complete' : 'Exploration ended'}
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', margin: '0 0 var(--space-md)' }}>
          {run.status === 'completed' ? 'Documentation has been generated.' : 'The exploration stopped. You can re-explore to capture more.'}
        </p>
        <Button size="sm" variant="secondary" onClick={() => void onReExplore()}>Re-explore</Button>
      </div>
    )
  }

  return (
    <div style={{
      padding: 'var(--space-lg)',
      backgroundColor: 'var(--color-bg-surface)',
      border: `1px solid ${isBlocked ? 'var(--color-accent-amber)' : 'var(--color-accent-green)'}`,
      borderRadius: 'var(--radius-lg)',
      marginBottom: 'var(--space-lg)',
    }}>
      {/* Header */}
      <h3 style={{
        fontSize: 'var(--text-md)', fontWeight: 600, margin: '0 0 var(--space-md)',
        color: isBlocked ? 'var(--color-accent-amber)' : 'var(--color-accent-green)',
      }}>
        {isBlocked ? 'Exploration paused — action required' : 'Exploration complete'}
      </h3>

      {/* Sections explored */}
      <div style={{ marginBottom: 'var(--space-md)' }}>
        {summary.sections.map((section, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
            padding: 'var(--space-xs) 0',
          }}>
            <span style={{
              fontSize: 'var(--text-md)',
              color: section.status === 'documented' ? 'var(--color-accent-green)'
                : section.status === 'blocked' ? 'var(--color-accent-red)'
                : 'var(--color-accent-amber)',
            }}>
              {section.status === 'documented' ? '✓' : section.status === 'blocked' ? '✗' : '◐'}
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', textTransform: 'capitalize' }}>
              {section.label}
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              {section.stepCount} step{section.stepCount !== 1 ? 's' : ''}
            </span>
          </div>
        ))}
      </div>

      {/* Blockers */}
      {hasBlockers && (
        <div style={{
          padding: 'var(--space-md)',
          backgroundColor: 'var(--color-bg-elevated)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 'var(--space-md)',
        }}>
          <p style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--color-accent-amber)', margin: '0 0 var(--space-sm)' }}>
            To continue, I need:
          </p>
          {summary.blockers.map((blocker, i) => (
            <div key={i} style={{ marginBottom: 'var(--space-sm)' }}>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', margin: 0 }}>
                → {blocker.actionLabel}
              </p>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' }}>
                {blocker.description.length > 200 ? blocker.description.slice(0, 200) + '...' : blocker.description}
              </p>
            </div>
          ))}

          <div style={{ marginTop: 'var(--space-md)' }}>
            <Field
              label="your_response"
              multiline
              placeholder={summary.blockers[0]?.type === 'credentials'
                ? 'e.g. username: admin@test.com, password: test123'
                : 'Provide guidance or additional information...'}
              value={userResponse}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setUserResponse(e.target.value)}
              rows={2}
            />
            <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
              <Button
                size="sm"
                disabled={!userResponse.trim() || submitting}
                onClick={() => void handleProvideAndContinue()}
              >
                {submitting ? 'Continuing...' : 'Provide & Continue'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void onSkipAndGenerate()}>
                Skip & Generate Doc
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onReExplore()}>
                Start Fresh
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* No blockers — completed successfully */}
      {!hasBlockers && !isBlocked && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
          {summary.agentMessage || 'All sections explored successfully.'}
        </p>
      )}
    </div>
  )
}
