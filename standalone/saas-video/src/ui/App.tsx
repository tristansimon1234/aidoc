import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './shared/hooks/useAuth.js'
import { Spinner } from './design-system/components/index.js'
import { Landing } from './features/landing/Landing.js'
import { Login } from './features/auth/Login.js'
import { Signup } from './features/auth/Signup.js'
import { Onboarding } from './features/onboarding/Onboarding.js'
import { Dashboard } from './features/dashboard/Dashboard.js'
import { Billing } from './features/billing/Billing.js'

/**
 * Top-level router. The two-layer split (authed vs anon) keeps the
 * landing page reachable without a session and the dashboard tightly
 * gated. After login, the onboarding redirect ensures the user has at
 * least one brand before they can reach the generate flow.
 */
export function App(): React.ReactElement {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Public — landing reachable whether or not the user is signed in. */}
        <Route path="/" element={<Landing />} />

        {user ? (
          <>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/login" element={<Navigate to="/dashboard" replace />} />
            <Route path="/signup" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </>
        ) : (
          <>
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  )
}
