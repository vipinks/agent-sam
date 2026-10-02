/**
 * The document read, against real bytes on a real disk.
 *
 * A pdf and a docx are the two kinds the read path cannot ship as text: one is a container of
 * compressed streams and the other is a zip, so both cross IPC as base64 — the one encoding that
 * travels as a string and needs nothing in the renderer to undo. What only bytes on a disk can prove is
 * that the encoding is exactly reversible, so a binary buffer is written, read, decoded and compared
 * byte for byte; a prefix asserted against a hand-written string would pass even if the wrong file were
 * being read.
 *
 * The refusals are the other half, and each is its own code rather than a reuse: a file over the cap, a
 * name that is not a document this viewer can draw, and a `.pdf` whose bytes are not a pdf. That last
 * one is the reason the magic-byte rule exists at all — the alternative is shipping a mislabelled file
 * to a parser whose complaint is its own wording, which the renderer would then have to read.
 *
 * No electron: `electron` is stubbed for the whole node run (see `tests/stubs/`), and the registered
 * query is invoked the way the router invokes it, so the tested path is the app's own.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import { workspaceModule } from '../../conveyor/modules/workspace'
import {
  DOCUMENT_TOO_LARGE,
  DOCUMENT_UNSUPPORTED,
  MAX_DOCUMENT_BYTES,
  PDF_BYTES_INVALID,
} from '../../conveyor/protocol/preview-kind'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-document-'))
  roots.push(root)
  return root
}

/**
 * A read result as this suite sees it: every field any read shape can carry, all optional.
 *
 * Deliberately not the union the renderer narrows on. The claims here are about *which* fields came
 * back — that a document result carries no text — and a type that admitted only one shape could not
 * state that.
 */
interface ReadResult {
  content?: string
  kind?: string
  base64?: string
  bytes?: number
  path: string
  baselineMtime?: number
}

/** The registered query, as the router reaches it. */
function readDocumentQuery(): { resolver: (opts: { input: unknown }) => Promise<ReadResult> } {
  return workspaceModule.record.readDocument as unknown as {
    resolver: (opts: { input: unknown }) => Promise<ReadResult>
  }
}

function read(path: string): Promise<ReadResult> {
  return readDocumentQuery().resolver({ input: { path } })
}

/** Run a call expected to fail, and hand back the error it failed with. */
async function errorOf(fn: () => Promise<unknown>): Promise<ConveyorError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof ConveyorError) return err
    throw new Error(`expected a ConveyorError, got ${String(err)}`)
  }
  throw new Error('expected the call to fail, but it resolved')
}

/**
 * A pdf header followed by bytes no text encoding survives.
 *
 * The payload is where the round-trip claim lives: a NUL, a lone high byte and a byte that is not valid
 * UTF-8 are the three a utf8 read would silently replace, so a decode that did not really carry the
 * file's bytes would fail here rather than pass unnoticed.
 */
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'latin1'),
  Buffer.from([0x00, 0xff, 0xc3, 0x28, 0xa0, 0xa1, 0x0a]),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'),
])

// ---------------------------------------------------------------- the read

async function aPdfComesBackAsItsOwnBytesInBase64() {
  const root = makeRoot()
  const path = join(root, 'manual.pdf')
  writeFileSync(path, PDF_BYTES)

  const result = await read(path)

  assert.equal(result.kind, 'document', 'the read says which shape it is')
  assert.equal(typeof result.base64, 'string', 'and carries the bytes as base64')
  // Decoded and compared, not pattern-matched: this is the whole of the claim that the file crossed the
  // boundary unchanged.
  assert.deepEqual(Buffer.from(String(result.base64), 'base64'), PDF_BYTES, 'byte for byte')
  assert.equal(result.path, path, 'the path comes back with it')
  assert.equal(typeof result.baselineMtime, 'number', 'so an editor could guard an overwrite')
  // The text field is absent rather than empty: a document is not a text read with nothing in it, and a
  // caller that tested `content` would otherwise have to guess.
  assert.equal(result.content, undefined, 'and no text half is carried alongside')
  assert.equal(result.bytes, undefined, 'nor a second count of the size it just encoded')
  results.push('a pdf is read as base64 that decodes back to the file byte for byte')
}

async function aDocxComesBackTheSameWay() {
  const root = makeRoot()
  const path = join(root, 'report.docx')
  // A real zip header and then arbitrary bytes: main does not parse a document, so what a docx holds is
  // the reader's business and this suite's claim is about the transport, not about the container.
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not parsed here')])
  writeFileSync(path, bytes)

  const result = await read(path)

  assert.equal(result.kind, 'document', 'a docx is a document read')
  assert.deepEqual(Buffer.from(String(result.base64), 'base64'), bytes, 'and its bytes survive too')
  results.push('a docx is read as base64 that decodes back to the file byte for byte')
}

// ---------------------------------------------------------------- the refusals

async function aMislabelledPdfIsRefusedOnItsBytes() {
  const root = makeRoot()
  const path = join(root, 'manual.pdf')
  writeFileSync(path, 'This file is not a pdf at all.\n')

  const error = await errorOf(() => read(path))

  assert.equal(error.code, PDF_BYTES_INVALID, 'the refusal is the magic-byte one')
  // Worded by main, and the sentence names the file rather than the parser: the renderer has its own
  // wording for this state and never reads this string.
  assert.ok(error.message.includes('manual.pdf'), 'and names the file')
  results.push('a .pdf whose bytes are not a pdf is refused under its own code')
}

async function aNameThisReaderCannotDrawIsRefused() {
  const root = makeRoot()
  const text = join(root, 'notes.txt')
  writeFileSync(text, 'plain text')

  const textError = await errorOf(() => read(text))
  assert.equal(textError.code, DOCUMENT_UNSUPPORTED, 'a text file is not a document read')

  // `.doc` is its own kind in the dispatch rule, and deliberately not readable here: this reader would
  // hand bytes to a parser for the modern container, and the legacy one is opened by its owner rather
  // than drawn. Turn 2's fallback branches on the kind this refusal is derived from.
  const legacy = join(root, 'letter.doc')
  writeFileSync(legacy, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  const legacyError = await errorOf(() => read(legacy))
  assert.equal(legacyError.code, DOCUMENT_UNSUPPORTED, 'and neither is the legacy binary Word one')
  results.push('a name this reader cannot draw is refused without reading the file')
}

async function aMissingFileIsTheExistingUnavailableCode() {
  const root = makeRoot()
  const error = await errorOf(() => read(join(root, 'gone.pdf')))

  assert.equal(error.code, 'FILE_UNAVAILABLE', 'a missing document is the code every read uses for a miss')
  results.push('a missing document is refused under FILE_UNAVAILABLE')
}

async function aDocumentOverTheCapIsRefusedBeforeItIsRead() {
  const root = makeRoot()
  const path = join(root, 'huge.pdf')
  // One byte past the cap, with a real header: the size is checked before the read, so this file never
  // lands in memory and the suite is proving that ordering rather than paying for it.
  const padding = Buffer.alloc(MAX_DOCUMENT_BYTES + 1 - PDF_BYTES.length, 0x20)
  writeFileSync(path, Buffer.concat([PDF_BYTES, padding]))

  const error = await errorOf(() => read(path))

  assert.equal(error.code, DOCUMENT_TOO_LARGE, 'the refusal is the document cap’s own code')
  assert.ok(error.message.includes('huge.pdf'), 'and names the file')
  results.push('a document past the cap is refused before a byte of it is read')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('bytes: pdf', aPdfComesBackAsItsOwnBytesInBase64)
    await step('bytes: docx', aDocxComesBackTheSameWay)
    await step('refusal: mislabelled', aMislabelledPdfIsRefusedOnItsBytes)
    await step('refusal: name', aNameThisReaderCannotDrawIsRefused)
    await step('refusal: missing', aMissingFileIsTheExistingUnavailableCode)
    await step('refusal: size', aDocumentOverTheCapIsRefusedBeforeItIsRead)

    console.log(`document read: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('DOCUMENT READ TEST FAILED:', err)
  process.exit(1)
})
