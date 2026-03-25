import React from 'react'
import { tokens } from '../tokens.js'

interface CardProps {
  children: React.ReactNode
  elevated?: boolean
  onClick?: () => void
}

export function Card({ children, elevated = false, onClick }: CardProps): React.ReactElement {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={{
        backgroundColor: elevated ? tokens.colors.bg.elevated : tokens.colors.bg.surface,
        border: `1px solid ${tokens.colors.border.subtle}`,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing.lg,
        boxShadow: elevated ? tokens.shadow.md : tokens.shadow.sm,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
      }}
    >
      {children}
    </div>
  )
}
