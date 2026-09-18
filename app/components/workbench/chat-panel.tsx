import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquare, SendHorizontal, Square, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { PaneHeader } from './pane-header'
import { MessageBubble, type ChatMessage } from './message-bubble'
import { useWorkbenchStore } from './store'

let nextId = 0
function makeId(prefix: string): string {
  nextId += 1
  return `${prefix}-${nextId}`
}

/** Stream failures, in the user's terms, branched on the error code rather than the message text. */
function streamErrorMessage(error: unknown, providerName: string): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'NO_API_KEY':
        return `No API key saved for ${providerName}. Add one in Settings.`
      case 'AUTH_FAILED':
        return `${providerName} rejected the API key. Check it in Settings.`
      case 'RATE_LIMITED':
        return `${providerName} is rate limiting this key. Wait a moment and try again.`
      case 'NETWORK_ERROR':
        return `Could not reach ${providerName}. Check your connection.`
      case 'PROVIDER_ERROR':
        return `${providerName} refused the request.`
      default:
        return error.message
    }
  }
  return 'The response stream ended unexpectedly.'
}

/**
 * The chat pane: a virtualized transcript and a composer.
 *
 * Streaming stays out of React's render path. Tokens accumulate in a ref and are flushed once per
 * animation frame, so a fast model cannot outrun the compositor — one render per frame rather than
 * one per token. The transcript is virtualized so only visible turns are in the DOM, and each
 * bubble is memoized so a flush re-renders only the message that grew.
 */
export function ChatPanel() {
  const activeProviderId = useWorkbenchStore((s) => s.activeProviderId)
  const activeModel = useWorkbenchStore((s) => s.activeModel)
  const setTarget = useWorkbenchStore((s) => s.setTarget)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  // Mirrored so the stream callback reads the latest history without being re-created — which is
  // what keeps the stream from restarting on every token.
  const messagesRef = useRef<ChatMessage[]>([])
  const streamingIdRef = useRef<string | null>(null)
  // Tokens land here and drain on a frame; `frameRef` also prevents scheduling more than one.
  const bufferRef = useRef('')
  const frameRef = useRef<number | null>(null)
  // The live iterator, so the Stop button can cancel at the source.
  const iteratorRef = useRef<AsyncIterator<string> | null>(null)

  const providers = conveyor.settings.listProviders.useQuery()
  const providerName = providers.data?.find((p) => p.id === activeProviderId)?.name ?? activeProviderId

  // Whether the selected provider has a key. Undefined while the query is in flight, which must
  // not read as "missing" — a warning that flashes on load is worse than none.
  const configured = conveyor.settings.listConfigured.useQuery()
  const isKeyMissing = configured.data !== undefined && !configured.data.includes(activeProviderId)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 8,
  })

  const updateMessages = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  /** Replace the streaming turn in place. Earlier turns keep identity, so memo skips re-rendering. */
  const applyToStreaming = useCallback(
    (mutate: (message: ChatMessage) => ChatMessage) => {
      const id = streamingIdRef.current
      if (id === null) return
      const next = messagesRef.current.slice()
      const index = next.findIndex((m) => m.id === id)
      if (index === -1) return
      next[index] = mutate(next[index])
      updateMessages(next)
    },
    [updateMessages]
  )

  const stickToBottom = useCallback(() => {
    const count = messagesRef.current.length
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: 'end' })
  }, [virtualizer])

  const flush = useCallback(() => {
    frameRef.current = null
    const chunk = bufferRef.current
    if (!chunk) return
    bufferRef.current = ''
    applyToStreaming((message) => ({ ...message, content: message.content + chunk }))
    stickToBottom()
  }, [applyToStreaming, stickToBottom])

  /** Queue a token. Calls inside one frame coalesce into a single render. */
  const enqueue = useCallback(
    (chunk: string) => {
      bufferRef.current += chunk
      frameRef.current ??= requestAnimationFrame(flush)
    },
    [flush]
  )

  // Drop any pending frame on unmount so a late flush cannot set state on a gone pane.
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const stop = useCallback(() => {
    void iteratorRef.current?.return?.(undefined)
    iteratorRef.current = null
    setIsStreaming(false)
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || isStreaming) return

    // Build the transcript to send: the history plus this turn. The assistant placeholder is added
    // locally but must not be sent to the provider, so it is appended after the request is shaped.
    const history = messagesRef.current.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }))

    const userMessage: ChatMessage = { id: makeId('user'), role: 'user', content: text }
    const assistantMessage: ChatMessage = { id: makeId('assistant'), role: 'assistant', content: '' }
    streamingIdRef.current = assistantMessage.id
    setDraft('')
    setIsStreaming(true)
    updateMessages([...messagesRef.current, userMessage, assistantMessage])
    requestAnimationFrame(stickToBottom)

    // Take the iterator explicitly rather than `for await`: the Stop button needs a handle to
    // cancel, and `for await` would keep it out of reach.
    const stream = conveyor.llm.chat({
      providerId: activeProviderId,
      model: activeModel,
      messages: [...history, { role: 'user' as const, content: text }],
    })
    const iterator = stream[Symbol.asyncIterator]()
    iteratorRef.current = iterator

    try {
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) break
        enqueue(value)
      }
      // Drain whatever is still buffered so the final tokens are never dropped.
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
        flush()
      }
    } catch (err) {
      applyToStreaming((message) => ({ ...message, error: streamErrorMessage(err, providerName) }))
      toast.error('The response stopped', { description: streamErrorMessage(err, providerName) })
    } finally {
      iteratorRef.current = null
      streamingIdRef.current = null
      setIsStreaming(false)
    }
  }, [
    activeModel,
    activeProviderId,
    applyToStreaming,
    draft,
    enqueue,
    flush,
    isStreaming,
    providerName,
    stickToBottom,
    updateMessages,
  ])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline, the convention for a composer.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={MessageSquare} title="Chat">
        {/* Choosing the target here is the point: the composer sends to whatever this says. */}
        <Select
          value={activeProviderId}
          onValueChange={(id) => {
            const picked = providers.data?.find((p) => p.id === id)
            // The provider's own default model, never the previous provider's.
            if (picked) setTarget({ providerId: picked.id, model: picked.defaultModel })
          }}
        >
          <SelectTrigger aria-label="Provider and model" title={`${providerName} · ${activeModel}`}>
            <SelectValue placeholder="Choose a provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                <span className="flex items-baseline gap-2">
                  <span>{provider.name}</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">{provider.defaultModel}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isKeyMissing && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`No API key saved for ${providerName}`}
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <TriangleAlert className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="text-[11.5px]">No API key saved for this provider — add one in Settings.</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </PaneHeader>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <MessageSquare className="size-6 text-muted-foreground/40" />
            <p className="text-[13px] font-medium">Start a conversation</p>
            <p className="max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
              Answers stream in here, with the code they touch shown alongside.
            </p>
          </div>
        ) : (
          // Virtualized: the transcript can grow without bound while the DOM stays small.
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={messages[item.index].id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <MessageBubble message={messages[item.index]} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about this project…"
            aria-label="Message"
            className="min-h-20 resize-none pt-2.5 pr-11 text-[13px]"
          />
          {isStreaming ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="absolute right-2 bottom-2"
              aria-label="Stop"
              onClick={stop}
            >
              <Square />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              className="absolute right-2 bottom-2"
              aria-label="Send message"
              disabled={!draft.trim()}
              onClick={() => void send()}
            >
              <SendHorizontal />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
