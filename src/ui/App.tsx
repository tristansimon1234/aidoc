import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './shared/hooks/useAuth.js'
import { Spinner } from './design-system/components/index.js'
import { JobProvider } from './shared/jobs/JobContext.js'
import { Login } from './features/auth/pages/Login.js'
import { ProjectList } from './features/project/pages/ProjectList.js'
import { NewProject } from './features/project/pages/NewProject.js'
import { ProjectDetail } from './features/project/pages/ProjectDetail.js'
import { NewPage } from './features/page/pages/NewPage.js'
import { PageView } from './features/page/pages/PageView.js'
import { ProjectSettings } from './features/project/pages/ProjectSettings.js'
import { ProjectDesign } from './features/project/pages/ProjectDesign.js'
import { ChatPage } from './features/chat/pages/ChatPage.js'
import { SharePage } from './features/page/pages/SharePage.js'
import { PublicDocs } from './features/docs/pages/PublicDocs.js'
import { AccountSettings } from './features/account/pages/AccountSettings.js'
import { AdminUsage } from './features/admin/pages/AdminUsage.js'

export function App(): React.ReactElement {
  const { user, loading, signIn, signUp, signOut } = useAuth()

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <JobProvider>
    <BrowserRouter>
      <Routes>
        {/* Public — no auth */}
        <Route path="/docs/:projectId" element={<PublicDocs />} />

        {/* Auth gate */}
        {!user ? (
          <>
            <Route path="/login" element={<Login onSignIn={signIn} onSignUp={signUp} />} />
            <Route path="*" element={<Login onSignIn={signIn} onSignUp={signUp} />} />
          </>
        ) : (
          <>
            <Route path="/" element={<ProjectList onSignOut={signOut} />} />
            <Route path="/account" element={<AccountSettings />} />
            <Route path="/admin/usage" element={<AdminUsage />} />
            <Route path="/projects/new" element={<NewProject />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />}>
              <Route path="pages/new" element={<NewPage />} />
              <Route path="pages/:pageId" element={<PageView />} />
              <Route path="chat" element={<ChatPage />} />
              <Route path="share" element={<SharePage />} />
              <Route path="design" element={<ProjectDesign />} />
              <Route path="settings" element={<ProjectSettings />} />
            </Route>
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
    </JobProvider>
  )
}
