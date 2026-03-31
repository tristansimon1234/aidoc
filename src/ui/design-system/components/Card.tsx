import type { ReactNode, HTMLAttributes } from 'react'
import styles from './Card.module.css'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  elevated?: boolean
}

export function Card({
  children,
  elevated = false,
  onClick,
  className,
  ...rest
}: CardProps): React.ReactElement {
  const cls = [
    styles.card,
    elevated && styles.elevated,
    onClick && styles.clickable,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick(e as unknown as React.MouseEvent<HTMLDivElement>)
            }
          : undefined
      }
      {...rest}
    >
      {children}
    </div>
  )
}
