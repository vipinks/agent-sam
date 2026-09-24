import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import { rootTail } from './recent-roots'

/**
 * What the home screen says, and which conversation each chip offers back.
 *
 * Pure and renderer-only, for the reason `recent-roots.ts` and `session-project.ts` are: which three
 * conversations are worth offering, what a chip calls the project it belongs to, and what the project
 * row says with and without a folder open are decisions a test should make by calling a function.
 * The screen then holds the state and draws the result.
 *
 * Nothing here touches a disk, a store, or electron. The sessions arrive from main, and the folder
 * names are read from the paths main already resolved.
 */

/** The one line the hero leads with, above the composer. */
export const HOME_HEADLINE = 'What are we working on?'

/**
 * The one line under it.
 *
 * A subline rather than more copy: everything else the screen has to say is a control the user can
 * act on — the folder the work lands in, the conversations they left, the ways to start — and a
 * second paragraph of prose above those would be read once and then be in the way.
 */
export const HOME_SUBLINE = 'Describe what you want to change, ask about a file, or pick up where you left off.'

/** The prompts offered as a way in. Static, and deliberately not derived from anything. */
export const HOME_STARTERS: readonly string[] = [
  'Explain how this project is put together.',
  'What are the riskiest parts of this codebase?',
  'What changed since the last commit?',
]

/** How many conversations are offered back. Three, because a fourth would be a list to read. */
export const MAX_HOME_RECENTS = 3

/** How much of a conversation's title a chip shows before it is cut. */
export const HOME_TITLE_MAX = 32

/** What the project row offers when no folder is open, and the entry that opens one. */
export const HOME_OPEN_FOLDER = 'Open a folder…'

/** What a chip calls a conversation that has no project yet. */
export const HOME_NO_PROJECT = 'No project'

/**
 * The conversations the home screen offers back: the most recently touched, across every project.
 *
 * Across projects rather than within one, because this is the way back to work rather than a view of
 * the open folder: the conversation someone wants is very often the one they were just in, and which
 * folder it happened in is a detail of the chip rather than a filter on it.
 *
 * Ordered here rather than taken in the store's order. The store sorts by activity and this agrees
 * with it today, but "the three most recent" is the claim this screen makes, and a claim worth making
 * is worth stating where it can be read.
 */
export function recentSessionsForHome(sessions: readonly ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HOME_RECENTS)
}

/**
 * The two things a chip names: the project it belongs to, and what it was about.
 *
 * The project is the folder's last segment for the reason the switcher's entries show one — a chip is
 * a few words wide, and the last segment is the part that tells two projects apart. A conversation
 * with no project yet says so rather than borrowing the folder that happens to be open: it has not run
 * anywhere, and naming it after the open folder would be a claim about work that never happened.
 *
 * The title is cut to a length a chip can hold. The element also truncates whatever it is given, for
 * the width it does not control — that is the browser's half of this, and this is the half a test can
 * state.
 */
export function homeChip(session: ChatSession): { project: string; title: string } {
  return {
    project: session.lastRoot === undefined ? HOME_NO_PROJECT : rootTail(session.lastRoot),
    title: truncateTitle(session.title),
  }
}

/** A title cut to `HOME_TITLE_MAX`, ending in an ellipsis rather than mid-word. */
function truncateTitle(title: string): string {
  if (title.length <= HOME_TITLE_MAX) return title
  return `${title.slice(0, HOME_TITLE_MAX - 1).trimEnd()}…`
}

/**
 * What the project row shows.
 *
 * With a folder open it is that folder's last segment — the row's whole job is to say where the next
 * conversation will run. With nothing open there is no name to show, so the row becomes the action
 * that gets one: the same words the menu's own entry uses, because it is the same act.
 */
export function projectRowLabel(rootPath: string | null): string {
  return rootPath === null ? HOME_OPEN_FOLDER : rootTail(rootPath)
}
