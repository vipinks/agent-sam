/**
 * What the home screen says, and nothing else.
 *
 * These are the screen's own words rather than a derivation: what is offered back is not a decision of
 * this module any more — the chips are built from the folders the workspace store remembers and the
 * conversations the sessions store holds, by the rule in `conveyor/protocol/recent-roots` — and the
 * three ways in are static, deliberately derived from nothing.
 *
 * Nothing here touches a disk, a store, or electron.
 */

/** The one line the hero leads with, above the composer. */
export const HOME_HEADLINE = 'What are we working on?'

/**
 * The one line under it.
 *
 * A subline rather than more copy: everything else the screen has to say is a control the user can
 * act on — the folders they left, the ways to start — and a second paragraph of prose above those
 * would be read once and then be in the way.
 */
export const HOME_SUBLINE = 'Describe what you want to change, ask about a file, or pick up where you left off.'

/**
 * The prompts offered as a way in when no Buddy offers its own.
 *
 * Static, and the fallback rather than the whole offer: a Buddy carries starters of its own, and one that
 * declares any is what home shows — the same rule the record is read by. These three are what is left when
 * the choice is the Agent Sam default, or a Buddy that offers none.
 */
export const HOME_STARTERS: readonly string[] = [
  'Explain how this project is put together.',
  'What are the riskiest parts of this codebase?',
  'What changed since the last commit?',
]

/**
 * What the row of remembered folders heads itself with.
 *
 * The row is one surface rather than two: the folders the app remembers, each with how much is in it,
 * and the way to one it does not remember yet. The label names the folders rather than the
 * conversations in them, because a folder is what a chip stands for.
 */
export const HOME_RECENT_PROJECTS = 'Recent projects'

/** The way to a folder that is not listed, and the words the menu's own entry carries. */
export const HOME_OPEN_FOLDER = 'Open a folder…'
