import { useState, useEffect, useCallback } from 'react'

interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  refetch: () => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  const refetch = useCallback((): void => {
    setTick((t) => t + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fn()
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message)
          setLoading(false)
        }
      })

    return (): void => {
      cancelled = true
    }
    // eslint-disable-next-line
  }, [tick, ...deps])

  return { data, error, loading, refetch }
}
