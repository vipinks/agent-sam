import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  MessageSquare,
  ImagePlus,
  Lock,
  Paperclip,
  SendHorizontal,
  ShieldCheck,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { buddiesStore } from '@/conveyor/stores/buddies'
import {
  buddyLabel,
  listBuddies,
  resolveBuddy,
  SAMAI_BUDDY_ID,
  AGENT_SAM_BUDDY_NAME,
} from '@/conveyor/protocol/buddies'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import type { CustomProvider } from '@/conveyor/protocol/custom-provider'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { appearancePreferencesStore } from '@/conveyor/stores/appearance-preferences'
import { cn } from '@/lib/utils'
import samMark from '@/resources/build/icon.svg'
import { Button } from '../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { COMPOSER_MIN_HEIGHT, clampComposerHeight, composerBounds } from './composer-resize'
import { HOME_STARTERS } from './home'
import { HomeHero, HomePanel } from './home-panel'
import { PaneHeader } from './pane-header'
import { MessageBubble } from './message-bubble'
import { MentionPicker } from './mention-picker'
import { CommandNotice, CommandPicker, type CommandNoticeText } from './command-picker'
import { MentionChipRow } from './mention-chip'
import { AttachmentChipRow } from './attachment-chip'
import {
  ATTACHMENT_ACCEPT_ATTRIBUTE,
  addDraftAttachment,
  attachmentSaveRequests,
  composerAcceptsImages,
  filesIn,
  imageCapabilityNotice,
  removeDraftAttachment,
  type DraftAttachment,
} from './attachments'
import {
  IMAGE_ATTACH_NOT_FOUND,
  IMAGE_ATTACH_REFUSED,
  type ImageAttachmentRef,
} from '@/conveyor/protocol/image-attachments'
import { SkillChipRow, SkillPicker } from './skill-picker'
import { PlanChecklist } from './plan-checklist'
import { TurnEndNotice } from './turn-end-notice'
import { useChatSessionsContext } from './chat-sessions-context'
import {
  activeMentionToken,
  addMentionPath,
  filterMentionPaths,
  removeMentionPath,
  type MentionRefusal,
  type MentionToken,
} from './mentions'
import { MAX_MENTION_PATHS } from '@/conveyor/protocol/mentions'
import {
  composerCommandAt,
  filterComposerCommands,
  parseComposerCommand,
  type ComposerCommandId,
  type ComposerCommandToken,
} from '@/conveyor/protocol/composer-commands'
import { MAX_ACTIVE_SKILLS, offeredSkills, scopeSkills, type SkillListing } from '@/conveyor/protocol/skills'
import { truncateFromTurn } from '@/conveyor/protocol/truncate'
import {
  ABANDONED_PAUSE_CODE,
  abandonUndecidedCalls,
  applyAgentChunk,
  currentEndNotice,
  currentPlan,
  endTurn,
  noteContextSkip,
  resolveDecision,
  startAssistantTurn,
  startUserTurn,
  toHistory,
  type AgentTurn,
} from './agent-session'
import { RESUME_MESSAGE } from '@/conveyor/protocol/turn-end'
import { useWorkbenchStore } from './store'
import { useThemeStore } from '@/app/shell/theme-store'

/**
 * Why an attach attempt did not add a chip, in the user's terms.
 *
 * The cap is named with the same constant main enforces on the wire, so the message cannot promise a
 * number the schema would then refuse.
 */
function mentionRefusalNote(refusal: MentionRefusal): string {
  return refusal === 'duplicate'
    ? 'That file is already attached.'
    : `One message can attach at most ${MAX_MENTION_PATHS} files.`
}

/**
 * What `/help` lists: every command available where it was typed, with the line that says what each one
 * does.
 *
 * Built from the registry rather than written out, so a command cannot be added and left out of the
 * help; and narrowed by the same availability rule the picker uses, because a list offering `/new` on
 * the screen where it does nothing would be a list that lied at the one place a user goes to find out
 * what the composer can do.
 */
function commandHelp(atHome: boolean): CommandNoticeText {
  return {
    title: 'Commands',
    lines: filterComposerCommands('', { atHome }).map((command) => `/${command.name} — ${command.description}`),
  }
}

/**
 * The files the message a run is about to answer had attached.
 *
 * A regenerate sends no message of its own, so the run's context comes from the turn the discarded reply
 * was answering: the last turn the cut left, when it is the user's. Read off the transcript rather than
 * remembered, because the chips live on the turn — and empty when the cut left nothing or left a reply,
 * which is what keeps a payload from claiming files that no message named.
 */
function lastAskMentions(turns: readonly AgentTurn[]): string[] {
  const ask = turns[turns.length - 1]
  return ask?.role === 'user' ? [...(ask.mentionPaths ?? [])] : []
}

/**
 * The active skills as chips, and the picker's own view of what it is offering.
 *
 * What the picker shows before main answers, and what it shows when main answers with nothing: one
 * value, so there is no second empty case to forget. Held at module scope because it is a constant, not
 * because it is shared — a render must not build a new listing to say "nothing yet".
 */
const NO_SKILLS: SkillListing = {
  tiers: [],
  errors: [],
  disabled: [],
  counts: { total: 0, project: 0, user: 0, errors: 0, hidden: 0 },
}

/**
 * The name to show for an active skill id.
 *
 * The listing is where a title comes from, and a session stores ids. An id with no row behind it is a
 * skill that has been removed, renamed or shadowed since it was turned on — shown as the id it is, so
 * the chip says which skill it means and the refusal at the next turn start is not a surprise.
 */
function activeSkillTitle(listing: SkillListing, id: string): string {
  for (const tier of listing.tiers) {
    const skill = tier.skills.find((entry) => entry.id === id)
    if (skill) return skill.title
  }
  return id
}

/**
 * Why a send stopped because an image could not be stored, in the user's terms.
 *
 * Branched on the code and never on the sentence: main names the failure with a stable string, and the
 * wording of what to tell the user is this side's to own — the rule every other failure here follows. The
 * message main wrote is shown beside this app's own sentence only for the refusal, which is the one the
 * user can act on.
 */
function attachmentSaveErrorMessage(error: unknown): string {
  const lead = 'That image could not be stored, so nothing was sent.'
  if (!(error instanceof ConveyorError)) return lead

  switch (error.code) {
    case IMAGE_ATTACH_REFUSED:
      return `${lead} ${error.message}`
    case IMAGE_ATTACH_NOT_FOUND:
      return lead
    default:
      return `${lead} (${error.code})`
  }
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
      case 'NO_WORKSPACE':
        return 'Open a folder first — the agent works inside your workspace.'
      // A skill the turn was told to use and could not: named, because the user turned it on and the
      // fix is theirs — the folder is gone, the file is unreadable, or it no longer parses. Nothing was
      // sent, which is the point of failing here rather than guessing at what the skill said.
      case 'SKILL_NOT_FOUND':
        return 'A skill this conversation uses could not be found. Turn it off, or put its SKILL.md back.'
      case 'SKILL_PARSE_INVALID':
      case 'SKILL_MANIFEST_INVALID':
        return 'A skill this conversation uses could not be read. Check its SKILL.md, or turn it off.'
      case 'SKILL_TOO_LARGE':
        return 'A skill this conversation uses is too large to send. Shorten its SKILL.md, or turn it off.'
      case 'SKILL_IO_ERROR':
        return 'A skill this conversation uses could not be opened. Check the file, or turn it off.'
      case 'SKILL_LIMIT_EXCEEDED':
        return `A conversation can run at most ${MAX_ACTIVE_SKILLS} skills. Turn one off first.`
      default:
        return error.message
    }
  }
  return 'The response stream ended unexpectedly.'
}

/**
 * What the Auto-approve shield says about itself, wherever it is offered.
 *
 * One wording for both of the controls that carry the setting — the switch in the header and the chip at
 * home — because they are one setting, and a user who read one of them should not have to doubt the
 * other. The exception is appended in *both* positions rather than only while the switch is on: a call to
 * a running MCP server is not covered by this control either way, and naming that only in the on state
 * would let the off state read as though nothing could ever run without asking.
 */
export function autoApproveHelperText(on: boolean): string {
  const base = on
    ? 'Writes and commands run without asking. Reads are always allowed.'
    : 'Each write and command waits for your approval.'
  return `${base} Built-in tools only — MCP servers ask unless their own auto-approve is on.`
}

/**
 * What the header says when the Buddy is fixed for the conversation on screen.
 *
 * One sentence, and both halves of it are load-bearing. The first says the disabled control is a rule
 * rather than a fault — a control that simply refuses reads as broken — and it names the way out, which is
 * a new chat, because switching inside a conversation is never offered: the role and the server subset were
 * snapshotted onto the record when the conversation started, so a switch would leave the turns already run
 * and the turns still to come answering as two identities. The second half scopes the word *fixed* to the
 * one thing it covers: the model and the consent control beside it stay live, and a caption that did not
 * say so would read as though the whole row had gone dead.
 */
export const BUDDY_LOCK_CAPTION =
  'Fixed for this conversation — a new chat can pick another; the model and auto-approve stay yours to change.'

/**
 * The mark a Buddy entry is drawn with: the app's own logo where an entry is the app itself, and the
 * record's own glyph in the badge the Buddies list draws it in for every Buddy.
 *
 * `null` rather than a separate flag, because `null` is already how this screen reads the default: an id
 * that resolves to no record is the Agent Sam entry, and it is the one entry with no record to carry a
 * character of its own. The mark is then the app's logo from the renderer's own path in the repo — the same
 * file the window, the installers and the app's icon are built from, so a default entry and the app cannot
 * end up with two different marks.
 *
 * One element for both places it is drawn, because the trigger and the list it opens show the same entry
 * twice: a trigger that marked a Buddy differently from the row it was picked from would be two marks for
 * one entry. The badge is the settings list's own — the same square, the same muted surface, the same
 * monospace character — read at this row's height, which is the shorter of the two rows the app draws a
 * Buddy in.
 *
 * Both forms are decoration and both are drawn that way: the name stands beside them, so the logo is given
 * no description and the badge is hidden from the accessibility tree. That is what keeps an entry's name
 * the name a reader and a screen reader find it by, rather than a character read out ahead of it.
 */
function BuddyAvatar({ glyph }: { glyph: string | null }) {
  if (glyph === null) {
    return <img src={samMark} alt="" data-slot="buddy-avatar-logo" className="size-4.5 shrink-0 rounded-md" />
  }

  return (
    <span
      data-slot="buddy-avatar-glyph"
      aria-hidden="true"
      className="flex size-4.5 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[10px] font-medium"
    >
      {glyph}
    </span>
  )
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
 *
 * With no conversation open the pane is the home screen, and it is the same pane: the composer keeps
 * its place and its state, and the space above it — which is where a transcript would be — holds the
 * headline instead, with the folder row and the ways back into the work beneath the composer. Home is
 * therefore not a second way to send anything. A message typed there goes out through this pane's own
 * send path, which is what creates the conversation, and the screen is left the moment the store says
 * one exists. The control that asks for a new chat asks for *this*: nothing is created until words are,
 * so no empty conversation is left behind in the list.
 */
export function ChatPanel() {
  const activeProviderId = useWorkbenchStore((s) => s.activeProviderId)
  const activeModel = useWorkbenchStore((s) => s.activeModel)
  const setTarget = useWorkbenchStore((s) => s.setTarget)
  // The two window controls a command stands for, read from the store those controls themselves read:
  // `/terminal` and the title bar's glyph flip one flag, so the two cannot come to disagree.
  const toggleBottomPanel = useWorkbenchStore((s) => s.toggleBottomPanel)
  const openSettingsAt = useWorkbenchStore((s) => s.openSettingsAt)
  // The light/dark toggle, from the store the title bar's own glyph writes to: one preference, and a
  // command that flipped a second copy of it would be a command that disagreed with the glyph.
  const toggleThemeMode = useThemeStore((s) => s.toggle)
  // The file the code viewer has open, which the attach control adds as a mention.
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  // How a conversation is drawn, from the store the Appearance section writes to: the pane is the reader
  // and the section is the writer, so one preference reaches the bubble that it is about rather than a
  // copy kept here. Read as two scalars, so a change to either one re-renders the pane and a memoised
  // bubble is told about it by a primitive that changed rather than by an object rebuilt each render.
  const appearanceAlignment = useConveyorStore(appearancePreferencesStore, (s) => s.alignment)
  const appearanceFontPreset = useConveyorStore(appearancePreferencesStore, (s) => s.fontPreset)

  // Sessions own the transcript: it is shared with the panel (which saves it before a switch) and
  // persisted at turn boundaries. The pane reads and replaces it, but does not hold it.
  const sessions = useChatSessionsContext()
  const messages = sessions.transcript.turns

  /**
   * The plan the checklist shows: the newest one this conversation declared, if any.
   *
   * Derived from the turns rather than held beside them, so there is exactly one place a plan lives
   * and one thing to keep in step. `null` is the ordinary case — most conversations need no plan — and
   * the checklist renders nothing for it.
   */
  const plan = currentPlan(messages)

  /**
   * The turn-end notice the card shows: the last turn's, when it stopped early.
   *
   * Derived from the transcript for the same reason the plan is, and that is also what settles the
   * one question the card has to answer: whether to offer the button. A live run writes `resumable`
   * onto the turn; a transcript read back from disk never does, so a reopened conversation shows the
   * reason and nothing to click.
   */
  const endNotice = currentEndNotice(messages)

  /**
   * The composer's in-progress state, read from the session layer rather than held here.
   *
   * The workbench keys its resize groups on the window state, so a maximize or a restore remounts this
   * pane — and everything the user had not sent yet went with it. Held above the key, it survives the
   * swap: the draft, the chips attached to it, the note under the box and the height they dragged it to.
   * One destructure rather than four, because they are one thing from the user's side and a remount
   * restores or loses them together.
   */
  const {
    text: draft,
    mentionPaths,
    mentionNote,
    images: draftImages,
    attachmentNote,
    heights: composerHeights,
  } = sessions.composer

  // The session API is read through a ref so the callbacks built from it keep a stable identity: several
  // of them are dependencies of the stream callbacks, and a new identity per render would restart a run on
  // every chunk — exactly what this pane is built to avoid.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  /**
   * Write the draft through the session layer, keeping the ref this pane's own handlers read in step.
   *
   * The mirror is what a handler writing twice in one event reads back — the picker committing a path and
   * then removing the token it came from — without the write having to wait for a re-render.
   */
  const draftRef = useRef(draft)
  draftRef.current = draft
  const setDraft = useCallback((next: string) => {
    draftRef.current = next
    sessionsRef.current.setComposer({ text: next })
  }, [])

  /** The heights a drag writes, mirrored for the same reason `draftRef` is. */
  const composerHeightsRef = useRef(composerHeights)
  composerHeightsRef.current = composerHeights

  /**
   * The images the next send will attach, mirrored for the same reason the draft is.
   *
   * A gesture that takes three files writes three times in one event, and each write has to see what the
   * one before it left — otherwise two of the three would be appended to the same empty list and one
   * would be lost.
   */
  const draftImagesRef = useRef<DraftAttachment[]>(draftImages)
  draftImagesRef.current = draftImages

  /** The picker's input, opened by the button rather than rendered as a visible control. */
  const attachInputRef = useRef<HTMLInputElement>(null)

  // Whether a run is in flight, read from the session layer rather than held here: a session click has
  // to be refused against it, and the list that offers the click is not inside this pane. Above the
  // pane it also survives a window-state swap, which used to reset a flag about a run still going.
  const isStreaming = sessions.streaming
  const setIsStreaming = sessions.setStreaming
  // Whether the agent acts without asking. Read from the session rather than held here: the record owns
  // the setting, so a conversation that had it on opens with it on, and one that has never had it set
  // opens with it off.
  const autoApprove = sessions.autoApprove
  /**
   * Whether the pane is on the home screen — no conversation open, which is where a launch with nothing
   * to resume begins. Read from the session layer rather than derived here, because it is a state of the
   * window rather than a view of this component.
   */
  const atHome = sessions.atHome
  /** The pause of the conversation on screen, which is the only one the pane may act on. */
  const pending = (sessions.openId ? sessions.pauses[sessions.openId] : undefined) ?? null

  /**
   * The Buddy the header names: the conversation's own once one is open, the pending choice while home.
   *
   * Two sources rather than one, because they are two different facts and the lock between them is the
   * difference: before a send there is a choice that can still change, and after it there is a record
   * that cannot. Null is the Agent Sam default in both places, which is a state of the control rather than a
   * Buddy that has no label.
   */
  const buddyId = atHome ? sessions.pendingBuddyId : sessions.buddyId
  /**
   * The user's own Buddies, and the ones switched off.
   *
   * Defaulted while the mirror is quiet: the store's state arrives a tick after this pane mounts, and
   * until it does the list is the app's own three with nothing switched off — which is what a user who has
   * never made a Buddy sees anyway, rather than a blank control or a crash.
   */
  const customBuddies = useConveyorStore(buddiesStore, (s) => s.custom) ?? []
  const disabledBuddies = useConveyorStore(buddiesStore, (s) => s.disabledIds) ?? []
  /**
   * The rows the Select offers: the Agent Sam default first, then every Buddy that is switched on.
   *
   * Built-ins before custom records, in the order `listBuddies` returns them, because that rule is what
   * says what a list's order is and a picker that sorted again would be a second answer to it. A
   * switched-off Buddy is absent rather than disabled here: this is the one list that offers a choice and
   * not a switch, so a row nobody may pick would be a row that does nothing.
   */
  const buddyRows = listBuddies({ custom: customBuddies, disabledIds: disabledBuddies }).filter((row) => row.enabled)
  /** What the Select draws, and what the starters below are read from: which of the three labels an id gets. */
  const buddyName = buddyLabel(buddyId, customBuddies)
  /**
   * What home offers as a way in: the chosen Buddy's own starters when it declares any, and the app's
   * three when it is Agent Sam or a Buddy that offers none.
   *
   * Resolved rather than read off a record the header already found, because the two questions differ: a
   * Buddy deleted since is a conversation that runs under the role it was created with, and a home choice
   * that resolves to nothing offers exactly what the default offers.
   */
  const chosenBuddy = resolveBuddy(buddyId, customBuddies)
  /**
   * The mark the trigger draws beside that name: the app's own for the default, the record's own glyph for
   * a Buddy.
   *
   * The default is read off the id rather than off the resolution, because the two answers that resolve to
   * nothing are not the same entry: a conversation that named nobody draws the logo, and one whose Buddy
   * was deleted since draws the first letter of the label standing in its place. Without the id there the
   * second case would borrow the app's own mark and read as a conversation nothing ever chose.
   */
  const selectedGlyph =
    buddyId === null || buddyId === SAMAI_BUDDY_ID ? null : (chosenBuddy?.glyph ?? buddyName.slice(0, 1))

  const starters = chosenBuddy !== null && chosenBuddy.starters.length > 0 ? chosenBuddy.starters : HOME_STARTERS

  /**
   * Whether the controls that act on a message are available: the edit, and the regenerate.
   *
   * Not while a run is in flight: that run is writing the very turns either control would remove, and it
   * would go on writing them into a transcript that no longer has the message it is answering. Not
   * while a decision is pending either, for the same reason — a pause has not ended its turn, so the
   * conversation is still moving.
   *
   * Derived rather than stored, so it cannot be missed at one of the places the pane starts or ends a
   * run: it is true exactly when nothing is happening. One value for both controls because they rest on
   * the same fact, and two ways of answering it could disagree.
   */
  const editAllowed = !isStreaming && pending === null

  /**
   * The files the next send will attach, with the ref `send` reads.
   *
   * Renderer-local in effect and session-owned in fact: the list belongs to what the user is composing,
   * and the ref beside it is what `send` reads, so the payload is built from the chips that are on
   * screen without re-creating the send callback on every keystroke.
   */
  const mentionPathsRef = useRef<string[]>(mentionPaths)
  mentionPathsRef.current = mentionPaths
  /**
   * The `@` token at the caret, and whether the picker has been dismissed for it.
   *
   * One piece of state rather than two: a dismissal belongs to a token, and keeping them apart is how
   * a picker reopens itself after the user has just pressed Escape.
   */
  const [mention, setMention] = useState<{ token: MentionToken | null; dismissed: boolean }>({
    token: null,
    dismissed: false,
  })
  const [pickerIndex, setPickerIndex] = useState(0)
  /**
   * The `/` token the draft opens with, and whether the picker has been dismissed for it.
   *
   * The same shape as the mention state above, and for the same reason: a dismissal belongs to one
   * token, which is what lets an edited query open the picker again while an Escape keeps it shut.
   */
  const [command, setCommand] = useState<{ token: ComposerCommandToken | null; dismissed: boolean }>({
    token: null,
    dismissed: false,
  })
  const [commandIndex, setCommandIndex] = useState(0)
  /**
   * What the last command said, until the user writes again.
   *
   * Panel state rather than session state, deliberately: `/help` and `/version` are answers to a
   * keystroke rather than part of the conversation, so there is nothing here to save, resume or send.
   */
  const [commandNotice, setCommandNotice] = useState<CommandNoticeText | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The pane itself, for the ceiling on a drag: the limit is a share of how tall the chat column
  // actually is, and only the DOM knows that number.
  const paneRef = useRef<HTMLDivElement>(null)

  /**
   * A click inside the composer must not dismiss a picker: the user is still typing the sentence the
   * token belongs to, and a picker that closes when you click your own caret is unusable. Shared by
   * both pickers, which differ in what they list and not in where a click is allowed to land.
   */
  const keepComposerClicks: ComponentProps<typeof PopoverContent>['onInteractOutside'] = (event) => {
    const target = event.detail?.originalEvent?.target as Node | null | undefined
    if (target && composerRef.current?.contains(target)) event.preventDefault()
  }

  /**
   * The drag in progress: which session it is measured against, and where the pointer and edge began.
   *
   * The one piece of composer state that stays here, because it is a pointer that is currently down:
   * there is no drag to restore after a swap, only a drag that has ended.
   */
  const [composerDrag, setComposerDrag] = useState<{ key: string; startY: number; startHeight: number } | null>(null)
  // Which session the pane is showing. The composer's height is keyed by it, so a drag belongs to the
  // conversation it was made in rather than to the pane.
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)
  // Before the first session exists the composer is still draggable, and the height it is given then is
  // kept under the empty key. A session with none of its own falls back to that one, which is what stops
  // the composer from snapping back to its opening height the moment the first message creates a session.
  const composerKey = activeSessionId ?? ''
  const composerHeight = composerHeights[composerKey] ?? composerHeights[''] ?? COMPOSER_MIN_HEIGHT

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
  /**
   * Whether the piece of prose now being buffered follows a card rather than more prose.
   *
   * Set when the buffer starts, because that is when the seam is known: text that lands on top of text
   * already buffered is the same piece. A card drains the buffer before it is applied, so a piece
   * starting after one begins an empty buffer — which is exactly the case this marks.
   */
  const breakRef = useRef(false)
  // The live iterator, so the Stop button can cancel at the source.
  const iteratorRef = useRef<AsyncIterator<unknown> | null>(null)

  const providers = conveyor.settings.listProviders.useQuery()
  // The seeded catalogue: what to offer before a provider has ever been fetched.
  const defaultModels = conveyor.settings.defaultModels.useQuery()

  // The user's intent, from the persisted store: the dropdown offers exactly these.
  const configs = useConveyorStore(providerConfigStore, (s) => s.providers)

  // The providers the user added, in the order they added them. Read from the same store Settings
  // writes, so the picker and the screen that fills it can never disagree about what exists.
  const customProviders = useConveyorStore(providerConfigStore, (s) => s.customProviders)

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

  /**
   * The models a provider the user added offers, by the same rule a predefined one follows: what the
   * user switched on, and the catalogue itself while nothing has been switched on.
   *
   * The same rule rather than "all of them", because the switches in Settings have to mean something
   * here: a box whose toggles changed nothing would be a control that lies. A provider with no models
   * and nothing switched on yields an empty list, which is the case the picker names rather than drops.
   */
  const customModelsFor = (provider: CustomProvider): string[] => {
    const enabled = configs[provider.id]?.enabledModels
    if (enabled && enabled.length > 0) return enabled
    return provider.models
  }

  /**
   * The descriptor this run goes out with, or undefined when the pick is a built-in provider.
   *
   * Undefined rather than an empty descriptor, because the two are different facts to main: absent
   * means the built-in table answers for the id, while a descriptor is a statement about this turn's
   * provider that overrides the table.
   */
  const runProvider = customProviders.find((provider) => provider.id === activeProviderId)
  const isKeyMissing = configured.data !== undefined && !configured.data.includes(activeProviderId)

  //
  // Mentions: the `@` picker's source, and the chip row it fills.
  //
  // The paths come from the registered query and are never touched by the disk here — main walks the
  // open folder and returns names, which is the only shape the renderer ever sees. Filtering is
  // client-side because the list is already bounded by the walk's own cap, and a round trip per
  // keystroke would be a query storm for a substring test.
  //
  // Commands: the `/` picker's rows, from the pure registry rather than from a query — the set is
  // fixed, and only which of it is available here changes. The index is clamped rather than reset by an
  // effect, for the reason the mention picker's is: narrowing the query can leave the index past the
  // end, and deriving the active row keeps the render and the selection in step without a second render.
  const commandRows = command.token ? filterComposerCommands(command.token.query, { atHome }) : []
  const commandOpen = command.token !== null && !command.dismissed
  const activeCommandIndex = commandRows.length === 0 ? 0 : Math.min(commandIndex, commandRows.length - 1)

  const mentionFiles = conveyor.mentions.listFilesFlat.useQuery()
  const allMentionFiles = mentionFiles.data ?? []
  const mentionMatches = mention.token ? filterMentionPaths(allMentionFiles, mention.token.query) : []
  // A draft that opens with `/` is a command line, so the `@` picker stands down while one is showing:
  // two popovers anchored to one composer would be two answers to one keystroke, and the command line is
  // the token the user is actually typing.
  const pickerOpen = mention.token !== null && !mention.dismissed && !commandOpen
  // Clamped rather than reset by an effect: narrowing the query can leave the index past the end, and
  // deriving the active row keeps the render and the selection in step without a second render.
  const activePickerIndex = mentionMatches.length === 0 ? 0 : Math.min(pickerIndex, mentionMatches.length - 1)

  // The skills the composer can offer, from the registered query: main scans the four folders a skill
  // may live in and hands back what it found, tier by tier. A session stores ids, so the titles behind
  // the chips are looked up from this answer rather than carried on the record.
  //
  const skillsQuery = conveyor.skills.listSkills.useQuery()
  const skillListing = skillsQuery.data ?? NO_SKILLS
  // The picker draws two groups rather than four blocks — a toggle is the same toggle whichever folder
  // a skill came from, and the picker is for choosing rather than for auditing — so the tiers are
  // flattened back into their scopes here, in tier order, which keeps the precedence visible as order
  // when the same id exists in two folders.
  //
  // A skill the user switched off is dropped here, at the one place the picker is fed from: availability
  // is a decision about what may be chosen, and a row that could be chosen would contradict it. The scan
  // still reports it, because the settings screen needs it to offer the switch back.
  const projectSkills = useMemo(
    () => offeredSkills(scopeSkills(skillListing.tiers, 'project'), skillListing.disabled),
    [skillListing]
  )
  const userSkills = useMemo(
    () => offeredSkills(scopeSkills(skillListing.tiers, 'user'), skillListing.disabled),
    [skillListing]
  )
  const activeSkillIds = sessions.activeSkillIds
  const skillChips = activeSkillIds.map((id) => ({ id, title: activeSkillTitle(skillListing, id) }))

  /** Replace the chip row, keeping the ref `send` reads in step with what is on screen. */
  const setChips = useCallback((next: string[]) => {
    mentionPathsRef.current = next
    sessionsRef.current.setComposer({ mentionPaths: next })
  }, [])

  /**
   * Attach one path, or say why it could not be attached.
   *
   * Both refusals — already attached, and the cap — leave the chips untouched and report themselves
   * under the composer. A refusal that changed nothing but said nothing would read as a dead control.
   */
  const applyMentionPath = useCallback(
    (path: string) => {
      const applied = addMentionPath(mentionPathsRef.current, path)
      setChips(applied.paths)
      sessionsRef.current.setComposer({ mentionNote: applied.refused ? mentionRefusalNote(applied.refused) : null })
    },
    [setChips]
  )

  /**
   * Take one file from the picker.
   *
   * The `@` and what was typed after it are removed from the draft, so the token becomes the chip
   * rather than staying in the message as a fragment of a path. The caret is put where the token
   * began, and focus stays in the composer: the user is mid-sentence and must not have to click back
   * in to finish it.
   */
  const chooseMention = useCallback(
    (path: string) => {
      const token = mention.token
      applyMentionPath(path)
      if (token) {
        setDraft(draftRef.current.slice(0, token.start) + draftRef.current.slice(token.end))
        requestAnimationFrame(() => {
          const area = textareaRef.current
          if (!area) return
          area.focus()
          area.setSelectionRange(token.start, token.start)
        })
      }
      setMention({ token: null, dismissed: false })
    },
    [applyMentionPath, mention.token, setDraft]
  )

  /** Add whatever the code viewer has open. Disabled when nothing is open, so the guard is a UI fact too. */
  const attachOpenFile = useCallback(() => {
    if (!selectedFile) return
    applyMentionPath(selectedFile)
  }, [applyMentionPath, selectedFile])

  const removeMention = useCallback(
    (path: string) => {
      setChips(removeMentionPath(mentionPathsRef.current, path))
      sessionsRef.current.setComposer({ mentionNote: null })
    },
    [setChips]
  )

  /** Replace the image row, keeping the ref this pane's own handlers read in step. */
  const setImages = useCallback((next: DraftAttachment[]) => {
    draftImagesRef.current = next
    sessionsRef.current.setComposer({ images: next })
  }, [])

  /**
   * Take files into the draft: the one path every capture gesture goes through.
   *
   * Paste, drop and the picker differ in how a file arrives and in nothing else, so they cannot come to
   * disagree about what is acceptable. The capability gate is asked once for the gesture rather than once
   * per file — the answer does not vary by file, and a drop of four images should not say the same
   * sentence four times.
   *
   * The bytes are read here, which is the only moment they are available: a `File` is a handle on a file
   * that may be gone by the time a send happens, so what the draft holds is the bytes themselves. Reading
   * them is also what makes a later refusal possible to report without having taken anything — nothing is
   * appended until every read has completed and the rules have passed.
   */
  const takeImages = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return

      if (!composerAcceptsImages(configs[activeProviderId])) {
        sessionsRef.current.setComposer({ attachmentNote: imageCapabilityNotice(providerName) })
        return
      }

      void (async () => {
        const candidates = await Promise.all(
          files.map(async (file) => ({
            // A pasted screenshot arrives under a generated name in some browsers and an empty one in
            // others, and a chip with no text is a chip nobody can tell from another.
            name: file.name.trim() === '' ? 'Pasted image' : file.name,
            mimeType: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          }))
        )

        let next = draftImagesRef.current
        let notice: string | null = null
        for (const candidate of candidates) {
          // One at a time, against the growing list: the cap is the message's, so the fourth file of a
          // drop may be taken while the fifth is refused, and a batch that passed the list whole would
          // let twenty through.
          const applied = addDraftAttachment(next, candidate)
          next = applied.draft
          // The *first* refusal is the one kept, because it is the one that names the boundary: a drop of
          // six images refused on the fifth says which one was too many, while the last refusal would
          // name the end of the list and leave the user to work out where the cut fell.
          if (applied.notice && notice === null) notice = applied.notice
        }

        // The row is written even when nothing was taken, because a refusal replaces the note the last
        // gesture left and a success clears it — one write, one sentence, either way.
        setImages(next)
        sessionsRef.current.setComposer({ attachmentNote: notice })
      })()
    },
    [activeProviderId, configs, providerName, setImages]
  )

  /**
   * A paste into the composer.
   *
   * A paste carrying no file is left alone entirely — not prevented, not reported — because that is a
   * user pasting prose, which is the ordinary case and none of this feature's business. An image is not
   * text, so the default is prevented: pasting an image's *name* into the sentence would be noise the
   * user did not ask for, and the chip is what they meant instead.
   */
  const onComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesIn(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    takeImages(files)
  }

  /**
   * A drop onto the composer.
   *
   * `dragover` is prevented so the drop is allowed at all — a browser refuses a drop on an element that
   * has not said it will take one, and the textarea would otherwise be treated as an ordinary text drop
   * target and swallow an image. What is accepted is every file the drop carries rather than only the
   * images: a dropped type this app cannot send is refused with the rule's own sentence naming the type,
   * which tells the user more than a drop that silently did nothing.
   */
  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer) return
    event.preventDefault()
  }

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = filesIn(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    takeImages(files)
  }

  /** What the picker was given, cleared so choosing the same file twice is still a change it reports. */
  const onAttachPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = filesIn(event.currentTarget)
    event.currentTarget.value = ''
    takeImages(files)
  }

  const removeImage = useCallback(
    (id: string) => {
      // The chip's own object URL goes with the chip: the row stops rendering it, React unmounts it, and
      // the effect that made the URL revokes it. Nothing here has to know about URLs at all.
      setImages(removeDraftAttachment(draftImagesRef.current, id))
      sessionsRef.current.setComposer({ attachmentNote: null })
    },
    [setImages]
  )

  /** The token the caret is in, if any. Called on every edit and every caret move, not only on `@`. */
  const syncMention = useCallback((text: string, caret: number) => {
    setMention((previous) => {
      const token = activeMentionToken(text, caret)
      if (token === null) {
        return previous.token === null && !previous.dismissed ? previous : { token: null, dismissed: false }
      }
      // A dismissal is about one token. Typing a new `@` is a new intent, and the picker speaks again.
      const dismissed = previous.dismissed && previous.token !== null && previous.token.start === token.start
      const unchanged =
        previous.token !== null &&
        previous.token.start === token.start &&
        previous.token.end === token.end &&
        previous.token.query === token.query &&
        previous.dismissed === dismissed
      return unchanged ? previous : { token, dismissed }
    })
  }, [])

  const dismissPicker = useCallback(() => {
    setMention((previous) => (previous.token === null ? previous : { token: previous.token, dismissed: true }))
  }, [])

  /**
   * The token the draft opens with, if any. Called on every edit, like the `@` sync above it.
   *
   * A command has no caret to follow: it is the whole draft, and the picker cannot belong to a word
   * inside it — so text is the only input this reads.
   */
  const syncCommand = useCallback((text: string) => {
    setCommand((previous) => {
      const token = parseComposerCommand(text)
      if (token === null) {
        return previous.token === null && !previous.dismissed ? previous : { token: null, dismissed: false }
      }
      // A dismissal is about one token. Editing the word is a new intent, and the picker speaks again.
      const dismissed = previous.dismissed && previous.token !== null && previous.token.query === token.query
      const unchanged =
        previous.token !== null && previous.token.query === token.query && previous.dismissed === dismissed
      return unchanged ? previous : { token, dismissed }
    })
  }, [])

  const dismissCommandPicker = useCallback(() => {
    setCommand((previous) => (previous.token === null ? previous : { token: previous.token, dismissed: true }))
  }, [])

  /** Ask main what version this is, and show the answer where the command was typed. */
  const showVersion = useCallback(async () => {
    try {
      const version = await conveyor.system.version()
      setCommandNotice({ title: 'Version', lines: [version] })
    } catch {
      // A query that could not be answered says so rather than showing a number nobody vouched for.
      setCommandNotice({ title: 'Version', lines: ['The version could not be read.'] })
    }
  }, [])

  /**
   * Run one command.
   *
   * The token is consumed first, by its own bounds, so the draft ends empty: a command is not a
   * message, and the word it was typed as must not be left behind for the next Enter to send. Then one
   * switch over the actions the rest of the window already uses — the same store calls the title bar's
   * glyph and the rail's settings control make, rather than copies of them, so a command cannot come to
   * mean something slightly different from the control it stands for.
   */
  const runCommand = useCallback(
    (id: ComposerCommandId) => {
      const token = command.token
      if (token) setDraft(draftRef.current.slice(0, token.start) + draftRef.current.slice(token.end))
      setCommand({ token: null, dismissed: false })
      setCommandNotice(null)

      switch (id) {
        case 'new':
          sessionsRef.current.goHome()
          return
        case 'terminal':
          toggleBottomPanel()
          return
        case 'settings':
          openSettingsAt('providers')
          return
        case 'mcp':
          openSettingsAt('mcp-servers')
          return
        case 'skills':
          openSettingsAt('skills')
          return
        case 'theme':
          toggleThemeMode()
          return
        case 'help':
          setCommandNotice(commandHelp(atHome))
          return
        case 'version':
          void showVersion()
          return
      }
    },
    [atHome, command.token, openSettingsAt, setDraft, showVersion, toggleBottomPanel, toggleThemeMode]
  )

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 8,
  })

  const updateMessages = useCallback((next: AgentTurn[]) => {
    messagesRef.current = next
    // Through the session layer, not local state: this is the transcript that gets saved. Turns are all
    // this names, which is what keeps a run's own write from dropping a choice the run never touched —
    // the consent setting is written by the toggle, and nothing here can reach it to lose it.
    sessionsRef.current.setTurns(next)
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
    // Read and cleared together: the mark belongs to the piece being flushed, and the next piece
    // decides for itself.
    const paragraph = breakRef.current
    breakRef.current = false
    const turnId = streamingTurnIdRef.current
    if (turnId === null) return
    const { turns } = applyAgentChunk(messagesRef.current, turnId, { type: 'text_delta', text: chunk, paragraph })
    updateMessages(turns)
    stickToBottom()
  }, [stickToBottom, updateMessages])

  /**
   * Queue text. Calls inside one frame coalesce into a single render.
   *
   * `paragraph` says whether this text starts a new piece of narration — true when a card landed since
   * the last one. It is recorded only when the buffer is empty, so a coalesced run of chunks is one
   * piece and takes at most one break.
   */
  const enqueue = useCallback(
    (chunk: string, paragraph: boolean) => {
      if (bufferRef.current === '') breakRef.current = paragraph
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
  }, [setIsStreaming])

  /**
   * Drive one agent stream to its end.
   *
   * Every chunk is handed to the reducer, which owns what the transcript looks like. The only chunk
   * with a side effect is the pause: it stops this stream and records what is needed to continue.
   */
  const runStream = useCallback(
    async (stream: AsyncIterable<unknown>, turnId: string, sessionId: string) => {
      const iterator = stream[Symbol.asyncIterator]()
      iteratorRef.current = iterator
      setIsStreaming(true)

      // Whether this run stopped to ask something rather than ending. A pause ends the stream but not
      // the turn — the decision resumes it — so the plan must be left alone for the checklist above,
      // while every other way out of this loop ends the turn and reconciles it.
      let paused = false
      // Whether the chunk before this one was prose. The first piece of a run is not a continuation of
      // anything in this stream, so it opens a piece of its own: after a resume the model's prose
      // follows a tool result, and the rule ignores a leading break on an empty message.
      let narration = false

      try {
        for (;;) {
          const { value, done } = await iterator.next()
          if (done) break

          const chunk = value as Record<string, unknown>
          // Text is buffered for the frame; everything else applies immediately, because a card or a
          // pause is a discrete event and should not wait on a frame.
          if (chunk.type === 'text_delta' && typeof chunk.text === 'string') {
            enqueue(chunk.text, !narration)
            narration = true
            continue
          }

          // What the round-trip cost, handed to the store rather than drawn here.
          //
          // The agent yields this once per model call, and only when the provider reported counters — so
          // a provider that reports nothing sends no frame at all, and the session keeps the absence the
          // Overview draws an em dash for rather than acquiring a zero. It is recorded against the id
          // this stream was started for rather than the store's active id, which a user may have moved
          // on from mid-turn, and it is not prose: the run continues, so this is a `continue` rather than
          // a card. The counters are read off the frame defensively because what arrived is a decoder's
          // output, not this app's type.
          if (chunk.type === 'usage') {
            // The counters are read one key at a time rather than cast: the frame crossed the bridge,
            // so what is in hand is a decoded value and not this app's type, and the store's schema —
            // not this loop — is what bounds a counter. A frame carrying no usable counters is dropped
            // exactly as the agent would have dropped it, by not sending one.
            const prompt = chunk.prompt
            const completion = chunk.completion
            if (typeof prompt === 'number' && typeof completion === 'number') {
              sessionsRef.current.recordUsage(sessionId, {
                prompt,
                completion,
                ...(typeof chunk.cached === 'number' ? { cached: chunk.cached } : {}),
              })
            }
            continue
          }

          // Anything else is a card or a pause: a discrete event that ends the current piece of prose
          // and should not wait on a frame. The drain comes first so the piece is complete before the
          // card it refers to is applied.
          narration = false
          drainNow()
          const { turns, effect } = applyAgentChunk(messagesRef.current, turnId, chunk)
          updateMessages(turns)

          if (effect.contextNotice) {
            // A file the send named that could not be included. Written onto the turn as a warning row
            // rather than thrown: the message went out without it, and that is the news.
            updateMessages(noteContextSkip(messagesRef.current, turnId, effect.contextNotice))
          }

          if (effect.approval) {
            // The pause is recorded under the conversation it belongs to, and it is recorded in the
            // session layer rather than here. Both halves matter: a load of this conversation must leave
            // the pause standing, and a load of any other must reconcile the pauses whose process is
            // gone. Held above the pane because the pane is not the conversation — a maximize remounts
            // every pane, and a decision the user has been asked for must outlive that — and recorded
            // rather than merely set, because the pane may be showing a different conversation by the
            // time the user answers.
            const { approval } = effect
            sessionsRef.current.holdPause({
              sessionId,
              turnId,
              callId: approval.callId,
              tool: approval.tool,
              messages: approval.messages,
              calls: approval.calls,
              steps: approval.steps,
              continuations: approval.continuations,
              plan: approval.plan,
            })
            // The stream is over as far as this call is concerned; the run continues on the decision.
            paused = true
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
        // The turn is over — answered, failed, or stopped — so a plan that still claims a step is in
        // progress is corrected here, at the one place every ending passes through, and a plan with
        // work left on it gets the notice it has earned. A pause is the exception, because the turn it
        // belongs to has not ended.
        if (!paused) updateMessages(endTurn(messagesRef.current, turnId))
      }
    },
    [drainNow, enqueue, providerName, setIsStreaming, stickToBottom, updateMessages]
  )

  /**
   * Drive one agent turn on a history that is already settled.
   *
   * The one entry every run starts through. A message sent from the composer and a reply regenerated
   * differ in what they hand over and in nothing else: both need the same turn opened, the same stream
   * driven to its end, the same plan reconciled when it ends and the same save at the boundary. A second
   * copy of that for the regenerate would be a second place for the payload to drift, and it is the run
   * the user gets that would differ.
   *
   * The turns are the transcript this run continues from, already carrying the message it is answering
   * — a new one for a send, the one the discarded reply answered for a regenerate. The provider-shaped
   * history is read from them, text-only: the agent owns the history with its tool turns and hands it
   * back on a pause, so rebuilding that here would be a second source of truth. `mentionPaths` goes out
   * exactly as a send carries it, which is what lets a file attached to the message being answered be
   * read again on a regenerate.
   */
  const runAgentTurn = useCallback(
    async (turns: AgentTurn[], mentionPaths: readonly string[], sessionId: string) => {
      // A turn is this conversation being used in this window's folder, so its start is what the project
      // is recorded from — and only when that differs from the folder already stored.
      sessionsRef.current.stampRoot(sessionId)

      const assistantTurn = startAssistantTurn()
      streamingTurnIdRef.current = assistantTurn.id
      updateMessages([...turns, assistantTurn])
      requestAnimationFrame(stickToBottom)

      await runStream(
        conveyor.agent.chatWithTools({
          providerId: activeProviderId,
          model: activeModel,
          // The descriptor of a provider the user added, when this is one. Absent for a built-in, whose
          // route main already knows by id.
          provider: runProvider,
          messages: toHistory(turns),
          workspaceRoot: rootPath,
          autoApprove,
          // The conversation this turn belongs to, which is where a stored image's bytes live: a
          // reference names an id inside that conversation's folder, so this is what lets main resolve
          // the images in the history above at the request it is about to build.
          sessionId,
          // Paths only. Main reads the files and appends the context section, so the renderer never
          // carries file contents and a path the user attached is the only thing crossing this boundary.
          // Copied rather than handed over as it stands: the chips are read-only where they came from,
          // and the payload is the wire's own array.
          mentionPaths: mentionPaths.length > 0 ? [...mentionPaths] : undefined,
          // Ids only, for the same reason the paths above are paths: main reads each `SKILL.md` at the
          // turn start, so what the model is told is the file as it is now rather than what the
          // renderer happened to load. Read through the ref rather than closed over, because a skill
          // turned on since this callback was built belongs to the turn about to be sent — the toggle
          // changes the next turn, and this is the next turn.
          activeSkillIds:
            sessionsRef.current.activeSkillIds.length > 0 ? [...sessionsRef.current.activeSkillIds] : undefined,
          // And what this conversation runs as, read off the record through the ref for the same reason:
          // a conversation created as a Buddy runs as it for every turn, not only its first. Both are
          // left out rather than sent as null when there is nothing to say — a conversation created
          // without a Buddy sends the request it always sent, key for key.
          rolePrompt: sessionsRef.current.buddyRolePrompt ?? undefined,
          mcpSubset: sessionsRef.current.buddyMcpSubset ?? undefined,
        }),
        assistantTurn.id,
        sessionId
      )

      // A turn boundary: what was sent and the reply to it are now a complete unit, so this is when the
      // transcript is worth writing. Never per token — the run above may have produced hundreds of
      // chunks, and this is one save.
      sessionsRef.current.scheduleSave()
    },
    [activeModel, activeProviderId, autoApprove, rootPath, runProvider, runStream, stickToBottom, updateMessages]
  )

  /**
   * Put a starter prompt in the box, and nothing else.
   *
   * Written through this pane's own draft setter so the mirror a handler reads stays in step, and
   * focused so the next thing typed lands where the prompt is. Deliberately not sent: a starter is a
   * sentence to edit, and sending one on a click would put words in the user's mouth.
   */
  const prefillComposer = useCallback(
    (prompt: string) => {
      setDraft(prompt)
      textareaRef.current?.focus()
    },
    [setDraft]
  )

  const sendText = useCallback(
    async (
      raw: string,
      options: {
        mentionPaths?: readonly string[]
        images?: readonly DraftAttachment[]
        /**
         * References this message already carried, kept in front of the ones being stored now.
         *
         * A resend passes the images the message was sent with: an edit rewrites the words, and the
         * pictures are not the editor's to drop. They are already in the store, so they are not written
         * again — the message the user sees afterwards shows the same references it did before.
         */
        imageRefs?: readonly ImageAttachmentRef[]
        keepComposer?: boolean
      } = {}
    ) => {
      const text = raw.trim()
      if (!text || isStreaming || pending) return

      // The chips as they stand: the payload and the transcript both read this one list, so what is
      // sent and what the bubble shows afterwards cannot disagree. An edit passes its own, because the
      // chips it changed belong to the message being sent again rather than to the composer.
      const chips = options.mentionPaths ?? mentionPathsRef.current
      // The images for the same reason, and an edit passes references rather than bytes: the draft's own
      // images come out of the composer, and a message being sent again brings the ones it already had.
      const images = options.images ?? draftImagesRef.current
      const keptRefs = options.imageRefs ?? []
      // A resend did not come from the composer, so it must not empty it: the user's half-written next
      // message is still theirs, and the chips in it were never part of the send that just happened.
      const fromComposer = options.keepComposer !== true

      // Sending with no session open is normal: a session is created for the message, and named from
      // it. This is what makes the composer work before the user has ever touched the session list. The
      // id comes back so the run knows which conversation it belongs to — a pause it asks for is a
      // question about that conversation, and the pane has to be able to say which one it is holding.
      const sessionId = sessionsRef.current.ensureSession(text)

      // The images are stored before anything is dispatched, and the send is abandoned if one of them
      // cannot be. Two things rest on that order. The reference a transcript carries is the store's, so
      // an image has to be written before the turn that names it can be built. And a send that stored
      // two of three images and then dispatched anyway would put a message in the conversation saying
      // something the model was never given — so a failure here returns with the draft exactly as the
      // user left it, chips and all, and nothing partial is dispatched.
      //
      // Awaited one at a time and in attach order, which is what makes the references' order the user's
      // rather than the store's.
      const storedRefs: ImageAttachmentRef[] = []
      try {
        for (const request of attachmentSaveRequests(sessionId, images)) {
          storedRefs.push(await conveyor.attachments.save(request))
        }
      } catch (err) {
        sessionsRef.current.setComposer({ attachmentNote: attachmentSaveErrorMessage(err) })
        return
      }

      // The message's own images first, then the ones just stored: the order the user would describe it
      // in, and the order main resolves them in when it builds the parts.
      const imageRefs: ImageAttachmentRef[] = [...keptRefs, ...storedRefs]

      if (fromComposer) {
        setDraft('')
        // The chips belonged to that message. Main reads the paths from the payload, so clearing here
        // cannot take them away from the send that is starting — only from the next one.
        setChips([])
        // The images go with them, and so do their object URLs: the chips stop rendering, and the effect
        // that made each URL revokes it on the way out.
        setImages([])
        setMention({ token: null, dismissed: false })
        sessionsRef.current.setComposer({ mentionNote: null, attachmentNote: null })
      }

      // The message goes on the end of the transcript as it stands — after any truncation an edit made,
      // so a resend continues the conversation that is left rather than the one the removed turns
      // belonged to — and that whole list is what the run is handed.
      await runAgentTurn([...messagesRef.current, startUserTurn(text, chips, imageRefs)], chips, sessionId)
    },
    [isStreaming, pending, runAgentTurn, setChips, setDraft, setImages]
  )

  /** Send what is in the composer. */
  const sendDraft = useCallback(() => {
    void sendText(draft)
  }, [draft, sendText])

  /**
   * Send an edited message again, in place of everything that followed it.
   *
   * The cut first, then the save, then the send, in that order and awaited: what the user asked for is
   * a conversation in which the removed turns never happened, so the file is written before the new
   * message can fail. The send itself is the ordinary one — same function the composer calls — with the
   * edited text and the chips the editor was left with, which is what keeps an edited message from
   * being a second kind of message with its own way of being sent.
   *
   * The message keeps its images. They are read off the turn before the cut removes it, and they go in
   * front of whatever the composer is holding: the editor has no image controls, so a resend that left
   * them out would quietly rewrite the message into one that said less than the user's did — and the
   * draft's images follow because they are what the user is looking at while they edit.
   *
   * The pane is the only thing that can do this: it holds both the transcript and the send path, and an
   * edit that cut the transcript without knowing how to send would leave the user with a message gone.
   */
  const resendEditedMessage = useCallback(
    (turnId: string, text: string, chips: readonly string[]) => {
      void (async () => {
        const original = messagesRef.current.find((turn) => turn.id === turnId)
        const keptRefs = original?.imageRefs ?? []
        updateMessages(truncateFromTurn(messagesRef.current, turnId))
        await sessionsRef.current.saveNow()
        await sendText(text, { mentionPaths: chips, imageRefs: keptRefs, keepComposer: true })
      })()
    },
    [sendText, updateMessages]
  )

  /**
   * Answer the message again, in place of the reply being regenerated.
   *
   * The cut first, then the save, then the run, in the same order and for the same reason a resend does
   * it: what the user asked for is a conversation in which the discarded turn never happened, so the
   * record is written before the new run can fail.
   *
   * Nothing is sent on the user's behalf. The turns the cut left already end with the message that reply
   * was answering, so the run continues that conversation — appending a copy of the message would put
   * words in the user's mouth, and a regenerate is not a new question.
   *
   * The cut is at the reply itself rather than after it, by the same rule that counted the turns in the
   * dialog: the reply is what is being replaced, and it goes with everything written in answer to it.
   *
   * Only a reply is regenerated, and the pane checks the id rather than trusting it: the control lives on
   * agent bubbles, and an id that names anything else here is a stale one.
   */
  const regenerateReply = useCallback(
    (turnId: string) => {
      void (async () => {
        if (isStreaming || pending) return
        const target = messagesRef.current.find((turn) => turn.id === turnId)
        if (!target || target.role !== 'assistant') return

        const kept = truncateFromTurn(messagesRef.current, turnId)
        updateMessages(kept)
        await sessionsRef.current.saveNow()
        await runAgentTurn(kept, lastAskMentions(kept), sessionsRef.current.openId ?? '')
      })()
    },
    [isStreaming, pending, runAgentTurn, updateMessages]
  )

  /**
   * Begin a drag of the composer's top edge.
   *
   * The height the drag starts from is captured here and the pointer's movement is applied to it, rather
   * than the height being nudged per event: a drag that runs into a clamp and comes back out again then
   * returns to the height the pointer is asking for. Accumulating deltas would lose everything the pointer
   * asked for while it was pinned, and the composer would stay stuck where it had been held.
   */
  const startComposerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // The drag belongs to the edge, not to the pane: without this a drag lands as a text selection in the
    // transcript or the textarea behind it.
    event.preventDefault()
    setComposerDrag({ key: composerKey, startY: event.clientY, startHeight: composerHeight })
  }

  /**
   * Follow a drag, and end it.
   *
   * The listeners live on the window for as long as the drag lasts rather than on the handle: most drags
   * leave the few pixels the pointer started on, and a handle that listened only to itself would stop
   * resizing the moment it did.
   */
  useEffect(() => {
    if (!composerDrag) return

    const onMove = (event: PointerEvent) => {
      const bounds = composerBounds(paneRef.current?.clientHeight ?? 0)
      // Dragging up makes the composer taller, so the pointer's downward movement is subtracted.
      const requested = composerDrag.startHeight - (event.clientY - composerDrag.startY)
      const next = clampComposerHeight(requested, bounds.min, bounds.max)
      const current = composerHeightsRef.current
      if (current[composerDrag.key] === next) return
      composerHeightsRef.current = { ...current, [composerDrag.key]: next }
      sessionsRef.current.setComposer({ heights: composerHeightsRef.current })
    }
    const end = () => setComposerDrag(null)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    // A cancelled pointer — a window losing focus mid-drag — ends the drag as well, rather than leaving the
    // pane resizing itself at whatever the next move reports.
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [composerDrag])

  /**
   * Answer a pause.
   *
   * Approval resumes the run where it left off: the queue goes back whole while the decision answers
   * its head, which is how the loop knows what to present next — so consent stays per call even though
   * a frame's calls travel together.
   *
   * A denial ends the turn rather than being fed back to the model as the call's result. Feeding it
   * back meant the only way to refuse an action was to ask for another one: the two things a user wants
   * at that moment — refuse this, and stop — were the same button, and neither of them stopped the run.
   * The refusal is recorded, the frame's unanswered calls are recorded as never decided rather than
   * left waiting, and the turn ends through the one path every ending passes through, so a plan that
   * still claims a step is in progress is reconciled and the turn says how it went.
   *
   * Either way the pause is cleared before the work starts, so a second click cannot decide it twice.
   */
  const decide = useCallback(
    async (approved: boolean) => {
      const current = pending
      if (!current || isStreaming) return

      // This process is not holding the pause any more, whichever way the decision went. Said here
      // rather than beside the branches: a load of this conversation after this must reconcile nothing,
      // because there is nothing left waiting for an answer.
      sessionsRef.current.clearPause(current.sessionId)

      // Record the decision against the one call it was about. The cards queued behind it stay queued:
      // on an approval the loop is about to present the next of them, and marking them decided here
      // would claim consent the user has not given.
      const decided = resolveDecision(messagesRef.current, current.turnId, current.callId, approved)

      if (!approved) {
        // A denial ends the turn where it stands, and the calls behind the head are never put to the
        // user: they are recorded as undecided so the transcript stops showing a question waiting on a
        // run that is over. The tool-call contract is not broken by this — a turn that has ended asks
        // the model nothing further, and the next message reads the transcript as text, not as raw
        // frames — so ending here costs nothing and is the honest record of what happened. The ending
        // goes through the one turn-end path, which is what tells the user what the plan was waiting
        // on.
        updateMessages(endTurn(abandonUndecidedCalls(decided, current.turnId, ABANDONED_PAUSE_CODE), current.turnId))
        sessionsRef.current.scheduleSave()
        return
      }

      updateMessages(decided)
      streamingTurnIdRef.current = current.turnId
      requestAnimationFrame(stickToBottom)

      await runStream(
        conveyor.agent.resume({
          providerId: activeProviderId,
          model: activeModel,
          // The same descriptor the run started with: a resumed turn is the same turn, and main has to
          // route it to the same provider it was routed to before the pause.
          provider: runProvider,
          // The history the loop paused with and the model's own calls — both handed back exactly as
          // they came, so nothing is rebuilt from the display layer. The queue goes back whole while
          // the decision answers its head, which is how the loop knows what to present next.
          messages: current.messages as never,
          workspaceRoot: rootPath,
          autoApprove,
          calls: current.calls,
          steps: current.steps,
          // The plan the pause handed over, handed straight back: a resumed turn is the same turn, and
          // one that came back with no plan could not report the work it left undone.
          plan: current.plan,
          // And the auto-continuations it had already spent, for the same reason: the budget is the
          // turn's, so a permission granted midway through it must not hand the loop a fresh one.
          continuations: current.continuations,
          decision: 'approved',
        }),
        current.turnId,
        current.sessionId
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
      runProvider,
      runStream,
      stickToBottom,
      updateMessages,
    ]
  )

  /**
   * Composer keys, with a picker taking precedence while one is open.
   *
   * The popover is not focus-managed, so the arrow keys and Enter belong to the textarea: moving a
   * selection into the list would take the caret out of the sentence the token sits in. Escape closes
   * the picker without touching what was typed — the token stays as text, and the user can finish the
   * path by hand — and a second Escape is not intercepted, so it reaches the pane as usual.
   *
   * The command picker is asked first of the two, and the two can never both be open: a draft that
   * opens with `/` is a command line, and `pickerOpen` itself stands the `@` picker down for it.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandOpen && event.key === 'Escape') {
      event.preventDefault()
      dismissCommandPicker()
      return
    }

    if (commandOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const count = commandRows.length
      if (count > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1
        setCommandIndex((activeCommandIndex + step + count) % count)
      }
      return
    }

    if (commandOpen && event.key === 'Enter' && !event.shiftKey) {
      // Enter runs the highlighted command. With nothing matching there is nothing to run, and sending
      // here would post the word as a message the user was plainly not writing — so the picker closes
      // and the draft is left alone, exactly as the `@` picker leaves it.
      event.preventDefault()
      const id = composerCommandAt(commandRows, activeCommandIndex)
      if (id === null) {
        dismissCommandPicker()
        return
      }
      runCommand(id)
      return
    }

    if (pickerOpen && event.key === 'Escape') {
      event.preventDefault()
      dismissPicker()
      return
    }

    if (pickerOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const count = mentionMatches.length
      if (count > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1
        setPickerIndex((activePickerIndex + step + count) % count)
      }
      return
    }

    if (pickerOpen && event.key === 'Enter' && !event.shiftKey) {
      // Enter commits the highlighted file when there is one. With nothing matching there is nothing
      // to commit, and sending here would post a message still carrying the `@…` the user was about
      // to turn into a chip — so the picker closes and the draft is left alone.
      event.preventDefault()
      if (mentionMatches.length === 0) {
        dismissPicker()
        return
      }
      chooseMention(mentionMatches[activePickerIndex])
      return
    }

    // Enter sends; Shift+Enter is a newline, the convention for a composer.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendDraft()
    }
  }

  return (
    <div ref={paneRef} className="flex h-full flex-col bg-background">
      {/*
        The Buddy the conversation runs as, immediately after the title it belongs to: the same primitive
        as the model picker at the other end of this row, the same keyboard and pointer behavior, and the
        same discipline — a value that truncates rather than pushing the row wider, and a width bound so a
        long name cannot displace the model list.

        Enabled only while the pane is on the home screen. A conversation's Buddy is fixed the moment it
        starts, because the role and the server subset were snapshotted onto its record then, so a switch
        inside one would leave the turns already run and the turns still to come answering as two
        identities. It is drawn rather than hidden, though: what a conversation runs as is the first thing
        a reader wants to know, and the caption says why the control will not move rather than leaving a
        refusal to be read as a fault.
      */}
      <PaneHeader
        icon={MessageSquare}
        title="Chat"
        afterTitle={
          <Select
            value={buddyId ?? SAMAI_BUDDY_ID}
            // Agent Sam is stored as the absent id rather than as itself: the default is what a conversation
            // that names nobody runs as, so picking it clears the choice instead of recording one.
            onValueChange={(picked) => sessions.setPendingBuddyId(picked === SAMAI_BUDDY_ID ? null : picked)}
            disabled={!atHome}
          >
            <SelectTrigger
              aria-label="Buddy"
              // The value while home, and the reason the value cannot change once a conversation exists.
              // A native title rather than the tooltip the shield beside it uses, because a disabled
              // control is not a pointer target: a tooltip would mount on a hover it never receives.
              title={atHome ? buddyName : BUDDY_LOCK_CAPTION}
              className="max-w-40 min-w-0 shrink-6"
            >
              {/* Drawn rather than only explained: a control that refuses without saying why reads as
                  broken, and the caption carried above says the rest. */}
              {!atHome && <Lock aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />}
              {/* The entry's own mark, and the same one its row in the list below carries: the id is the
                  conversation's while one is open and the pending choice while home, so the badge names
                  the entry the label beside it names. */}
              <BuddyAvatar glyph={selectedGlyph} />
              {/*
                The label is drawn here rather than through `SelectValue`, and this is the one place the
                control differs from the model picker beside it: a conversation whose Buddy was deleted has
                no item to be read from, and the label rule already answers for that id — which is what lets
                a conversation outlive the Buddy it was created as.
              */}
              <span className="min-w-0 flex-1 truncate">{buddyName}</span>
            </SelectTrigger>
            <SelectContent>
              {/*
                Every row is its entry's mark and then its entry's name. The pair sits in a flex line of
                its own because the primitive draws a row's children inside an inline span, where an
                inline line would stack the badge over the name rather than set it beside. The name
                carries the slot the Buddies list gives the same name, because it is the same thing: the
                words a row is read by.
              */}
              {/* The default first, always: it is what a conversation that names nobody runs as. */}
              <SelectItem value={SAMAI_BUDDY_ID}>
                <span className="flex items-center gap-1.5">
                  <BuddyAvatar glyph={null} />
                  <span data-slot="buddy-name">{AGENT_SAM_BUDDY_NAME}</span>
                </span>
              </SelectItem>
              {buddyRows.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  <span className="flex items-center gap-1.5">
                    <BuddyAvatar glyph={row.glyph} />
                    <span data-slot="buddy-name">{row.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {/*
          Auto-approve sits beside the model picker because it is the other thing that decides what a
          send does: whether the agent acts on its own or asks first.

          Not on the home screen, where there is no conversation for it to be a setting of: the choice
          made before one exists is the chip in the composer's own footer, and it becomes the created
          conversation's value rather than a value written onto a conversation that is not there.
        */}
        {!atHome && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent">
                  <ShieldCheck className="size-3.5 text-muted-foreground" />
                  <span className="text-[11px] text-muted-foreground">Auto-approve</span>
                  <Switch
                    size="sm"
                    checked={autoApprove}
                    onCheckedChange={sessions.setAutoApprove}
                    aria-label="Auto-approve tool actions"
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="text-[11.5px]">{autoApproveHelperText(autoApprove)}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

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

            {/*
              The providers the user added, after every one that ships. Grouped the same way, and each
              line carries its provider's name: two providers can offer the same model id, and the id on
              its own would not say which server a line would run against.
            */}
            {customProviders.map((provider) => {
              const models = customModelsFor(provider)
              return (
                <SelectGroup key={provider.id}>
                  <SelectLabel>{provider.name}</SelectLabel>
                  {models.length === 0 ? (
                    // Named rather than dropped: a provider missing from this list would be one the user
                    // added and cannot find, so it stays and says what it is waiting for.
                    <SelectItem value={`${provider.id}::`} disabled>
                      <span className="text-muted-foreground">{provider.name} · No models yet</span>
                    </SelectItem>
                  ) : (
                    models.map((model) => (
                      <SelectItem key={model} value={`${provider.id}::${model}`}>
                        <span className="font-mono">
                          {provider.name} · {model}
                        </span>
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

      {atHome ? (
        <HomeHero />
      ) : (
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
                  {/* The controls that would cut the transcript are unavailable while the conversation is
                    moving: a run in flight is producing the turns an edit or a regenerate would remove, and
                    a paused decision belongs to a turn that has not ended. Both are facts about the pane, so
                    it is the pane that decides. */}
                  <MessageBubble
                    message={messages[item.index]}
                    canEdit={editAllowed}
                    laterTurns={messages.length - item.index - 1}
                    // The conversation these turns belong to, which is where a turn's images are stored:
                    // a chip asks that folder for its bytes, so a message sent in this session and a
                    // message restored from its file are read the same way.
                    sessionId={sessions.openId ?? undefined}
                    // Which side the user's own bubble sits on and how large the message text is painted:
                    // two values of the store's, passed down as they are, so a bubble's own memo sees a
                    // primitive change rather than a new object.
                    alignment={appearanceAlignment}
                    fontPreset={appearanceFontPreset}
                    onResend={resendEditedMessage}
                    onRegenerate={regenerateReply}
                    onApprove={() => void decide(true)}
                    onDeny={() => void decide(false)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        Between the transcript and the composer, outside both the scrolling region and the composer's
        own container: a plan is read while the run is happening, so it must not scroll away with the
        conversation — and it must not sit inside the composer either, which is the region a click is
        read as "the user is still typing" for the mention picker's sake.

        Rendered from the live transcript, so a chunk updates it in place, and from the stored snapshot
        after a reopen, so a conversation resumed from disk shows the plan its turn ended with.
      */}
      {/* A plan and a turn that stopped early are both about a conversation; home has neither. */}
      {!atHome && (
        <div className="shrink-0 px-3">
          <PlanChecklist plan={plan} />
          {/*
          The other thing that is about now: a turn that stopped before it was done. Below the plan,
          because it is the immediate question — the plan says what the work is, this says that the
          work has just stopped. Continuing sends the resume text through the ordinary send path, so a
          resumed turn is an ordinary turn in the transcript rather than a special case.
        */}
          <TurnEndNotice
            notice={endNotice}
            {...(endNotice?.resumable ? { onContinue: () => void sendText(RESUME_MESSAGE) } : {})}
          />
        </div>
      )}

      {/*
        The composer: docked under the transcript in a conversation, and a card of its own on the home
        screen, centred and one width rather than stretched across the column. The height, the drag, the
        chips, the picker and the send button are the same element either way — which is the point. A
        second composer drawn for the home screen would be a second thing to keep in step with this one,
        and the send it performed would be the second send path the doc above rules out.
      */}
      <div
        ref={composerRef}
        className={cn(
          'relative p-3',
          atHome
            ? 'mx-auto w-full max-w-3xl rounded-xl border border-border bg-card'
            : 'shrink-0 border-t border-border'
        )}
      >
        {/*
          The composer's top edge, as a grab target. A separator rather than a button because what it
          does is resize the region below it, and `cursor-row-resize` is the cursor that says so before
          anyone has started dragging. It straddles the border rather than sitting under it, so the strip
          does not eat the first line of the textarea's hit area, and `touch-none` keeps a touch drag from
          being read as a scroll of the transcript.
        */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the composer"
          className="absolute inset-x-0 -top-1 h-2 cursor-row-resize touch-none"
          onPointerDown={startComposerDrag}
        />
        <Popover
          open={pickerOpen || commandOpen}
          onOpenChange={(next) => {
            // The picker can also be dismissed by the layer itself — Escape, or a click outside the
            // composer. Both arrive here, and both mean the same thing: this token is no longer asking.
            // The command line owns the popover while it is showing, so it is the one that hears this.
            if (next) return
            if (commandOpen) dismissCommandPicker()
            else dismissPicker()
          }}
        >
          {/*
            Anchored to the composer rather than to a trigger: the textarea is what the token was read
            from, and the picker has to sit against the sentence it belongs to. There is no trigger at
            all, because nothing opens this popover except the caret being inside an `@` token.
          */}
          <PopoverAnchor asChild>
            <div className="relative" onDragOver={onComposerDragOver} onDrop={onComposerDrop}>
              {/*
                What this conversation is working from, above the sentence being written about it. Chips
                rather than a line of prose because the point is that they can be taken off again, and
                beside the mention chips because both are "what goes with this message".
              */}
              {skillChips.length > 0 && (
                <SkillChipRow
                  skills={skillChips}
                  disabled={isStreaming || pending !== null}
                  onRemove={sessions.toggleSkill}
                  className="mb-2"
                />
              )}
              {mentionPaths.length > 0 && (
                <MentionChipRow paths={mentionPaths} onRemove={removeMention} className="mb-2" />
              )}
              {/*
                The images the next send will carry, beside the files for the same reason the files are
                there: both are "what goes with this message", and both can be taken off again.
              */}
              {draftImages.length > 0 && (
                <AttachmentChipRow images={draftImages} onRemove={removeImage} className="mb-2" />
              )}
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
                  syncCommand(e.target.value)
                  // Typing is the user moving on, which is what puts a command's answer away.
                  setCommandNotice(null)
                }}
                // The caret moving is what ends a token as much as typing is, so following it keeps the
                // picker attached to the word the user is actually in.
                onSelect={(e) => {
                  const area = e.currentTarget
                  syncMention(area.value, area.selectionStart ?? area.value.length)
                }}
                onKeyDown={onKeyDown}
                onPaste={onComposerPaste}
                placeholder={pending ? 'Waiting for your approval…' : 'Ask about this project… (@ to attach a file)'}
                aria-label="Message"
                // `field-sizing-fixed` is the whole of the behaviour change: the primitive ships
                // `field-sizing-content`, which grows the box with its content, and the composer wants the
                // opposite — one height, scrolled internally, however long the draft gets. `min-h-0` undoes
                // the primitive's own floor so the height below is the height, not a suggestion.
                className="field-sizing-fixed min-h-0 resize-none overflow-y-auto pt-2.5 pr-28 text-[13px]"
                // The height is state rather than styling — it is the number the drag produces — so it is the
                // one thing here that cannot be a class.
                style={{ height: composerHeight }}
              />
              {/*
                The picker, as an input nothing draws and a button that clicks it.

                A separate control from the paperclip above it rather than the same one: the paperclip
                attaches a file that is *in the workspace and already open*, which is a different question
                from "which image on this machine", and one control that answered both would have to guess
                which the user meant. The accept filter is the whitelist itself, so the dialog offers what
                the rules would take — and a user who overrides it anyway is refused with the rule's own
                sentence rather than silently ignored.
              */}
              <input
                ref={attachInputRef}
                data-slot="attachment-input"
                type="file"
                accept={ATTACHMENT_ACCEPT_ATTRIBUTE}
                multiple
                className="hidden"
                aria-label="Choose images to attach"
                onChange={onAttachPicked}
              />
              <Button
                size="icon-sm"
                variant="outline"
                className="absolute right-[4.75rem] bottom-2"
                aria-label="Attach images"
                title="Attach images (or paste, or drop them)"
                onClick={() => attachInputRef.current?.click()}
              >
                <ImagePlus />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                className="absolute right-2 bottom-2"
                aria-label="Attach the open file"
                title={selectedFile ? `Attach ${selectedFile}` : 'Open a file to attach it'}
                disabled={!selectedFile}
                onClick={attachOpenFile}
              >
                <Paperclip />
              </Button>
              {isStreaming ? (
                <Button
                  size="icon-sm"
                  variant="outline"
                  className="absolute right-11 bottom-2"
                  aria-label="Stop"
                  onClick={stop}
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  className="absolute right-11 bottom-2"
                  aria-label="Send message"
                  disabled={!draft.trim() || pending !== null}
                  onClick={() => void sendDraft()}
                >
                  <SendHorizontal />
                </Button>
              )}
            </div>
          </PopoverAnchor>

          {pickerOpen && (
            <MentionPicker
              paths={mentionMatches}
              // The unfiltered count, so an empty list can say whether nothing matched or there is
              // nothing to match at all.
              total={allMentionFiles.length}
              activeIndex={activePickerIndex}
              atCap={mentionPaths.length >= MAX_MENTION_PATHS}
              onSelect={chooseMention}
              onInteractOutside={keepComposerClicks}
            />
          )}

          {commandOpen && (
            <CommandPicker
              commands={commandRows}
              activeIndex={activeCommandIndex}
              onSelect={runCommand}
              onInteractOutside={keepComposerClicks}
            />
          )}
        </Popover>

        {/* Under the composer rather than as a toast: a refusal is about the control the user just
            used, and it has to still be there when they look back at it. */}
        {mentionNote && (
          <p role="status" className="mt-2 text-[11.5px] text-muted-foreground">
            {mentionNote}
          </p>
        )}

        {/* A refused image, said in the same place as a refused file and for the same reason: it is about
            the control the user just used. Its own line rather than sharing the one above, because the two
            answer two different gestures and one would otherwise overwrite the other. */}
        {attachmentNote && (
          <p role="status" className="mt-2 text-[11.5px] text-muted-foreground">
            {attachmentNote}
          </p>
        )}

        {/* A command's answer, under the composer it was typed in and for the reason the refusal above
            is: it is about the control the user just used. A card rather than a line because `/help`
            has eight of them to list, and it is kept until the user types again. */}
        {commandNotice && <CommandNotice notice={commandNotice} />}

        {/*
          The approval choice, made before there is a conversation to make it on.

          It is the same setting the header's toggle shows once a conversation exists — one value, two
          places that can make it — and it is what the conversation created by the next send starts
          with. Off is what it says until it is set: a choice nobody has made is not consent, and a
          conversation that has never been told otherwise asks.
        */}
        {/*
          The skills control, in the composer's own footer beside the approval chip: both are choices
          about the next message rather than settings for the window, and this is where the one of them
          that is only asked before a conversation already lives.

          The row is drawn whether or not the approval chip is, so the control does not move as a
          conversation starts. What a conversation runs with is shown above, as chips.
        */}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <SkillPicker
            project={projectSkills}
            user={userSkills}
            errors={skillListing.errors}
            activeSkillIds={activeSkillIds}
            // A toggle changes the turn after the one in flight, so it is offered exactly when there
            // is no turn to confuse it with: nothing to interrupt, and no question waiting on an
            // answer. This is also the condition the session layer refuses a toggle under.
            disabled={isStreaming || pending !== null}
            loading={skillsQuery.isPending}
            onToggle={sessions.toggleSkill}
          />
          {atHome && (
            <button
              type="button"
              aria-label="Approval mode"
              aria-pressed={autoApprove}
              title={autoApproveHelperText(autoApprove)}
              onClick={() => sessions.setAutoApprove(!autoApprove)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ShieldCheck aria-hidden="true" className="size-3.5" />
              <span className={autoApprove ? 'text-foreground' : undefined}>
                {autoApprove ? 'Auto-approve' : 'Manual'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/*
        Under the card, and deliberately in this order: the folder the next conversation will run in, the
        conversations already there, and three ways to start one. Nothing above it is repeated here — the
        headline said what the screen is for, and these are the things to do about it.
      */}
      {atHome && <HomePanel onStarter={prefillComposer} starters={starters} />}
    </div>
  )
}
