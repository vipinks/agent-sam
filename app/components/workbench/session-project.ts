import { sameRoot, WORKSPACE_MISSING } from '@/conveyor/protocol/recent-roots'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { rootTail } from './recent-roots'

/**
 * What a conversation's project means for the window: which folder selecting a session opens, whether
 * that selection is allowed while a turn is live, whether a turn start records the folder it ran in,
 * and how the list orders rows by project.
 *
 * Pure and renderer-only, for the reason `session-search.ts` and `session-rules.ts` are: these are the
 * decisions that are invisible when they are wrong — a click that pulled the workspace somewhere the
 * user did not ask for, or one that answered a question they had not been asked — and a decision is
 * worth being able to make in a test without a disk, a store, or a window.
 *
 * Existence is deliberately *not* decided here. `planSelectRoot` answers which folder a session
 * belongs in; whether that folder is still on disk is main's answer, and it comes back as a code
 * (`WORKSPACE_MISSING`) rather than as a sentence.
 */

/**
 * The code a selection is refused under while a turn is streaming in this window.
 *
 * Renderer-owned, unlike `WORKSPACE_MISSING`: nothing crosses the boundary with it. It exists so the
 * notice is worded from a code and not from an excuse, and so a test can pin the refusal without
 * matching prose.
 */
export const SELECT_REFUSED_TURN = 'SELECT_REFUSED_TURN'

/**
 * The code a selection is refused under while a decision is pending and the selection would move the
 * workspace out from under the paused turn.
 *
 * Two codes rather than one because the two refusals ask for different things of the user — wait, or
 * answer the card — and a single code would have to be worded for neither.
 */
export const SELECT_REFUSED_DECISION = 'SELECT_REFUSED_DECISION'

/** Where a selection takes the workspace root, before the session renders. */
export interface SelectRootPlan {
  /** The folder to open, or null to leave the window where it is. */
  switchTo: string | null
}

/**
 * The folder a session click should open.
 *
 * Three cases, and only one of them moves anything:
 *
 * - A session with no project yet keeps whatever the window is showing. It is not anonymous, it is
 *   simply not yet used anywhere — its first turn stamps it, and that turn runs in the folder the user
 *   is working in, which is what makes the stamp true rather than guessed.
 * - A session whose project is already the open folder does not re-open it. The comparison is the
 *   store's own (`sameRoot`), so a differently-cased spelling of the same folder is the same folder
 *   here as it is everywhere else, and a click inside the current project costs no `stat` at all.
 * - Anything else switches, and the folder it names is handed to main unsullied: whether it still
 *   exists is decided there, before the store is told anything.
 */
export function planSelectRoot(input: {
  /** The session's stored project, or undefined when it has none. */
  sessionLastRoot: string | undefined
  /** The folder this window is showing now. */
  currentRoot: string | null
}): SelectRootPlan {
  const { sessionLastRoot, currentRoot } = input

  if (sessionLastRoot === undefined) return { switchTo: null }
  if (currentRoot !== null && sameRoot(sessionLastRoot, currentRoot)) return { switchTo: null }

  return { switchTo: sessionLastRoot }
}

/**
 * Whether a session click is allowed right now, and under which code it is refused.
 *
 * A turn that is streaming owns the transcript on screen: the run is writing into it, so opening
 * another conversation mid-stream would hand the rest of that answer to a session it was never about.
 * That refusal is unconditional.
 *
 * A pause is a different state, and the narrower rule is deliberate. The turn behind a pause is not
 * running — it handed its history over and ended — and the pause is held per conversation, so leaving
 * one standing to work elsewhere is a thing this app does on purpose and does safely. What is *not*
 * safe is moving the workspace while a paused turn is still to be resumed: the resume is issued with
 * the window's folder at the moment the card is answered, so a selection that changes the folder
 * would redirect the resumed turn's tool paths to a project it never started in. Hence:
 * `movesRoot`.
 */
export function planSessionSwitch(input: {
  /** Whether a turn is streaming in this window. */
  streaming: boolean
  /** Whether any conversation in this window is waiting on a decision. */
  pendingDecision: boolean
  /** Whether this selection would change the open folder. */
  movesRoot: boolean
}): string | null {
  if (input.streaming) return SELECT_REFUSED_TURN
  if (input.pendingDecision && input.movesRoot) return SELECT_REFUSED_DECISION
  return null
}

/**
 * Why a selection did not happen, worded from its code.
 *
 * Branched on the code and never on a sentence someone else wrote: `WORKSPACE_MISSING` comes from
 * main, the two refusals are this window's own, and an unrecognised code still has to say something
 * true — that the workspace did not move.
 *
 * The missing case names the path, because that is the one thing the user can act on: it is the
 * folder that is gone, and knowing which one is what makes forgetting it possible.
 */
export function selectNotice(code: string, context: { path: string; currentRoot: string | null }): string {
  const { path, currentRoot } = context

  switch (code) {
    case SELECT_REFUSED_TURN:
      return 'A turn is still running here. Let it finish, then open another conversation.'
    case SELECT_REFUSED_DECISION:
      return `This conversation is waiting on your decision, and opening ${path} would move the workspace out from under it.`
    case WORKSPACE_MISSING:
      return currentRoot === null
        ? `${path} is no longer there, so this conversation opened with no project.`
        : `${path} is no longer there, so ${rootTail(currentRoot)} stays open.`
    default:
      return `${path} could not be opened, so the workspace stayed where it was.`
  }
}

/**
 * The project a session should be stamped with at the start of a turn, or null to write nothing.
 *
 * Recording the folder at every turn start is what keeps a session's project current: a session can be
 * picked up in a different folder — the user switched the workspace by hand, or opened another
 * project's conversation and kept working — and the stamp has to follow the work rather than
 * contradict it. The comparison is case-insensitive for the same reason the switch comparison is: a
 * differently-cased spelling is not a different folder, and rewriting one spelling into another would
 * be a store write per turn that changes nothing anyone can see.
 *
 * No folder open is not a project, so nothing is written. An empty string would be a stamp that later
 * reads as one, which is exactly the state this field is defined *not* to have: absent means no
 * project yet.
 */
export function planRootStamp(input: {
  /** The session's stored project, or undefined when it has none. */
  sessionLastRoot: string | undefined
  /** The folder this window is showing now. */
  windowRoot: string | null
}): string | null {
  const { sessionLastRoot, windowRoot } = input

  if (windowRoot === null) return null
  if (sessionLastRoot !== undefined && sameRoot(sessionLastRoot, windowRoot)) return null

  return windowRoot
}

/** One project's conversations, as the list draws them. */
export interface SessionGroup {
  /** The project's folder, or null for the conversations that have no project yet. */
  root: string | null
  /** That project's conversations, in the store's order — most recently touched first. */
  sessions: ChatSession[]
}

/** The newest activity in a group, which is what the groups between themselves are ordered by. */
function latestActivity(group: SessionGroup): number {
  return group.sessions.reduce((newest, session) => Math.max(newest, session.updatedAt), 0)
}

/**
 * The session list, arranged by project.
 *
 * Three tiers, in this order and for these reasons:
 *
 * - The open project first, because it is the one the user is working in and the one a new
 *   conversation will be stamped with.
 * - Then every other project by how recently it was used, so the folders someone moves between stay
 *   near the top rather than being ordered by when they were first opened.
 * - Then the conversations with no project at all, last, because they are history from before a
 *   session recorded where it ran.
 *
 * Folders are compared with the store's own rule, so one folder is one group however its case arrived.
 * The spelling a group is labelled with is the one its newest session carries, which is the spelling
 * the user last saw it under.
 *
 * Within a group the store's order stands: the list is already most-recent-first, and re-sorting here
 * would be a second ordering rule to keep in agreement with the first.
 */
export function groupSessionsByRoot(sessions: ChatSession[], currentRoot: string | null): SessionGroup[] {
  const groups: SessionGroup[] = []

  for (const session of sessions) {
    const root = session.lastRoot
    const group = groups.find((candidate) =>
      root === undefined ? candidate.root === null : candidate.root !== null && sameRoot(candidate.root, root)
    )

    if (group) {
      group.sessions.push(session)
      continue
    }

    groups.push({ root: root ?? null, sessions: [session] })
  }

  const unstamped = groups.filter((group) => group.root === null)
  const open = currentRoot === null ? undefined : groups.find((group) => sameRoot(group.root ?? '', currentRoot))
  const others = groups.filter((group) => group.root !== null && group !== open)

  // Most recent activity first. Explicit rather than relying on the order the groups were discovered
  // in, so this keeps its answer even if the store's list ever arrives unsorted.
  others.sort((a, b) => latestActivity(b) - latestActivity(a))

  return [...(open ? [open] : []), ...others, ...unstamped]
}
