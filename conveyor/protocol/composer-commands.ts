/**
 * Composer commands: the words a draft may open with, and what each one stands for.
 *
 * Pure, and shared rather than renderer-only, for the reason the mention rules are: the *rules* —
 * where a slash counts as a command, what a query matches, which command is hidden where — are
 * decisions a test should be able to make without a rendered composer. What each command *does* is
 * the renderer's business and stays there: main owns no part of a command, which is why this module
 * names work the UI already knows how to do and dispatches none of it itself.
 *
 * Three rules are load-bearing enough to state up front.
 *
 * A command is the whole draft. A slash opens one only at position zero, and a space closes it:
 * `/new` is a command, `/new please` is a sentence that happens to begin with a slash. That is what
 * keeps a message that opens with a slash — a path, a regex, a shrug — typable as text, and it is
 * also why there are no arguments to parse and none to add: an argument grammar would be a second
 * language inside the composer, and this is deliberately not one.
 *
 * The filter reads the name and the description. A user who cannot recall that the mode toggle is
 * called `theme` can still reach it by typing `dark`, which is the whole reason the descriptions are
 * part of the match rather than decoration beside it.
 *
 * The order is the registry's own and is fixed. A filter narrows the list; it never reorders it, so
 * the row under the caret is where the user last saw it, and the empty query lists exactly what is
 * available here, in the order below.
 */

/** Every command the composer knows. One id per behaviour the renderer dispatches. */
export type ComposerCommandId = 'new' | 'terminal' | 'settings' | 'mcp' | 'skills' | 'theme' | 'help' | 'version'

/** One row of the picker: the word typed after the slash, and the line that explains it. */
export interface ComposerCommand {
  id: ComposerCommandId
  /** The word after the slash, matched by the filter and shown in the row. */
  name: string
  /** One line, in the user's terms — and the words the filter matches besides the name. */
  description: string
  /**
   * Hidden on the home screen, where the command would do nothing.
   *
   * Set on exactly one command, and for a reason rather than for symmetry: `/new` leaves whatever is
   * open and lands on home, so on home there is nothing to leave. Offering it there would be offering
   * a control whose only observable effect is that the draft disappeared.
   */
  hiddenAtHome?: boolean
}

/**
 * The command set, in display order.
 *
 * Session commands first, then the settings screens, then the two that answer in place: that is the
 * order a list of what this composer can do reads in, and the fixed order the picker keeps.
 */
export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { id: 'new', name: 'new', description: 'Start a new conversation', hiddenAtHome: true },
  { id: 'terminal', name: 'terminal', description: 'Show or hide the terminal panel' },
  { id: 'settings', name: 'settings', description: 'Open settings on providers' },
  { id: 'mcp', name: 'mcp', description: 'Open settings on MCP servers' },
  { id: 'skills', name: 'skills', description: 'Open settings on skills' },
  { id: 'theme', name: 'theme', description: 'Switch between light and dark mode' },
  { id: 'help', name: 'help', description: 'List every command' },
  { id: 'version', name: 'version', description: 'Show which version of the app this is' },
]

/**
 * The slash a draft opens with, and what was typed after it.
 *
 * Bounds rather than a query string alone, because the token is consumed by its own bounds when a
 * command runs — the same way the `@` token becomes a chip. A command occupies the whole draft today,
 * and the bounds are what say so rather than an assumption held at the call site.
 */
export interface ComposerCommandToken {
  /** Where the slash is. Always zero: this is the rule, not an accident of the caller. */
  start: number
  /** Just past the last character of the word, which is where the draft ends. */
  end: number
  /** What was typed after the slash, as the filter reads it. Empty for a bare slash. */
  query: string
}

/**
 * Read the command token a draft opens with, if it opens with one.
 *
 * `null` for anything else, including a slash that is not at position zero: a mid-sentence slash is
 * the user's own text — a fraction, a path, a date — and a picker that opened on every `/` would be
 * a picker that interrupts writing rather than one that helps it. `null` also for a draft that has
 * moved past the word: once there is a space the draft is a sentence, and no command is being typed.
 *
 * The bounds are returned rather than the bare query so the caller can consume exactly what it read.
 * The drafts this recognises are the whole text, but the answer states that rather than relying on
 * the caller to know it.
 */
export function parseComposerCommand(text: string): ComposerCommandToken | null {
  if (!text.startsWith('/')) return null
  if (/\s/.test(text.slice(1))) return null
  return { start: 0, end: text.length, query: text.slice(1) }
}

/**
 * The rows to offer for a query, in display order.
 *
 * Hiding is applied before matching rather than after, because the two are different questions: what
 * may be offered here at all, and which of those fit what was typed. A hidden command is not a
 * command that failed to match — it would not appear for an empty query either.
 *
 * An empty query matches everything available, which is the state a bare slash opens in: the picker
 * has to show the user the set before it can narrow it.
 */
export function filterComposerCommands(query: string, options: { atHome: boolean }): ComposerCommand[] {
  const needle = query.toLowerCase()
  return COMPOSER_COMMANDS.filter((command) => {
    if (command.hiddenAtHome === true && options.atHome) return false
    if (needle === '') return true
    return command.name.toLowerCase().includes(needle) || command.description.toLowerCase().includes(needle)
  })
}

/**
 * The command a highlighted row stands for, or `null` when there is no row there.
 *
 * Resolved in one place so the picker's index and the dispatch cannot disagree about which row is
 * active — and so an index past the end of a list that just narrowed resolves to nothing rather than
 * to a command the user never highlighted.
 */
export function composerCommandAt(rows: readonly ComposerCommand[], index: number): ComposerCommandId | null {
  const row = rows[index]
  return row ? row.id : null
}
