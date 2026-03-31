import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import styles from './Input.module.css'

interface InputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  error?: string
}

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string
  error?: string
  multiline: true
}

type FieldProps = InputFieldProps | TextareaFieldProps

function isTextarea(props: FieldProps): props is TextareaFieldProps {
  return 'multiline' in props && props.multiline === true
}

export function Field(props: FieldProps): React.ReactElement {
  const { label, error } = props

  if (isTextarea(props)) {
    const { label: _l, error: _e, multiline: _m, className, ...rest } = props
    return (
      <div className={styles.field}>
        <label className={styles.label}>{label}</label>
        <textarea
          className={`${styles.textarea} ${error ? styles.error : ''} ${className ?? ''}`}
          {...rest}
        />
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
    )
  }

  const { label: _l, error: _e, className, ...rest } = props
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input
        className={`${styles.input} ${error ? styles.error : ''} ${className ?? ''}`}
        {...rest}
      />
      {error && <span className={styles.errorText}>{error}</span>}
    </div>
  )
}
