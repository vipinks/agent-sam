import { z } from 'zod'

/**
 * The two display preferences that are about a conversation as drawn: which side the user's own bubbles
 * sit on, and how large the message text is painted.
 *
 * Pure and shared, the way `protocol/terminal-preferences` is: the ids, the sizes and the schemas are the
 * one declaration both the Settings control and the store are held to, so the presets the section offers
 * and the ids main accepts cannot drift apart. The store is named `appearance-preferences` after this
 * module because these are the two values it holds and nothing else.
 *
 * The pixel size of each preset and the Tailwind class it paints with are both written out, because the
 * class cannot be assembled from the number: Tailwind reads source text, so `text-[${pixels}px]` is not a
 * class the stylesheet contains. Two declarations of one number is a drift risk, so the node suite reads
 * each class back and holds it against the pixels beside it.
 */

/** Which side of the transcript a message's bubble sits on. */
export type BubbleAlignment = 'split' | 'same-side'

/** Every alignment the app paints, in the order the control offers them: today's rendering first. */
export const BUBBLE_ALIGNMENTS = ['split', 'same-side'] as const

/** What the control calls each alignment, so the ids and the words have one home. */
export const BUBBLE_ALIGNMENT_LABELS: Record<BubbleAlignment, string> = {
  split: 'Split',
  'same-side': 'Same side',
}

/**
 * The alignment a launch draws with — the user's bubbles to the right, the agent's to the left.
 *
 * This is the rendering the chat pane has always had, so a user who never opens Settings reads an
 * unchanged transcript; the preference exists to offer the other arrangement, not to change this one.
 */
export const DEFAULT_BUBBLE_ALIGNMENT: BubbleAlignment = 'split'

/** The four message sizes the app may paint, as ids. */
export const FONT_PRESET_IDS = ['small', 'default', 'large', 'largest'] as const

/** One of the four message sizes. */
export type FontPresetId = (typeof FONT_PRESET_IDS)[number]

/** One size the message body may be painted at. */
export interface FontPreset {
  /** The size, in pixels. */
  pixels: number
  /** What the control calls this size. */
  label: string
  /** The Tailwind class the message body carries at this size. Fixed, so the stylesheet holds it. */
  sizeClass: string
}

/**
 * The four sizes, keyed by id, smallest first.
 *
 * `default` is the size a message body has always been drawn at — `text-[13px]`, which is what the bubble
 * carries today — so the default preset *is* today's rendering rather than an approximation of it.
 */
export const FONT_PRESETS: Record<FontPresetId, FontPreset> = {
  small: { pixels: 12.5, label: 'Small', sizeClass: 'text-[12.5px]' },
  default: { pixels: 13, label: 'Default', sizeClass: 'text-[13px]' },
  large: { pixels: 15, label: 'Large', sizeClass: 'text-[15px]' },
  largest: { pixels: 17, label: 'Largest', sizeClass: 'text-[17px]' },
}

/** The preset a launch paints with: the message size this app has always had. */
export const DEFAULT_FONT_PRESET: FontPresetId = 'default'

/**
 * What the pair's check answered: the pair to paint with, or the field that refused and the words for it.
 *
 * `field` is for the caller's branching — the suite asserts on it — and `message` is what a reader is
 * shown. They are deliberately not the same thing: a caller that branched on the sentence would be
 * branching on wording.
 */
export type AppearanceCheck =
  | { ok: true; alignment: BubbleAlignment; fontPreset: FontPresetId }
  | { ok: false; field: 'alignment' | 'fontPreset'; message: string }

/** The offered ids as a reader meets them in a sentence: `A, B or C`. */
function offered(ids: readonly string[], labels: Record<string, string>): string {
  const words = ids.map((id) => labels[id])
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

/**
 * Whether a pair is one this app will paint, and which field refused when it is not.
 *
 * Both fields are checked, alignment first, so a state with two bad ids is refused the same way every
 * time. An *absent* id is refused as its own field rather than taken as the default: a stored state that
 * named no alignment is not a state anyone chose, and silently painting it as split would hide a bad file
 * behind a preference the user never set.
 *
 * Pure, and the only rule about appearance ids there is: the Settings control narrows what a Select hands
 * back through it, and main's schemas refuse the same ids at the boundary a payload crosses.
 */
export function checkAppearance(input: { alignment?: unknown; fontPreset?: unknown }): AppearanceCheck {
  const alignment = input.alignment
  if (typeof alignment !== 'string' || !(BUBBLE_ALIGNMENTS as readonly string[]).includes(alignment)) {
    return {
      ok: false,
      field: 'alignment',
      message: `Choose ${offered(BUBBLE_ALIGNMENTS, BUBBLE_ALIGNMENT_LABELS)}.`,
    }
  }

  const fontPreset = input.fontPreset
  if (typeof fontPreset !== 'string' || !(FONT_PRESET_IDS as readonly string[]).includes(fontPreset)) {
    const labels = Object.fromEntries(FONT_PRESET_IDS.map((id) => [id, FONT_PRESETS[id].label]))
    return { ok: false, field: 'fontPreset', message: `Choose ${offered(FONT_PRESET_IDS, labels)}.` }
  }

  return { ok: true, alignment: alignment as BubbleAlignment, fontPreset: fontPreset as FontPresetId }
}

/**
 * The alignment as the wire carries it, for the store's schema: the same ids the control offers, refused
 * by main as well as by the control.
 */
export const alignmentSchema = z.enum(BUBBLE_ALIGNMENTS)

/** The font preset as the wire carries it, for the same reason. */
export const fontPresetSchema = z.enum(FONT_PRESET_IDS)
