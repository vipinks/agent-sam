/**
 * The theme registry: five named themes, each a complete set of colour tokens for both modes.
 *
 * Data and nothing else — no DOM, no React, no storage. The engine beside this file turns a theme
 * plus a mode plus a brightness into the values the document is given; this file only says what a
 * theme *is*, which is why a suite can check every theme's contrast without a browser.
 *
 * What is here is a token map per mode, one entry per CSS custom property `globals.css` declares on
 * `:root` and `.dark`, minus the leading `--`. `THEME_VARIABLES` is that list, and because every
 * theme's map is typed as `Record<ThemeVariable, string>` a theme that forgets a property fails to
 * compile rather than falling back to whichever stylesheet value happened to be inherited.
 *
 * The three style blocks that already read these variables — syntax highlighting, markdown's GFM
 * constructs, and the workbook grid — are deliberately *not* reproduced here. They are rules about
 * class names this app does not author (`hljs-…` comes from highlight.js at runtime, `task-list-item`
 * from remark-gfm), so they belong in the stylesheet; what a theme owns is the values those rules
 * resolve to.
 *
 * `crimson` is today's palette, token for token, converted from the hex in `globals.css` to HSL
 * without changing a single rendered colour. That is what lets the default experience stay
 * pixel-identical while every colour in the app becomes a variable the engine can move: a test
 * compares this map against the stylesheet itself rather than against a hand-copied expectation.
 *
 * The other four are the same tonal ladder — a light surface family that is nearly white, a dark one
 * that is nearly black, and a mid-tone foreground pair — with the hue moved. Lightness carries
 * meaning here and is therefore shared; only hue and saturation make a theme itself.
 */

/**
 * Every CSS custom property `globals.css` declares on `:root` and `.dark`, in the order the
 * stylesheet declares them.
 *
 * The one entry that is not a colour is `radius`, which is carried by the themes because the
 * stylesheet declares it on the same two selectors — not every theme *has* to change it, but the
 * map is the whole set of properties or it is a source of drift.
 */
export const THEME_VARIABLES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'border-bright',
  'input',
  'ring',
  'brand',
  'brand-soft',
  'brand-hover',
  'success',
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'radius',
] as const

export type ThemeVariable = (typeof THEME_VARIABLES)[number]

/** One theme's complete set of values for one mode. */
export type ThemeTokens = Record<ThemeVariable, string>

export type ThemeMode = 'light' | 'dark'

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark']

export type ThemeId = 'crimson' | 'ocean' | 'forest' | 'amber' | 'violet'

export interface Theme {
  id: ThemeId
  /** Shown wherever a theme is offered by name. */
  label: string
  /**
   * The pair a picker draws, which is this theme's `background` in each mode.
   *
   * The background rather than the brand colour: what a theme changes *most* is the surface a window
   * is made of, and two themes can share a brand hue while being unmistakably different to sit in.
   */
  swatch: Record<ThemeMode, string>
  tokens: Record<ThemeMode, ThemeTokens>
}

/** The default theme, and the one an unknown id falls back to. */
export const DEFAULT_THEME_ID: ThemeId = 'crimson'

/**
 * The three syntax hues that do not follow a theme's own palette.
 *
 * `globals.css` derives them from the palette that surrounds them — the keyword from the brand, the
 * string from the success green, the number from a warm amber between the two. That derivation is
 * kept: `syntax-keyword` is taken from each theme's own brand hue below, while the string and number
 * stay the same green and amber in every theme. A `string` that was magenta in one theme and green in
 * the next would make the same token mean two things, which is a worse loss than a hue that does not
 * match the surface it sits on.
 */
const SYNTAX_STRING_LIGHT = 'hsl(152.609 75.41% 23.922%)'
const SYNTAX_STRING_DARK = 'hsl(144.255 56.627% 67.451%)'
const SYNTAX_NUMBER_LIGHT = 'hsl(39.84 100% 24.51%)'
const SYNTAX_NUMBER_DARK = 'hsl(42.222 74.312% 57.255%)'

/**
 * The two semantic pairs: what the app says when something is wrong, and when something worked.
 *
 * Shared by every theme on purpose. Red is a signal, not a theme decision — a theme that tinted the
 * destructive colour to its own hue would be spending the one colour that has to mean the same thing
 * everywhere. The success pair is shared for the same reason, and it is also the source of the syntax
 * string above.
 */
const DESTRUCTIVE = 'hsl(354.977 86.345% 48.824%)'
const SUCCESS_LIGHT = 'hsl(142.128 76.216% 36.275%)'
const SUCCESS_DARK = 'hsl(141.892 69.159% 58.039%)'

/** The radius every theme ships with; the stylesheet's own `--radius`. */
const RADIUS = '0.5rem'

export const THEMES: readonly Theme[] = [
  {
    id: 'crimson',
    label: 'Crimson',
    swatch: { light: 'hsl(36 18.519% 94.706%)', dark: 'hsl(210 11.111% 3.529%)' },
    tokens: {
      light: {
        background: 'hsl(36 18.519% 94.706%)',
        foreground: 'hsl(20 17.647% 6.667%)',
        card: 'hsl(40 70% 99.412%)',
        'card-foreground': 'hsl(20 17.647% 6.667%)',
        popover: 'hsl(40 70% 99.412%)',
        'popover-foreground': 'hsl(20 17.647% 6.667%)',
        primary: 'hsl(20 17.647% 6.667%)',
        'primary-foreground': 'hsl(40 70% 99.412%)',
        secondary: 'hsl(36 29.412% 96.667%)',
        'secondary-foreground': 'hsl(20 17.647% 6.667%)',
        muted: 'hsl(36 29.412% 96.667%)',
        'muted-foreground': 'hsl(32.308 7.345% 34.706%)',
        accent: 'hsl(36 29.412% 96.667%)',
        'accent-foreground': 'hsl(20 17.647% 6.667%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(40 70% 99.412%)',
        border: 'hsl(36 14.706% 86.667%)',
        'border-bright': 'hsl(36.923 12.871% 80.196%)',
        input: 'hsl(36 14.706% 86.667%)',
        ring: 'hsl(36.923 12.871% 80.196%)',
        brand: 'hsl(10.355 100% 61.373%)',
        'brand-soft': 'hsl(10.355 100% 61.373% / 0.13)',
        'brand-hover': 'hsl(10.294 87.179% 54.118%)',
        success: SUCCESS_LIGHT,
        'syntax-keyword': 'hsl(14.605 85.393% 34.902%)',
        'syntax-string': SYNTAX_STRING_LIGHT,
        'syntax-number': SYNTAX_NUMBER_LIGHT,
        radius: RADIUS,
      },
      dark: {
        background: 'hsl(210 11.111% 3.529%)',
        foreground: 'hsl(180 4% 95.098%)',
        card: 'hsl(200 9.677% 6.078%)',
        'card-foreground': 'hsl(180 4% 95.098%)',
        popover: 'hsl(200 9.677% 6.078%)',
        'popover-foreground': 'hsl(180 4% 95.098%)',
        primary: 'hsl(180 4% 95.098%)',
        'primary-foreground': 'hsl(20 17.647% 6.667%)',
        secondary: 'hsl(195 9.524% 8.235%)',
        'secondary-foreground': 'hsl(180 4% 95.098%)',
        muted: 'hsl(195 9.524% 8.235%)',
        'muted-foreground': 'hsl(198 5.747% 65.882%)',
        accent: 'hsl(195 9.524% 8.235%)',
        'accent-foreground': 'hsl(180 4% 95.098%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(180 4% 95.098%)',
        border: 'hsl(200 8.333% 14.118%)',
        'border-bright': 'hsl(197.143 7.071% 19.412%)',
        input: 'hsl(200 8.333% 14.118%)',
        ring: 'hsl(197.143 7.071% 19.412%)',
        brand: 'hsl(10.355 100% 61.373%)',
        'brand-soft': 'hsl(10.355 100% 61.373% / 0.13)',
        'brand-hover': 'hsl(10.116 100% 66.275%)',
        success: SUCCESS_DARK,
        'syntax-keyword': 'hsl(12 100% 72.549%)',
        'syntax-string': SYNTAX_STRING_DARK,
        'syntax-number': SYNTAX_NUMBER_DARK,
        radius: RADIUS,
      },
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    swatch: { light: 'hsl(212 20% 94.706%)', dark: 'hsl(212 14% 3.529%)' },
    tokens: {
      light: {
        background: 'hsl(212 20% 94.706%)',
        foreground: 'hsl(214 30% 6.667%)',
        card: 'hsl(210 70% 99.412%)',
        'card-foreground': 'hsl(214 30% 6.667%)',
        popover: 'hsl(210 70% 99.412%)',
        'popover-foreground': 'hsl(214 30% 6.667%)',
        primary: 'hsl(214 30% 6.667%)',
        'primary-foreground': 'hsl(210 70% 99.412%)',
        secondary: 'hsl(212 30% 96.667%)',
        'secondary-foreground': 'hsl(214 30% 6.667%)',
        muted: 'hsl(212 30% 96.667%)',
        'muted-foreground': 'hsl(210 9% 34.706%)',
        accent: 'hsl(212 30% 96.667%)',
        'accent-foreground': 'hsl(214 30% 6.667%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(210 70% 99.412%)',
        border: 'hsl(212 15% 86.667%)',
        'border-bright': 'hsl(212 13% 80.196%)',
        input: 'hsl(212 15% 86.667%)',
        ring: 'hsl(212 13% 80.196%)',
        brand: 'hsl(205 88% 52%)',
        'brand-soft': 'hsl(205 88% 52% / 0.13)',
        'brand-hover': 'hsl(205 88% 44%)',
        success: SUCCESS_LIGHT,
        'syntax-keyword': 'hsl(205 88% 34.902%)',
        'syntax-string': SYNTAX_STRING_LIGHT,
        'syntax-number': SYNTAX_NUMBER_LIGHT,
        radius: RADIUS,
      },
      dark: {
        background: 'hsl(212 14% 3.529%)',
        foreground: 'hsl(210 12% 95.098%)',
        card: 'hsl(212 12% 6.078%)',
        'card-foreground': 'hsl(210 12% 95.098%)',
        popover: 'hsl(212 12% 6.078%)',
        'popover-foreground': 'hsl(210 12% 95.098%)',
        primary: 'hsl(210 12% 95.098%)',
        'primary-foreground': 'hsl(214 30% 6.667%)',
        secondary: 'hsl(212 12% 8.235%)',
        'secondary-foreground': 'hsl(210 12% 95.098%)',
        muted: 'hsl(212 12% 8.235%)',
        'muted-foreground': 'hsl(210 10% 71%)',
        accent: 'hsl(212 12% 8.235%)',
        'accent-foreground': 'hsl(210 12% 95.098%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(210 12% 95.098%)',
        border: 'hsl(212 10% 14.118%)',
        'border-bright': 'hsl(212 10% 19.412%)',
        input: 'hsl(212 10% 14.118%)',
        ring: 'hsl(212 10% 19.412%)',
        brand: 'hsl(205 88% 52%)',
        'brand-soft': 'hsl(205 88% 52% / 0.13)',
        'brand-hover': 'hsl(205 88% 60%)',
        success: SUCCESS_DARK,
        'syntax-keyword': 'hsl(205 88% 72.549%)',
        'syntax-string': SYNTAX_STRING_DARK,
        'syntax-number': SYNTAX_NUMBER_DARK,
        radius: RADIUS,
      },
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    swatch: { light: 'hsl(120 18% 94.706%)', dark: 'hsl(140 12% 3.529%)' },
    tokens: {
      light: {
        background: 'hsl(120 18% 94.706%)',
        foreground: 'hsl(130 30% 6.667%)',
        card: 'hsl(120 70% 99.412%)',
        'card-foreground': 'hsl(130 30% 6.667%)',
        popover: 'hsl(120 70% 99.412%)',
        'popover-foreground': 'hsl(130 30% 6.667%)',
        primary: 'hsl(130 30% 6.667%)',
        'primary-foreground': 'hsl(120 70% 99.412%)',
        secondary: 'hsl(120 26% 96.667%)',
        'secondary-foreground': 'hsl(130 30% 6.667%)',
        muted: 'hsl(120 26% 96.667%)',
        'muted-foreground': 'hsl(126 9% 34.706%)',
        accent: 'hsl(120 26% 96.667%)',
        'accent-foreground': 'hsl(130 30% 6.667%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(120 70% 99.412%)',
        border: 'hsl(122 15% 86.667%)',
        'border-bright': 'hsl(126 13% 80.196%)',
        input: 'hsl(122 15% 86.667%)',
        ring: 'hsl(126 13% 80.196%)',
        brand: 'hsl(100 48% 52%)',
        'brand-soft': 'hsl(100 48% 52% / 0.13)',
        'brand-hover': 'hsl(100 48% 44%)',
        success: SUCCESS_LIGHT,
        'syntax-keyword': 'hsl(100 48% 34.902%)',
        'syntax-string': SYNTAX_STRING_LIGHT,
        'syntax-number': SYNTAX_NUMBER_LIGHT,
        radius: RADIUS,
      },
      dark: {
        background: 'hsl(140 12% 3.529%)',
        foreground: 'hsl(140 8% 95.098%)',
        card: 'hsl(140 10% 6.078%)',
        'card-foreground': 'hsl(140 8% 95.098%)',
        popover: 'hsl(140 10% 6.078%)',
        'popover-foreground': 'hsl(140 8% 95.098%)',
        primary: 'hsl(140 8% 95.098%)',
        'primary-foreground': 'hsl(130 30% 6.667%)',
        secondary: 'hsl(140 10% 8.235%)',
        'secondary-foreground': 'hsl(140 8% 95.098%)',
        muted: 'hsl(140 10% 8.235%)',
        'muted-foreground': 'hsl(140 8% 70%)',
        accent: 'hsl(140 10% 8.235%)',
        'accent-foreground': 'hsl(140 8% 95.098%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(140 8% 95.098%)',
        border: 'hsl(140 9% 14.118%)',
        'border-bright': 'hsl(140 9% 19.412%)',
        input: 'hsl(140 9% 14.118%)',
        ring: 'hsl(140 9% 19.412%)',
        brand: 'hsl(100 48% 52%)',
        'brand-soft': 'hsl(100 48% 52% / 0.13)',
        'brand-hover': 'hsl(100 48% 60%)',
        success: SUCCESS_DARK,
        'syntax-keyword': 'hsl(100 48% 72.549%)',
        'syntax-string': SYNTAX_STRING_DARK,
        'syntax-number': SYNTAX_NUMBER_DARK,
        radius: RADIUS,
      },
    },
  },
  {
    id: 'amber',
    label: 'Amber',
    swatch: { light: 'hsl(40 22% 94.706%)', dark: 'hsl(35 10% 3.529%)' },
    tokens: {
      light: {
        background: 'hsl(40 22% 94.706%)',
        foreground: 'hsl(30 30% 6.667%)',
        card: 'hsl(40 70% 99.412%)',
        'card-foreground': 'hsl(30 30% 6.667%)',
        popover: 'hsl(40 70% 99.412%)',
        'popover-foreground': 'hsl(30 30% 6.667%)',
        primary: 'hsl(30 30% 6.667%)',
        'primary-foreground': 'hsl(40 70% 99.412%)',
        secondary: 'hsl(40 32% 96.667%)',
        'secondary-foreground': 'hsl(30 30% 6.667%)',
        muted: 'hsl(40 32% 96.667%)',
        'muted-foreground': 'hsl(38 9% 34.706%)',
        accent: 'hsl(40 32% 96.667%)',
        'accent-foreground': 'hsl(30 30% 6.667%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(40 70% 99.412%)',
        border: 'hsl(40 16% 86.667%)',
        'border-bright': 'hsl(40 14% 80.196%)',
        input: 'hsl(40 16% 86.667%)',
        ring: 'hsl(40 14% 80.196%)',
        brand: 'hsl(24 92% 52%)',
        'brand-soft': 'hsl(24 92% 52% / 0.13)',
        'brand-hover': 'hsl(24 92% 44%)',
        success: SUCCESS_LIGHT,
        'syntax-keyword': 'hsl(24 92% 34.902%)',
        'syntax-string': SYNTAX_STRING_LIGHT,
        'syntax-number': SYNTAX_NUMBER_LIGHT,
        radius: RADIUS,
      },
      dark: {
        background: 'hsl(35 10% 3.529%)',
        foreground: 'hsl(35 8% 95.098%)',
        card: 'hsl(35 9% 6.078%)',
        'card-foreground': 'hsl(35 8% 95.098%)',
        popover: 'hsl(35 9% 6.078%)',
        'popover-foreground': 'hsl(35 8% 95.098%)',
        primary: 'hsl(35 8% 95.098%)',
        'primary-foreground': 'hsl(30 30% 6.667%)',
        secondary: 'hsl(35 9% 8.235%)',
        'secondary-foreground': 'hsl(35 8% 95.098%)',
        muted: 'hsl(35 9% 8.235%)',
        'muted-foreground': 'hsl(35 8% 71%)',
        accent: 'hsl(35 9% 8.235%)',
        'accent-foreground': 'hsl(35 8% 95.098%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(35 8% 95.098%)',
        border: 'hsl(35 8% 14.118%)',
        'border-bright': 'hsl(35 8% 19.412%)',
        input: 'hsl(35 8% 14.118%)',
        ring: 'hsl(35 8% 19.412%)',
        brand: 'hsl(24 92% 52%)',
        'brand-soft': 'hsl(24 92% 52% / 0.13)',
        'brand-hover': 'hsl(24 92% 60%)',
        success: SUCCESS_DARK,
        'syntax-keyword': 'hsl(24 92% 72.549%)',
        'syntax-string': SYNTAX_STRING_DARK,
        'syntax-number': SYNTAX_NUMBER_DARK,
        radius: RADIUS,
      },
    },
  },
  {
    id: 'violet',
    label: 'Violet',
    swatch: { light: 'hsl(275 18% 94.706%)', dark: 'hsl(275 10% 3.529%)' },
    tokens: {
      light: {
        background: 'hsl(275 18% 94.706%)',
        foreground: 'hsl(275 28% 6.667%)',
        card: 'hsl(280 70% 99.412%)',
        'card-foreground': 'hsl(275 28% 6.667%)',
        popover: 'hsl(280 70% 99.412%)',
        'popover-foreground': 'hsl(275 28% 6.667%)',
        primary: 'hsl(275 28% 6.667%)',
        'primary-foreground': 'hsl(280 70% 99.412%)',
        secondary: 'hsl(275 28% 96.667%)',
        'secondary-foreground': 'hsl(275 28% 6.667%)',
        muted: 'hsl(275 28% 96.667%)',
        'muted-foreground': 'hsl(275 9% 34.706%)',
        accent: 'hsl(275 28% 96.667%)',
        'accent-foreground': 'hsl(275 28% 6.667%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(280 70% 99.412%)',
        border: 'hsl(275 14% 86.667%)',
        'border-bright': 'hsl(275 12% 80.196%)',
        input: 'hsl(275 14% 86.667%)',
        ring: 'hsl(275 12% 80.196%)',
        brand: 'hsl(265 66% 58%)',
        'brand-soft': 'hsl(265 66% 58% / 0.13)',
        'brand-hover': 'hsl(265 66% 50%)',
        success: SUCCESS_LIGHT,
        'syntax-keyword': 'hsl(265 66% 34.902%)',
        'syntax-string': SYNTAX_STRING_LIGHT,
        'syntax-number': SYNTAX_NUMBER_LIGHT,
        radius: RADIUS,
      },
      dark: {
        background: 'hsl(275 10% 3.529%)',
        foreground: 'hsl(275 8% 95.098%)',
        card: 'hsl(275 10% 6.078%)',
        'card-foreground': 'hsl(275 8% 95.098%)',
        popover: 'hsl(275 10% 6.078%)',
        'popover-foreground': 'hsl(275 8% 95.098%)',
        primary: 'hsl(275 8% 95.098%)',
        'primary-foreground': 'hsl(275 28% 6.667%)',
        secondary: 'hsl(275 10% 8.235%)',
        'secondary-foreground': 'hsl(275 8% 95.098%)',
        muted: 'hsl(275 10% 8.235%)',
        'muted-foreground': 'hsl(275 8% 70%)',
        accent: 'hsl(275 10% 8.235%)',
        'accent-foreground': 'hsl(275 8% 95.098%)',
        destructive: DESTRUCTIVE,
        'destructive-foreground': 'hsl(275 8% 95.098%)',
        border: 'hsl(275 9% 14.118%)',
        'border-bright': 'hsl(275 9% 19.412%)',
        input: 'hsl(275 9% 14.118%)',
        ring: 'hsl(275 9% 19.412%)',
        brand: 'hsl(265 66% 58%)',
        'brand-soft': 'hsl(265 66% 58% / 0.13)',
        'brand-hover': 'hsl(265 66% 66%)',
        success: SUCCESS_DARK,
        'syntax-keyword': 'hsl(265 66% 72.549%)',
        'syntax-string': SYNTAX_STRING_DARK,
        'syntax-number': SYNTAX_NUMBER_DARK,
        radius: RADIUS,
      },
    },
  },
]

/** The themes in the order a picker offers them. */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id)

/** The default theme itself, so a fallback is a named theme rather than "whichever is first". */
const DEFAULT_THEME: Theme = THEMES[0]

/**
 * The theme with this id, or the default.
 *
 * A theme is looked up from persisted state and from a URL the app does not control, so an id that
 * names nothing has to resolve to *something* — a window with no colours would be a worse answer than
 * a window in the default theme. Used by the store for exactly that: a stored preference written
 * before this registry existed, or one edited by hand, lands on crimson rather than nowhere.
 */
export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME
}

/** Whether an id names a theme in the registry. */
export function isThemeId(id: unknown): id is ThemeId {
  return typeof id === 'string' && THEMES.some((theme) => theme.id === id)
}
