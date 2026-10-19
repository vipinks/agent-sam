/**
 * The glyphs a Buddy can carry, and the one lookup every surface draws them through.
 *
 * A Buddy's `glyph` is an *id*, not the character the badge used to hold: the record stores which mark was
 * chosen, and this module is the only place that says what that id looks like. Three surfaces ask it —
 * the settings card, the header's chip and the picker's rows — so a mark is drawn the same way in all
 * three, and the editor's picker is the same list rather than a copy of it.
 *
 * The ids are permanent. The twelve single-letter ids are what the palette shipped with and what stored
 * records already carry, so they keep their letters and their icons forever; every id added since is the
 * lucide icon's own name, which says what it draws without a second table to read. A record naming an id
 * this build does not know is not an error — `buddyMonogram` is what it falls back to, so an old record
 * still draws a mark rather than an empty plate.
 */
import {
  AlertTriangle,
  Atom,
  BookOpen,
  Calculator,
  ChartColumn,
  ChartLine,
  ClipboardList,
  Feather,
  FileText,
  FlaskConical,
  GitBranch,
  GraduationCap,
  Hammer,
  KeyRound,
  Leaf,
  Mail,
  Megaphone,
  MessageSquare,
  Microscope,
  Newspaper,
  NotebookPen,
  Pencil,
  PenLine,
  Quote,
  Search,
  Shapes,
  Sigma,
  Table2,
  Terminal,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/** One choice in the palette: the id a record stores, the word a screen reader hears, and the icon. */
export interface BuddyGlyph {
  /** What a record's `glyph` field holds. Permanent once shipped: a rename would orphan every saved record. */
  readonly id: string
  /** The mark's own name, said beside the icon in the picker's button label. */
  readonly label: string
  /** The lucide component, drawn at whatever size and plate the surface already uses. */
  readonly Icon: LucideIcon
}

/**
 * The palette, in the order the picker lays it out: the twelve the app shipped with first, then the wider
 * set grouped by the family it belongs to — documents, writing, analysis, communication, tools, science,
 * nature, shapes.
 *
 * Additive only. Every existing id keeps its name and its icon forever, because a stored record holds the
 * id and nothing else — dropping one would leave the record silently drawing a fallback monogram.
 */
export const BUDDY_GLYPHS: readonly BuddyGlyph[] = [
  // The twelve the palette shipped with. Their letter ids are what stored records already carry, so they
  // are never renamed; each letter still draws the mark it always drew.
  { id: 'A', label: 'A', Icon: AlertTriangle },
  { id: 'B', label: 'B', Icon: BookOpen },
  { id: 'C', label: 'C', Icon: ChartColumn },
  { id: 'F', label: 'F', Icon: FileText },
  { id: 'G', label: 'G', Icon: GitBranch },
  { id: 'K', label: 'K', Icon: KeyRound },
  { id: 'M', label: 'M', Icon: MessageSquare },
  { id: 'P', label: 'P', Icon: Pencil },
  { id: 'S', label: 'S', Icon: Search },
  { id: 'T', label: 'T', Icon: Table2 },
  { id: 'W', label: 'W', Icon: Wrench },
  { id: 'Z', label: 'Z', Icon: Zap },

  // Writing.
  { id: 'PenLine', label: 'Pen', Icon: PenLine },
  { id: 'Feather', label: 'Feather', Icon: Feather },
  { id: 'Quote', label: 'Quote', Icon: Quote },

  // Documents.
  { id: 'NotebookPen', label: 'Notebook', Icon: NotebookPen },
  { id: 'Newspaper', label: 'News', Icon: Newspaper },
  { id: 'ClipboardList', label: 'Checklist', Icon: ClipboardList },

  // Analysis.
  { id: 'ChartLine', label: 'Chart', Icon: ChartLine },
  { id: 'Calculator', label: 'Calculator', Icon: Calculator },
  { id: 'Sigma', label: 'Sigma', Icon: Sigma },

  // Communication.
  { id: 'Mail', label: 'Mail', Icon: Mail },
  { id: 'Megaphone', label: 'Megaphone', Icon: Megaphone },
  { id: 'Users', label: 'Users', Icon: Users },

  // Tools.
  { id: 'Hammer', label: 'Hammer', Icon: Hammer },
  { id: 'Terminal', label: 'Terminal', Icon: Terminal },

  // Science, including the cap a teaching mark asks for.
  { id: 'FlaskConical', label: 'Flask', Icon: FlaskConical },
  { id: 'Microscope', label: 'Microscope', Icon: Microscope },
  { id: 'Atom', label: 'Atom', Icon: Atom },
  { id: 'GraduationCap', label: 'Cap', Icon: GraduationCap },

  // Nature and shapes.
  { id: 'Leaf', label: 'Leaf', Icon: Leaf },
  { id: 'Shapes', label: 'Shapes', Icon: Shapes },
]

/** The glyph an id names, or `null` when this build has no mark by that name. */
export function buddyGlyphFor(id: string | null | undefined): BuddyGlyph | null {
  if (typeof id !== 'string' || id === '') return null
  return BUDDY_GLYPHS.find((glyph) => glyph.id === id) ?? null
}

/**
 * The character a plate draws when the id resolves to nothing.
 *
 * A record from an older build carries a letter rather than an id, and one from a newer build may carry an
 * id this build has no mark for. Neither is a failure to report: the first character of what the record
 * holds is the closest thing to the mark it meant, and it keeps the plate from being drawn empty.
 */
export function buddyMonogram(id: string | null | undefined): string {
  const mark = typeof id === 'string' ? id.trim() : ''
  return mark === '' ? '?' : mark.charAt(0).toUpperCase()
}
