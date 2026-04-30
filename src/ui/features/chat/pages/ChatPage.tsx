import { useOutletContext, useNavigate } from 'react-router-dom'
import { api, type ProjectDTO } from '../../../shared/api/client.js'
import { supabase } from '../../../shared/api/supabase.js'
import { ChatSurface, type ChatSurfaceApi } from '../components/ChatSurface.js'
import { getChatSessionToken } from '../../../shared/hooks/useChatSessionToken.js'

/**
 * Admin-side chat at /projects/:pid/chat. Thin wrapper around
 * ChatSurface: injects the authed API + navigates to the page's admin
 * edit view on source click. The public-docs chat uses the same surface
 * with a public adapter so both look identical.
 */
export function ChatPage(): React.ReactElement {
  const { project } = useOutletContext<{ project: ProjectDTO }>()
  const navigate = useNavigate()

  const chatApi: ChatSurfaceApi = {
    status: async (projectId: string) => {
      // Fast direct-Supabase check avoids a Vercel cold-start on a route
      // the user hits often.
      const { count, error } = await supabase
        .from('doc_embeddings')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
      if (error) throw new Error(error.message)
      return { hasEmbeddings: (count ?? 0) > 0 }
    },
    index: (projectId) => api.chat.index(projectId),
    send: (projectId, message, history, sessionToken) =>
      api.chat.send(projectId, message, history, sessionToken),
    // Streaming SSE — token-by-token rendering instead of a 2-3s spinner.
    sendStream: api.chat.sendStream,
    suggestions: (projectId) => api.chat.suggestions(projectId),
  }

  return (
    <ChatSurface
      projectId={project.id}
      projectName={project.name}
      api={chatApi}
      sessionToken={getChatSessionToken(project.id)}
      onSourceClick={(s) => navigate(`/projects/${project.id}/pages/${s.pageId}`)}
    />
  )
}
