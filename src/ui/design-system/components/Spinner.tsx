import styles from './Spinner.module.css'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
}

export function Spinner({ size = 'md' }: SpinnerProps): React.ReactElement {
  return <div className={`${styles.spinner} ${styles[size]}`} role="status" aria-label="Loading" />
}
