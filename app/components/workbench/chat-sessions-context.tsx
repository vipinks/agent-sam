import { createContext, useContext, type ReactNode } from 'react'
import { useWorkbenchStore } from './store'
import { useChatSessions, type ChatSessions } from './use-chat-sessions'

/**
 * One session state, shared by the panel that lists conversations and the pane that shows one.
 *
 * The two need the same state and cannot each own a copy: the list triggers a save-then-load when a
 * row is clicked, and the pane holds the transcript that save writes. A provider keeps that state
 * above both, so the coordination happens once.
 */
const ChatSessionsContext = createContext<ChatSessions | null>(null)

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const providerId = useWorkbenchStore((s) => s.activeProviderId)
  const model = useWorkbenchStore((s) => s.activeModel)
  const value = useChatSessions(providerId, model)
  return <ChatSessionsContext.Provider value={value}>{children}</ChatSessionsContext.Provider>
}

/**
 * Read the shared session state.
 *
 * Throws when there is no provider rather than returning a default: a silent empty fallback would
 * make a missing provider look like an empty conversation, which is the kind of bug that takes an
 * afternoon to find.
 */
export function useChatSessionsContext(): ChatSessions {
  const value = useContext(ChatSessionsContext)
  if (!value) throw new Error('useChatSessionsContext must be used inside <ChatSessionsProvider>')
  return value
}
