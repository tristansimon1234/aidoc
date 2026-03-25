import React from 'react'
import { tokens } from '../tokens.js'

interface BadgeProps {
  children: React.ReactNode
  color?: 'blue' | 'green' | 'amber' | 'red' | 'purple'
}

export function Badge({ children, color = 'blue' }: BadgeProps): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: `${tokens.spacing.xs} ${tokens.spacing.sm}`,
        fontSize: tokens.fontSize.xs,
        fontFamily: tokens.font.mono,
        fontWeight: 500,
        color: tokens.colors.accent[color],
        backgroundColor: tokens.colors.bg.elevated,
        border: `1px solid ${tokens.colors.border.subtle}`,
        borderRadius: tokens.radius.full,
      }}
    >
      {children}
    </span>
  )
}
