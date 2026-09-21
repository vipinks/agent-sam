/**
 * The read path's second kind decision: is this file a workbook, how much of it is worth shipping,
 * and what does its container say about itself?
 *
 * Pure and shared rather than main-only, for the same reason `image.ts` and `write-guard.ts` are:
 * main owns the byte read and the parser, but the *rules* — a name in and a kind out, a sheet in and a
 * truncation flag out, a byte buffer in and "this is locked" out — are decisions a test should be able
 * to make without a disk and without a workbook. `conveyor/modules/spreadsheet-parse.ts` imports them;
 * the renderer imports nothing from here, because what the pane needs travels in the read's own result
 * rather than in a second lookup.
 *
 * Nothing here parses anything. That is deliberate, and it is what keeps this file answerable on plain
 * arrays and plain buffers: a cap can be proven without seeding a file a thousand rows long, and the
 * encrypted question can be settled from the container's own bytes without a decryption library —
 * which matters, because neither candidate parser can decrypt anything.
 */

/**
 * The codes this path can refuse a read under.
 *
 * Named and exported rather than written out at the throw site, because the renderer branches on the
 * string and a typo there would be a second, silently unreachable state. Each is its own code rather
 * than a reuse of `FILE_TOO_LARGE`, for the same reason the image cap has one: the limits are different
 * numbers and the ways out differ, so the pane words them differently.
 *
 * `SPREADSHEET_ENCRYPTED` is neither a size nor a syntax problem — the bytes are intact and the viewer
 * simply cannot show them — and it is the only one of the three whose sentence is about the file rather
 * than about the attempt to read it.
 */
export const SPREADSHEET_TOO_LARGE = 'SPREADSHEET_TOO_LARGE'
export const SPREADSHEET_PARSE_FAILED = 'SPREADSHEET_PARSE_FAILED'
export const SPREADSHEET_ENCRYPTED = 'SPREADSHEET_ENCRYPTED'

/**
 * How large a workbook may be before the reader refuses it.
 *
 * Eight times the text cap and larger than the image cap, because a workbook is the one format here
 * whose useful content is a small fraction of its bytes: a modern spreadsheet carries styles, themes,
 * shared strings and caches, so 8 MB of file is routinely a few thousand visible rows.
 *
 * It is refused rather than trimmed because a partially-read container cannot be parsed at all. The
 * caps below trim the *result*, which is something a reader can be told about; trimming the *input*
 * would only produce a corrupt workbook. The size is checked against the file before a byte is read, so
 * an oversized workbook never lands in memory — the ordering the image path already uses.
 */
export const MAX_SPREADSHEET_BYTES = 8 * 1024 * 1024

/**
 * The per-sheet caps, and the cap on sheets.
 *
 * These bound what crosses IPC rather than what is parsed, and they are why a workbook read is a
 * *preview*: 1000 rows by 64 columns by 20 sheets is at most 1.28 million cells, a table a human
 * scrolls rather than reads and a payload the renderer can draw in one pass.
 *
 * They cap display, never fidelity. A sheet past them carries its own flag saying so, and the formula
 * and chart counts describe the whole file, so a reader is never told the file is smaller than it is.
 */
export const MAX_SHEET_ROWS = 1000
export const MAX_SHEET_COLUMNS = 64
export const MAX_SHEETS = 20

/** The one kind this path answers with. A second would be a second decision, not a variant. */
export type SpreadsheetKind = 'spreadsheet'

/**
 * The extensions this path treats as a workbook.
 *
 * `xlsx` and `xls` only. `csv` is deliberately absent even though a table viewer could draw one: a csv
 * is a text file, the viewer already reads it as text with its own highlighting and its own cap, and
 * claiming it here would take a working path away from the kind that handles it — a regression dressed
 * as a feature. It would also leave the fidelity report with nothing true to say, since a csv has no
 * formulas, no charts, and no container to ask.
 *
 * `xlsm` and `xlsb` are absent too. The parser reads the first, but neither is in this turn's scope,
 * and widening the set quietly would be a behaviour change nothing tests. Adding one is a one-line
 * change here when it is wanted.
 */
const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx', 'xls'])

/**
 * Whether a path names a workbook.
 *
 * Read exactly the way `imageKindForPath` reads its own: the last dot of the last segment, lower-cased,
 * never the directory above — so a folder called `sheets.xlsx` cannot make the text files inside it
 * open as a table, and `REPORT.XLSX` is still a workbook on a disk that spells it that way.
 */
export function spreadsheetKindForPath(path: string): SpreadsheetKind | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  // `dot <= 0` covers both no dot at all and a dot that only leads the name.
  if (dot <= 0) return null

  const extension = name.slice(dot + 1).toLowerCase()
  return SPREADSHEET_EXTENSIONS.has(extension) ? 'spreadsheet' : null
}

/**
 * Whether a workbook of this size is past the cap.
 *
 * Inclusive at the boundary, like the image cap: a file of exactly `MAX_SPREADSHEET_BYTES` is read and
 * one byte more is refused. A function of one number rather than a comparison inline at the call site,
 * so the off-by-one has somewhere to be tested.
 */
export function spreadsheetOverCap(bytes: number): boolean {
  return bytes > MAX_SPREADSHEET_BYTES
}

/**
 * What the container and the sheets say about the file, kept apart from what the sheets contain.
 *
 * Each `has…` sits beside its count rather than being derived from it at the caption, because the two
 * answer different questions: a caption wants "3 formulas" and a caller wants "there are formulas
 * here", and a caller holding only the count would have to re-derive `> 0` — a second place to get it
 * wrong.
 *
 * `encrypted` is false in every result that was returned at all, and that is not a field that can
 * never be true by accident: an encrypted container is refused with `SPREADSHEET_ENCRYPTED` before a
 * sheet is shaped, so a caller holding a report knows the question was asked. It is carried anyway so
 * the report is total, because a shape with no hole in it cannot be misread as "not yet asked".
 */
export interface SpreadsheetFidelity {
  hasFormulas: boolean
  /** Formulas across every sheet of the file, including sheets and rows the caps left out. */
  formulaCount: number
  hasCharts: boolean
  /**
   * Distinct chart parts found in the container.
   *
   * A count rather than the flag alone, because the caption names a number and a flag cannot honestly
   * produce one: "1 chart" read from a boolean would be a guess that looks like a fact. It is measured
   * from the archive's own entry names, the only place a chart is visible without a chart API — and
   * neither candidate parser has one.
   */
  chartCount: number
  hasConditionalFormatting: boolean
  encrypted: boolean
}

/**
 * One sheet, already shaped for display: rows of display strings, and whether anything was left out.
 *
 * The truncation flags are notes, not errors, and they are per sheet because the caps are per sheet:
 * one sheet can be past the row cap while the next is four rows long, and a single flag for the whole
 * read could not say which.
 *
 * `rows` carries the header row as its own first entry. The viewer draws it as a header, but the read
 * does not decide that — a spreadsheet's first row is a header only by convention, and a read that
 * dropped it would be dropping data on a guess.
 */
export interface SpreadsheetSheet {
  name: string
  rows: string[][]
  /** Rows existed beyond the row cap. */
  truncatedRows: boolean
  /** Columns existed beyond the column cap. */
  truncatedColumns: boolean
}

/** The sheets of one read, with how many the sheet cap left out. */
export interface SpreadsheetSheets {
  sheets: SpreadsheetSheet[]
  sheetsOmitted: number
}

/**
 * Shape one sheet: keep what fits, and say what did not.
 *
 * The flags come from the sheet's own *extent* — how large it really is — rather than from the length
 * of the array handed in, and the two differ on the path that matters: the read bounds its loop with
 * the caps, so a hundred-thousand-row sheet never becomes an array it will immediately throw away, and
 * then hands this function the extent it read off the sheet plus the window of rows it actually built.
 * Deciding from `rows.length` there would compare the cap against the cap and report every large sheet
 * as complete. Passing no extent falls back to the array itself, which is what makes the rule callable
 * on a plain array of strings in a test.
 *
 * The comparison is `>` and not `>=`, so a sheet of exactly the cap is not truncated: an off-by-one
 * either way would lose a row silently or claim a loss that did not happen.
 *
 * Rows are cut before columns and both cuts are on the same array, so what comes back is the top-left
 * block of the sheet — what a reader sees when they open the file and look at the corner. A ragged
 * sheet is not padded: a short row stays short, because padding would claim those cells are empty
 * rather than that they were never there.
 */
export function shapeSheet(
  name: string,
  rows: readonly (readonly string[])[],
  extent: { rows: number; columns: number } = {
    rows: rows.length,
    columns: rows.reduce((widest, row) => Math.max(widest, row.length), 0),
  }
): SpreadsheetSheet {
  // Any row being wider than the cap is the condition, not the first row being wide: a sheet whose
  // header is three columns and whose tenth row is two hundred is truncated even though the row a
  // reader notices first is not.
  const truncatedColumns = extent.columns > MAX_SHEET_COLUMNS

  return {
    name,
    rows: rows.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLUMNS)),
    truncatedRows: extent.rows > MAX_SHEET_ROWS,
    truncatedColumns,
  }
}

/**
 * Shape every sheet, keeping the first `MAX_SHEETS`.
 *
 * Order is preserved rather than chosen, because a workbook's sheet order is its author's and a viewer
 * that sorted would be reordering someone's document. An empty workbook keeps zero sheets and reports
 * zero omitted, which is true of it and is what the viewer draws as an empty file.
 *
 * `totalSheets` is how many the file held when the caller shaped only some of them. The read bounds its
 * own work with `MAX_SHEETS` — parsing a hundred sheets to show twenty would be paying for the eighty
 * it is about to drop — so the sheets it cannot see are the ones whose count it has to be told.
 */
export function shapeSheets(sheets: readonly SpreadsheetSheet[], totalSheets?: number): SpreadsheetSheets {
  const held = sheets.slice(0, MAX_SHEETS)
  return {
    sheets: held,
    sheetsOmitted: Math.max(0, (totalSheets ?? sheets.length) - held.length),
  }
}

/** The eight bytes every OLE2 compound-file container starts with. */
const CFB_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** The four bytes every zip starts with, which is what an unencrypted OOXML file is. */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

/** Whether `bytes` starts with `prefix`. */
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

/**
 * The first index of `needle` in `haystack`, or -1.
 *
 * Written out rather than taken from `Buffer`, because this file is pure and its tests hand it plain
 * `Uint8Array`s; a `Buffer`-typed signature would tie the rule to a Node global for no gain. The search
 * is the obvious one, run over a few megabytes once per read, which is not a cost worth a cleverer
 * algorithm.
 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0
  const last = haystack.length - needle.length
  outer: for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** `name` as a compound-file directory entry stores it: UTF-16LE, no terminator. */
function utf16le(name: string): Uint8Array {
  const bytes = new Uint8Array(name.length * 2)
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = (code >> 8) & 0xff
  }
  return bytes
}

/**
 * Whether these bytes are an encrypted workbook.
 *
 * The question is answered from the container rather than from a parser, and it has to be: an encrypted
 * OOXML file is not a zip at all. It is an OLE2 compound file holding an `EncryptionInfo` stream and an
 * `EncryptedPackage` stream, and neither candidate parser can decrypt one. Handing those bytes to a zip
 * reader produces a syntax error, which the read would report as "unparseable" — the wrong sentence,
 * because the file is perfectly well formed and merely locked. So the container is asked first and the
 * parser is never reached.
 *
 * The magic alone is deliberately not the answer. A legacy `.xls` is the *same* OLE2 container, so
 * "starts with the compound-file magic" would report every Excel 97 file as encrypted — a confident
 * wrong answer, on the one other format this path accepts. What separates the two is the stream name:
 * `EncryptionInfo` is present when and only when the container is encrypted, and a compound file stores
 * its directory names as UTF-16LE, so the name is visible in the raw bytes without walking the
 * container's allocation tables at all.
 *
 * Both halves are required, so a plain `.xlsx` with the literal string inside a cell answers `false`:
 * it is a zip, and the first half already refuses it.
 */
export function isEncryptedWorkbook(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, CFB_MAGIC)) return false
  return indexOfBytes(bytes, utf16le('EncryptionInfo')) !== -1
}

/** The archive path a chart part is stored under, e.g. `xl/charts/chart1.xml`. */
const CHART_PART_PREFIX = 'xl/charts/chart'
const CHART_PART_SUFFIX = '.xml'

/**
 * The distinct chart parts this container holds.
 *
 * A chart has no API in either candidate parser — one reads images but not charts, the other reads
 * neither — so the container is asked directly. A zip stores each entry's *name* uncompressed even
 * when the entry's data is deflated, so a chart part announces itself in the raw bytes exactly as
 * `xl/worksheets/sheet1.xml` does, which is what makes this a measurement rather than a hopeful scan.
 *
 * A `Set` is what makes it a count rather than a doubled one: a well-formed archive carries each name
 * twice, once in the local file header and once in the central directory, so counting raw occurrences
 * would report two charts for every one and the caption would be wrong by a factor of two on every
 * file. Collecting the names is correct for an archive holding the name once as well as twice.
 *
 * The zip magic is required, so a text file containing the prefix is not a workbook with charts: chart
 * parts exist only inside an archive.
 */
export function chartParts(bytes: Uint8Array): string[] {
  if (!startsWith(bytes, ZIP_MAGIC)) return []

  const prefix = new Uint8Array([...CHART_PART_PREFIX].map((character) => character.charCodeAt(0)))
  const names = new Set<string>()

  let searchFrom = 0
  for (;;) {
    const found = indexOfBytes(bytes.subarray(searchFrom), prefix)
    if (found === -1) break
    const start = searchFrom + found + prefix.length

    // The characters between the prefix and the suffix are the part's own number. Read as digits and
    // required to be non-empty, so `xl/charts/chart.xml` — not something Excel writes — is not counted
    // as a chart named by an empty number.
    let end = start
    while (end < bytes.length && bytes[end] >= 0x30 && bytes[end] <= 0x39) end += 1
    if (end === start) {
      searchFrom = start
      continue
    }

    const suffix = bytes.subarray(end, end + CHART_PART_SUFFIX.length)
    if (String.fromCharCode(...suffix) === CHART_PART_SUFFIX) {
      names.add(`${CHART_PART_PREFIX}${String.fromCharCode(...bytes.subarray(start, end))}${CHART_PART_SUFFIX}`)
    }
    searchFrom = start
  }

  return [...names]
}

/**
 * A cell's value as the string a reader would see in it.
 *
 * Takes the *value* rather than a cell, so it is a function of plain data and can be tested on literals
 * — and so this file needs no parser to compile. The shapes below are the ones a workbook read can
 * produce, and each is handled rather than stringified generically, because `String(value)` on a
 * formula object would render `[object Object]` into a table cell.
 *
 * Two decisions are worth stating because neither is a computation:
 *
 * A formula cell shows its *cached* result. Nothing here evaluates a formula — no library does, without
 * a calculation engine — so the only number available is the one the file stored beside the formula.
 * When the writer cached nothing, the cell shows nothing: that is a real emptiness in the file, and
 * substituting the formula text would put a string in a numeric column and call it data.
 *
 * A date is rendered from its own local calendar fields rather than from `toISOString`, which would
 * shift the day for every reader east or west of UTC. A date in a spreadsheet is a calendar day, and
 * the one the author typed is the one to show.
 */
export function cellValueToDisplay(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  // Excel's own spelling, rather than JavaScript's: a boolean in a cell reads TRUE or FALSE.
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return formatDate(value)
  if (typeof value !== 'object') return ''

  const cell = value as {
    formula?: unknown
    sharedFormula?: unknown
    result?: unknown
    richText?: unknown
    text?: unknown
    error?: unknown
  }

  // A formula, in either of the two ways a workbook records one. The result is recursed rather than
  // stringified so a cached date or boolean keeps the handling above.
  if (cell.formula !== undefined || cell.sharedFormula !== undefined) {
    return cell.result === undefined ? '' : cellValueToDisplay(cell.result)
  }

  const rich = cell.richText
  if (Array.isArray(rich)) {
    return rich
      .map((run) => (typeof run === 'object' && run !== null ? String((run as { text?: unknown }).text ?? '') : ''))
      .join('')
  }

  // An error cell, and a hyperlink cell, both of which carry their visible text in a known place.
  if (typeof cell.error === 'string') return cell.error
  if (typeof cell.text === 'string') return cell.text

  return ''
}

/**
 * A date as a spreadsheet shows one: the calendar day, and the time only when there is one.
 *
 * Local fields on purpose — see `cellValueToDisplay`. Midnight prints as a bare day because that is
 * what a date-typed cell almost always is, and printing `00:00:00` beside every one of them would be
 * noise on the common case to serve the rare one.
 */
function formatDate(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0
  if (!hasTime) return day
  return `${day} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}
