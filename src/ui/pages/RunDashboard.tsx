import React from 'react'
import { tokens } from '../design-system/tokens.js'
import { Card, StatusIndicator } from '../design-system/components/index.js'
import type { Run } from '../../features/run/run.types.js'

interface RunDashboardProps {
  runs: Run[]
  onSelectRun: (id: string) => void
  onNewRun: () => void
}

export function RunDashboard({
  runs,
  onSelectRun,
  onNewRun,
}: RunDashboardProps): React.ReactElement {
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
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing.xl,
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: tokens.fontSize.xl,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            Runs
          </h1>
          <p
            style={{
              margin: `${tokens.spacing.xs} 0 0`,
              color: tokens.colors.text.secondary,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {runs.length} total runs
          </p>
        </div>
        <button
          onClick={onNewRun}
          style={{
            padding: `${tokens.spacing.sm} ${tokens.spacing.lg}`,
            backgroundColor: tokens.colors.accent.blue,
            color: tokens.colors.text.inverse,
            border: 'none',
            borderRadius: tokens.radius.md,
            fontFamily: tokens.font.sans,
            fontSize: tokens.fontSize.base,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          New Run
        </button>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.md }}>
        {runs.map((run) => (
          <Card key={run.id} onClick={() => onSelectRun(run.id)}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: tokens.fontSize.md,
                    fontWeight: 500,
                  }}
                >
                  {run.featureName}
                </h3>
                <p
                  style={{
                    margin: `${tokens.spacing.xs} 0 0`,
                    color: tokens.colors.text.muted,
                    fontSize: tokens.fontSize.sm,
                    fontFamily: tokens.font.mono,
                  }}
                >
                  {run.startUrl}
                </p>
              </div>
              <StatusIndicator status={run.status} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
