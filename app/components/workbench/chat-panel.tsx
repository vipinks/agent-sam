import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageSquare, SendHorizontal, ShieldCheck, Square, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { PaneHeader } from './pane-header'
import { MessageBubble } from './message-bubble'
import { useChatSessionsContext } from './chat-sessions-context'
import {
  applyAgentChunk,
  resolveDecision,
  startAssistantTurn,
  startUserTurn,
  toHistory,
  type AgentTurn,
  type PendingCall,
} from './agent-session'
import { useWorkbenchStore } from './store'

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
      case 'NO_WORKSPACE':
        return 'Open a folder first — the agent works inside your workspace.'
      default:
        return error.message
    }
  }
  return 'The response stream ended unexpectedly.'
}

/** What the agent is paused on, and everything needed to continue it. */
interface PendingApproval {
  turnId: string
  /** The one call this decision is about; the rest of `calls` are queued behind it. */
  callId: string
  tool: string
  /** The provider-shaped history the run handed over, echoed back untouched on resume. */
  messages: unknown[]
  /**
   * The frame's calls still awaiting a decision, this one first, as the model sent them. The decision
   * answers only the head; the loop presents the next one when this stream ends.
   */
  calls: PendingCall[]
  steps: number
}

/**
 * The chat pane: a virtualized transcript, a composer, and the agent's consent gate.
 *
 * The agent run is a sequence of streamed chunks that each either extend the assistant's prose or
 * attach a tool card to it. Chunks accumulate in a ref and are flushed once per animation frame, so
 * a fast model cannot outrun the compositor — one render per frame rather than one per token, with
 * the transcript virtualized and each bubble memoized so only the turn that grew re-renders.
 *
 * A run that needs permission does not hang: the agent stream *ends* at the pause, handing over the
 * history it paused with. Approving starts a second stream that continues from there, which is why
 * the loop spans two calls rather than one long-lived stream — conveyor streams are one-way, so
 * there is no channel to push a decision down mid-stream.
 *
 * Consent is per call, so a frame with several calls needing approval is a sequence of short streams
 * rather than one long pause: decide the head, the loop runs it and hands back the next, until the
 * frame is settled and the model is asked again. Only the head is ever actionable, and the pane holds
 * exactly one pending decision at a time, which is what makes that true in the UI as well as in main.
 */
export function ChatPanel() {
  const activeProviderId = useWorkbenchStore((s) => s.activeProviderId)
  const activeModel = useWorkbenchStore((s) => s.activeModel)
  const setTarget = useWorkbenchStore((s) => s.setTarget)

  // Sessions own the transcript: it is shared with the panel (which saves it before a switch) and
  // persisted at turn boundaries. The pane reads and replaces it, but does not hold it.
  const sessions = useChatSessionsContext()
  const messages = sessions.transcript.turns

  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  // Off by default: a tool that writes to disk should be a deliberate choice, not a default.
  const [autoApprove, setAutoApprove] = useState(false)
  const [pending, setPending] = useState<PendingApproval | null>(null)

  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)

  const scrollRef = useRef<HTMLDivElement>(null)
  // Mirrored so the stream callback reads the latest transcript without being re-created, which is
  // what keeps the run from restarting on every chunk.
  const messagesRef = useRef<AgentTurn[]>(messages)
  messagesRef.current = messages
  const streamingTurnIdRef = useRef<string | null>(null)
  // Chunks land here and drain on a frame; `frameRef` also prevents scheduling more than one.
  const bufferRef = useRef('')
  const frameRef = useRef<number | null>(null)
  // The live iterator, so the Stop button can cancel at the source.
  const iteratorRef = useRef<AsyncIterator<unknown> | null>(null)

  const providers = conveyor.settings.listProviders.useQuery()
  // The seeded catalogue: what to offer before a provider has ever been fetched.
  const defaultModels = conveyor.settings.defaultModels.useQuery()

  // The user's intent, from the persisted store: the dropdown offers exactly these.
  const configs = useConveyorStore(providerConfigStore, (s) => s.providers)

  // Whether the selected provider has a key. Undefined while the query is in flight, which must
  // not read as "missing" — a warning that flashes on load is worse than none.
  const configured = conveyor.settings.listConfigured.useQuery()

  const providerName = providers.data?.find((p) => p.id === activeProviderId)?.name ?? activeProviderId
  const modelsFor = (providerId: string): string[] => {
    const enabled = configs[providerId]?.enabledModels
    if (enabled && enabled.length > 0) return enabled
    // The seeded catalogue carries names as well as ids; the composer only needs the ids.
    return (defaultModels.data?.[providerId] ?? []).map((m) => m.id)
  }
  const isKeyMissing = configured.data !== undefined && !configured.data.includes(activeProviderId)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 8,
  })

  // The session API is read through a ref so `updateMessages` keeps a stable identity: it is a
  // dependency of the stream callbacks, and a new identity per render would restart the run on every
  // chunk — exactly what this pane is built to avoid.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const updateMessages = useCallback((next: AgentTurn[]) => {
    messagesRef.current = next
    // Through the shared session state, not local state: this is the transcript that gets saved.
    sessionsRef.current.setTranscript({ turns: next, interrupted: false })
  }, [])

  const stickToBottom = useCallback(() => {
    const count = messagesRef.current.length
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: 'end' })
  }, [virtualizer])

  const flush = useCallback(() => {
    frameRef.current = null
    const chunk = bufferRef.current
    if (!chunk) return
    bufferRef.current = ''
    const turnId = streamingTurnIdRef.current
    if (turnId === null) return
    const { turns } = applyAgentChunk(messagesRef.current, turnId, { type: 'text_delta', text: chunk })
    updateMessages(turns)
    stickToBottom()
  }, [stickToBottom, updateMessages])

  /** Queue text. Calls inside one frame coalesce into a single render. */
  const enqueue = useCallback(
    (chunk: string) => {
      bufferRef.current += chunk
      frameRef.current ??= requestAnimationFrame(flush)
    },
    [flush]
  )

  /** Apply the buffered text immediately, so a pause or an exit never swallows the last tokens. */
  const drainNow = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      flush()
    }
  }, [flush])

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

  /**
   * Drive one agent stream to its end.
   *
   * Every chunk is handed to the reducer, which owns what the transcript looks like. The only chunk
   * with a side effect is the pause: it stops this stream and records what is needed to continue.
   */
  const runStream = useCallback(
    async (stream: AsyncIterable<unknown>, turnId: string) => {
      const iterator = stream[Symbol.asyncIterator]()
      iteratorRef.current = iterator
      setIsStreaming(true)

      try {
        for (;;) {
          const { value, done } = await iterator.next()
          if (done) break

          const chunk = value as Record<string, unknown>
          // Text is buffered for the frame; everything else applies immediately, because a card or a
          // pause is a discrete event and should not wait on a frame.
          if (chunk.type === 'text_delta' && typeof chunk.text === 'string') {
            enqueue(chunk.text)
            continue
          }

          drainNow()
          const { turns, effect } = applyAgentChunk(messagesRef.current, turnId, chunk)
          updateMessages(turns)

          if (effect.approval) {
            setPending({
              turnId,
              callId: effect.approval.callId,
              tool: effect.approval.tool,
              messages: effect.approval.messages,
              calls: effect.approval.calls,
              steps: effect.approval.steps,
            })
            // The stream is over as far as this call is concerned; the run continues on the decision.
            return
          }

          if (effect.done) {
            stickToBottom()
            return
          }
          stickToBottom()
        }
      } catch (err) {
        const message = streamErrorMessage(err, providerName)
        updateMessages(messagesRef.current.map((t) => (t.id === turnId ? { ...t, error: message } : t)))
        toast.error('The agent stopped', { description: message })
      } finally {
        drainNow()
        iteratorRef.current = null
        streamingTurnIdRef.current = null
        setIsStreaming(false)
      }
    },
    [drainNow, enqueue, providerName, stickToBottom, updateMessages]
  )

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || isStreaming || pending) return

    // Sending with no session open is normal: a session is created for the message, and named from
    // it. This is what makes the composer work before the user has ever touched the session list.
    sessionsRef.current.ensureSession(text)

    // The history sent is text-only: the agent owns the provider-shaped history, including tool
    // turns, and hands it back on a pause.
    const history = toHistory(messagesRef.current)

    const userTurn = startUserTurn(text)
    const assistantTurn = startAssistantTurn()
    streamingTurnIdRef.current = assistantTurn.id
    setDraft('')
    updateMessages([...messagesRef.current, userTurn, assistantTurn])
    requestAnimationFrame(stickToBottom)

    await runStream(
      conveyor.agent.chatWithTools({
        providerId: activeProviderId,
        model: activeModel,
        messages: [...history, { role: 'user' as const, content: text }],
        workspaceRoot: rootPath,
        autoApprove,
      }),
      assistantTurn.id
    )

    // A turn boundary: the user's message and its finished assistant turn are now a complete unit,
    // so this is when the transcript is worth writing. Never per token — the run above may have
    // produced hundreds of chunks, and this is one save.
    sessionsRef.current.scheduleSave()
  }, [
    activeModel,
    activeProviderId,
    autoApprove,
    draft,
    isStreaming,
    pending,
    rootPath,
    runStream,
    stickToBottom,
    updateMessages,
  ])

  /**
   * Answer a pause.
   *
   * Approval and denial travel the same path: the decision goes to `resume`, which either runs the
   * tool or feeds the refusal back to the model as the tool's result. Denial is therefore not a dead
   * end — the model gets to explain itself.
   */
  const decide = useCallback(
    async (approved: boolean) => {
      const current = pending
      if (!current || isStreaming) return

      setPending(null)
      // Record the decision against the one call it was about. The cards queued behind it stay queued:
      // the loop is about to present the next of them, and marking them decided here would claim
      // consent the user has not given.
      const next = resolveDecision(messagesRef.current, current.turnId, current.callId, approved)
      updateMessages(next)

      streamingTurnIdRef.current = current.turnId
      requestAnimationFrame(stickToBottom)

      await runStream(
        conveyor.agent.resume({
          providerId: activeProviderId,
          model: activeModel,
          // The history the loop paused with and the model's own calls — both handed back exactly as
          // they came, so nothing is rebuilt from the display layer. The queue goes back whole while
          // the decision answers its head, which is how the loop knows what to present next.
          messages: current.messages as never,
          workspaceRoot: rootPath,
          autoApprove,
          calls: current.calls,
          steps: current.steps,
          decision: approved ? 'approved' : 'denied',
        }),
        current.turnId
      )

      // Answering a decision completes the turn, so it is a save point too.
      sessionsRef.current.scheduleSave()
    },
    [
      activeModel,
      activeProviderId,
      autoApprove,
      isStreaming,
      pending,
      rootPath,
      runStream,
      stickToBottom,
      updateMessages,
    ]
  )

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
        {/*
          Auto-approve sits beside the model picker because it is the other thing that decides what a
          send does: whether the agent acts on its own or asks first.
        */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent">
                <ShieldCheck className="size-3.5 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">Auto-approve</span>
                <Switch
                  size="sm"
                  checked={autoApprove}
                  onCheckedChange={setAutoApprove}
                  aria-label="Auto-approve tool actions"
                />
              </label>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="text-[11.5px]">
                {autoApprove
                  ? 'Writes and commands run without asking. Reads are always allowed.'
                  : 'Each write and command waits for your approval.'}
              </span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/*
          One control, two axes: the value is `provider::model`, so picking either changes both.
          Options are grouped by provider, and a provider only offers the models switched on in
          Settings — a provider with none gets a disabled hint instead of a dead end.
        */}
        <Select
          value={`${activeProviderId}::${activeModel}`}
          onValueChange={(picked) => {
            const [providerId, ...rest] = picked.split('::')
            const model = rest.join('::')

            // An explicit model wins — including one belonging to a different provider, which is
            // how a user compares two providers' models without a detour through the first entry.
            if (model) {
              setTarget({ providerId, model })
              return
            }

            // Only a bare provider pick auto-selects, and then it takes that provider's first
            // enabled model, since the previous provider's model means nothing to it.
            const first = modelsFor(providerId)[0]
            if (first) setTarget({ providerId, model: first })
          }}
        >
          <SelectTrigger aria-label="Provider and model" title={`${providerName} · ${activeModel}`}>
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((provider) => {
              const models = modelsFor(provider.id)
              return (
                <SelectGroup key={provider.id}>
                  <SelectLabel>{provider.name}</SelectLabel>
                  {models.length === 0 ? (
                    <SelectItem value={`${provider.id}::`} disabled>
                      <span className="text-muted-foreground">Enable models in Settings</span>
                    </SelectItem>
                  ) : (
                    models.map((model) => (
                      <SelectItem key={model} value={`${provider.id}::${model}`}>
                        <span className="font-mono">{model}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectGroup>
              )
            })}
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
              Answers stream in here, and the agent shows every file it reads and command it runs.
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
                <MessageBubble
                  message={messages[item.index]}
                  onApprove={() => void decide(true)}
                  onDeny={() => void decide(false)}
                />
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
            placeholder={pending ? 'Waiting for your approval…' : 'Ask about this project…'}
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
              disabled={!draft.trim() || pending !== null}
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
