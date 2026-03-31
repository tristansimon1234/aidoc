import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className,
  ...rest
}: ButtonProps): React.ReactElement {
  const cls = [styles.button, styles[variant], styles[size], className].filter(Boolean).join(' ')

  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  )
}
