import type { ITheme } from '@xterm/xterm'
import { ensureReadable, resolveThemeVars, type ThemeVars } from './theme-engine'
import type { ThemeMode, ThemeVariable } from './themes'

/**
 * The terminal's colours, as xterm wants them.
 *
 * The app has one palette, and xterm is not drawn by Tailwind: it paints its own canvas and takes the
 * colours it paints as an object. So a theme token is honoured in the terminal only if it is handed
 * over, which makes this file the whole of the terminal's theme support — and makes it a mapping rather
 * than a palette. Every value below is a token the rest of the app already uses, because a second
 * palette is exactly how a terminal becomes the one rectangle that does not move when the user changes
 * theme, or that stays light after a flip to dark.
 *
 * Pure, and deliberately so: it reads `themes.ts` and `theme-engine.ts`, neither of which touches React
 * or the DOM, so a suite can check all five themes in both modes without a browser. The one thing that
 * would break that is `theme-apply.ts`'s `themeVarsFor`, which composes the same two engine calls but
 * imports the React shell to hand the result to a document — so the composition is spelled out here
 * instead of imported. That is a twin, not a fork: both are `ensureReadable(resolveThemeVars(...))`, and
 * the suite pins this one to the engine's own output.
 */

/** The xterm theme fields this app fills. The rest are left to xterm's own defaults. */
export type TerminalThemeField =
  | 'background'
  | 'foreground'
  | 'cursor'
  | 'cursorAccent'
  | 'selectionBackground'
  | 'selectionForeground'
  | 'selectionInactiveBackground'
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'

/**
 * Which token each field is painted from.
 *
 * The surfaces and the cursor are the app's own tokens, one for one: the terminal sits in a pane beside
 * the chat, so its background *is* the app's background and its text *is* the app's foreground — which
 * is also what keeps the pair clearing the contrast floor the engine already enforces on the document.
 *
 * The ANSI slots are the interesting half, because a shell colours its output by slot rather than by
 * meaning: `ls` paints a directory blue and a binary red without knowing anything about this app. So the
 * six semantic slots are bound to the tokens that carry the same meaning here — `red` to the
 * destructive colour, `green` to the success colour, and the three syntax hues to the same keyword,
 * string and number tokens the code viewer uses. A shell's red therefore reads as the app's red, which
 * is the point: two different reds on one screen is how a terminal stops looking like part of the app.
 *
 * `black` and `white` have no semantic token to borrow — they arrive whenever a program asks for
 * "default-ish" text — so they take the muted surface and the muted foreground, and every `bright` form
 * takes the same token as its base or the next surface along. Nothing here is invented: a value that is
 * not a token would be a colour that ignores the theme, and the suite refuses one.
 */
export const TERMINAL_THEME_TOKENS: Record<TerminalThemeField, ThemeVariable> = {
  background: 'background',
  foreground: 'foreground',
  cursor: 'brand',
  cursorAccent: 'background',
  // `brand-soft` is the token the app already uses for a selected row, so a terminal selection reads as
  // the same selection rather than as a second style of one.
  selectionBackground: 'brand-soft',
  selectionForeground: 'foreground',
  // Unfocused, a selection is background noise; the muted surface says so without hiding the text.
  selectionInactiveBackground: 'muted',

  black: 'muted',
  red: 'destructive',
  green: 'success',
  yellow: 'syntax-number',
  blue: 'brand',
  magenta: 'syntax-keyword',
  cyan: 'syntax-string',
  white: 'muted-foreground',
  brightBlack: 'muted-foreground',
  brightRed: 'destructive',
  brightGreen: 'success',
  brightYellow: 'syntax-number',
  brightBlue: 'brand-hover',
  brightMagenta: 'syntax-keyword',
  brightCyan: 'syntax-string',
  brightWhite: 'foreground',
}

/**
 * The theme xterm is given, from a resolved set of the app's variables.
 *
 * The `ITheme` xterm takes is a bag of optional colours, so the only thing that has to be true of the
 * result is that a field naming a token carries that token's value — which is what the table states and
 * what this applies. Built by iterating the table rather than written out as a literal, so the two
 * cannot drift: adding a field is adding a line to the table.
 */
export function terminalTheme(vars: ThemeVars): ITheme {
  const theme: Record<string, string> = {}
  for (const [field, token] of Object.entries(TERMINAL_THEME_TOKENS)) {
    theme[field] = vars[token as ThemeVariable]
  }
  return theme as ITheme
}

/**
 * The same theme, for a theme id and mode.
 *
 * This is the form the pane calls: the three arguments are the three the document's own variables are
 * resolved from, so a theme switch, a mode flip and a brightness step all reach the terminal by the one
 * route they reach the stylesheet — the terminal cannot be left behind by a change it did not hear.
 */
export function terminalThemeFor(themeId: string, mode: ThemeMode, brightness: number): ITheme {
  return terminalTheme(ensureReadable(resolveThemeVars(themeId, mode, brightness)).vars)
}
