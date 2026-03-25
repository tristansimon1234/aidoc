import React from 'react'
import { tokens } from '../tokens.js'

interface ButtonProps {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
}

const variantStyles = {
  primary: {
    background: tokens.colors.accent.blue,
    color: tokens.colors.text.inverse,
    border: 'none',
  },
  secondary: {
    background: tokens.colors.bg.elevated,
    color: tokens.colors.text.primary,
    border: `1px solid ${tokens.colors.border.default}`,
  },
  ghost: {
    background: 'transparent',
    color: tokens.colors.text.secondary,
    border: '1px solid transparent',
  },
} as const

const sizeStyles = {
  sm: { padding: `${tokens.spacing.xs} ${tokens.spacing.sm}`, fontSize: tokens.fontSize.sm },
  md: { padding: `${tokens.spacing.sm} ${tokens.spacing.md}`, fontSize: tokens.fontSize.base },
  lg: { padding: `${tokens.spacing.md} ${tokens.spacing.lg}`, fontSize: tokens.fontSize.md },
} as const

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick,
  type = 'button',
}: ButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...variantStyles[variant],
        ...sizeStyles[size],
        borderRadius: tokens.radius.md,
        fontFamily: tokens.font.sans,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s ease',
      }}
    >
      {children}
    </button>
  )
}
