import React, { useState } from 'react'
import { tokens } from '../design-system/tokens.js'
import { Button } from '../design-system/components/index.js'

interface NewRunProps {
  onSubmit: (data: { featureName: string; startUrl: string; goal: string }) => void
  onCancel: () => void
  isSubmitting: boolean
}

export function NewRun({ onSubmit, onCancel, isSubmitting }: NewRunProps): React.ReactElement {
  const [featureName, setFeatureName] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [goal, setGoal] = useState('')

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onSubmit({ featureName, startUrl, goal })
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: tokens.spacing.sm,
    backgroundColor: tokens.colors.bg.elevated,
    color: tokens.colors.text.primary,
    border: `1px solid ${tokens.colors.border.default}`,
    borderRadius: tokens.radius.md,
    fontFamily: tokens.font.sans,
    fontSize: tokens.fontSize.base,
    outline: 'none',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: tokens.spacing.xs,
    color: tokens.colors.text.secondary,
    fontSize: tokens.fontSize.sm,
    fontFamily: tokens.font.mono,
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: tokens.colors.bg.base,
        color: tokens.colors.text.primary,
        fontFamily: tokens.font.sans,
        padding: tokens.spacing.xl,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div style={{ maxWidth: '560px', width: '100%' }}>
        <h1
          style={{
            fontSize: tokens.fontSize.xl,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            marginBottom: tokens.spacing.xl,
          }}
        >
          New Run
        </h1>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: tokens.spacing.lg }}>
            <label style={labelStyle}>feature_name</label>
            <input
              type="text"
              value={featureName}
              onChange={(e) => setFeatureName(e.target.value)}
              placeholder="e.g. Checkout Flow"
              required
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: tokens.spacing.lg }}>
            <label style={labelStyle}>start_url</label>
            <input
              type="url"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder="https://example.com/feature"
              required
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: tokens.spacing.xl }}>
            <label style={labelStyle}>goal</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Document the complete checkout flow including payment and confirmation"
              required
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', gap: tokens.spacing.md }}>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Starting...' : 'Start Run'}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
