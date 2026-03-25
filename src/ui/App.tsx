import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './shared/hooks/useAuth.js'
import { Spinner } from './design-system/components/index.js'
import { Login } from './features/auth/pages/Login.js'
import { RunDashboard } from './features/run/pages/RunDashboard.js'
import { RunDetail } from './features/run/pages/RunDetail.js'
import { NewRun } from './features/run/pages/NewRun.js'

export function App(): React.ReactElement {
  const { user, loading, signIn, signUp, signOut } = useAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spinner size="lg" />
      </div>
    )
  }

  if (!user) {
    return <Login onSignIn={signIn} onSignUp={signUp} />
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RunDashboard onSignOut={signOut} />} />
        <Route path="/runs/new" element={<NewRun />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
