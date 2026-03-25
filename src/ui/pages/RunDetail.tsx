import React from 'react'
import { tokens } from '../design-system/tokens.js'
import { Card, StatusIndicator, Badge, CodeBlock } from '../design-system/components/index.js'
import type { Run, RunStep } from '../../features/run/run.types.js'
import type { GeneratedDoc } from '../../features/documentation/documentation.types.js'

interface RunDetailProps {
  run: Run
  steps: RunStep[]
  doc: GeneratedDoc | null
  onBack: () => void
}

export function RunDetail({ run, steps, doc, onBack }: RunDetailProps): React.ReactElement {
  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: tokens.colors.bg.base,
        color: tokens.colors.text.primary,
        fontFamily: tokens.font.sans,
        padding: tokens.spacing.xl,
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: 'none',
          border: 'none',
          color: tokens.colors.text.secondary,
          fontSize: tokens.fontSize.sm,
          fontFamily: tokens.font.mono,
          cursor: 'pointer',
          padding: 0,
          marginBottom: tokens.spacing.lg,
        }}
      >
        &larr; Back to runs
      </button>

      <header style={{ marginBottom: tokens.spacing.xl }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.md }}>
          <h1
            style={{
              margin: 0,
              fontSize: tokens.fontSize.xl,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            {run.featureName}
          </h1>
          <StatusIndicator status={run.status} />
        </div>
        <p
          style={{
            margin: `${tokens.spacing.sm} 0 0`,
            color: tokens.colors.text.secondary,
            fontSize: tokens.fontSize.base,
          }}
        >
          {run.goal}
        </p>
        <div
          style={{
            display: 'flex',
            gap: tokens.spacing.md,
            marginTop: tokens.spacing.sm,
          }}
        >
          <Badge color="blue">{run.tokenUsage} tokens</Badge>
          <Badge color="purple">{steps.length} steps</Badge>
        </div>
      </header>

      <section style={{ marginBottom: tokens.spacing.xl }}>
        <h2
          style={{
            fontSize: tokens.fontSize.lg,
            fontWeight: 500,
            marginBottom: tokens.spacing.md,
          }}
        >
          Steps
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.sm }}>
          {steps.map((step) => (
            <Card key={step.id}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: tokens.spacing.md,
                }}
              >
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: tokens.fontSize.xs,
                    color: tokens.colors.text.muted,
                    minWidth: '24px',
                  }}
                >
                  {step.stepIndex + 1}
                </span>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontSize: tokens.fontSize.sm }}>
                    {step.action}
                  </p>
                  {step.observation && (
                    <p
                      style={{
                        margin: `${tokens.spacing.xs} 0 0`,
                        color: tokens.colors.text.muted,
                        fontSize: tokens.fontSize.xs,
                      }}
                    >
                      {step.observation}
                    </p>
                  )}
                  {step.url && (
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: tokens.fontSize.xs,
                        color: tokens.colors.text.muted,
                      }}
                    >
                      {step.url}
                    </span>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {doc?.markdownContent && (
        <section>
          <h2
            style={{
              fontSize: tokens.fontSize.lg,
              fontWeight: 500,
              marginBottom: tokens.spacing.md,
            }}
          >
            Generated Documentation
          </h2>
          <CodeBlock code={doc.markdownContent} language="markdown" />
        </section>
      )}
    </div>
  )
}
