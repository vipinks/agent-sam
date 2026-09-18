import { MessageSquare, SendHorizontal } from 'lucide-react'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { PaneHeader } from './pane-header'

/**
 * The chat pane's shell: a transcript region that will own the scrolling history list, and the
 * composer. Sending is inert until a conveyor `stream()` module exists to consume it.
 */
export function ChatPanel() {
  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={MessageSquare} title="Chat" />

      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <MessageSquare className="size-6 text-muted-foreground/40" />
        <p className="text-[13px] font-medium">Start a conversation</p>
        <p className="max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
          Answers stream in here, with the code they touch shown alongside.
        </p>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="relative">
          <Textarea
            disabled
            placeholder="Ask about this project…"
            aria-label="Message"
            className="min-h-20 resize-none pt-2.5 pr-11 text-[13px]"
          />
          <Button size="icon-sm" disabled className="absolute right-2 bottom-2" aria-label="Send message">
            <SendHorizontal />
          </Button>
        </div>
      </div>
    </div>
  )
}
