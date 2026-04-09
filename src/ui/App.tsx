import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './shared/hooks/useAuth.js'
import { Spinner } from './design-system/components/index.js'
import { Login } from './features/auth/pages/Login.js'
import { ProjectList } from './features/project/pages/ProjectList.js'
import { NewProject } from './features/project/pages/NewProject.js'
import { ProjectDetail } from './features/project/pages/ProjectDetail.js'
import { NewPage } from './features/page/pages/NewPage.js'
import { PageView } from './features/page/pages/PageView.js'
import { ProjectSettings } from './features/project/pages/ProjectSettings.js'
import { ProjectDesign } from './features/project/pages/ProjectDesign.js'

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
        <Route path="/" element={<ProjectList onSignOut={signOut} />} />
        <Route path="/projects/new" element={<NewProject />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />}>
          <Route path="pages/new" element={<NewPage />} />
          <Route path="pages/:pageId" element={<PageView />} />
          <Route path="design" element={<ProjectDesign />} />
          <Route path="settings" element={<ProjectSettings />} />
        </Route>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
