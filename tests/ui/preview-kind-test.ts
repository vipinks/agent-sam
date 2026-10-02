/**
 * The dispatch rule: which kind of file a name says it is, and what bytes say about themselves.
 *
 * This is the one decision the viewer's dispatch makes, and it is made from the *name* alone — the
 * extension is the only thing the renderer can know about a path before it has the bytes, and the
 * answer has to exist in the same render as the path so that the right surface is mounted rather than
 * corrected a moment later. The byte rules beside it are the second half of the same question: a
 * `.pdf` whose first four bytes are not `%PDF` is not a PDF the viewer can draw, and saying so from the
 * bytes is what keeps that refusal out of a parser's message string.
 *
 * Every extension here is checked in the case a camera or a Windows dialog writes (`.PDF`, `.DocX`) and
 * against the names a naive split gets wrong — no extension at all, a dot that only leads the name, and
 * a directory whose name carries the extension.
 */
import { strict as assert } from 'node:assert'
import {
  MAX_DOCUMENT_BYTES,
  documentOverCap,
  looksLikePdf,
  looksLikeZip,
  previewKind,
} from '../../conveyor/protocol/preview-kind'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

// ---------------------------------------------------------------- the name decides

function everyKindAMeaningfulNameMapsTo() {
  assert.equal(previewKind('C:/w/manual.pdf'), 'pdf', 'a pdf')
  assert.equal(previewKind('C:/w/report.docx'), 'docx', 'a modern Word document')
  assert.equal(previewKind('C:/w/legacy/report.doc'), 'doc', 'and the binary Word one, as its own kind')
  assert.equal(previewKind('C:/w/logo.png'), 'image', 'a picture')
  assert.equal(previewKind('C:/w/icon.svg'), 'image', 'including the one that is a document')
  assert.equal(previewKind('C:/w/notes.md'), 'markdown', 'markdown')
  assert.equal(previewKind('C:/w/book.xlsx'), 'spreadsheet', 'a workbook')
  assert.equal(previewKind('C:/w/src/app.ts'), 'other', 'and everything the viewer has no surface for')
  assert.equal(previewKind('C:/w/archive.zip'), 'other', 'a zip is not a Word document')
  results.push('pdf, docx, doc, image, markdown, spreadsheet and other are each named')
}

function theExtensionIsReadInWhateverCaseItArrived() {
  assert.equal(previewKind('C:/w/MANUAL.PDF'), 'pdf', 'an uppercase extension still names a pdf')
  assert.equal(previewKind('C:/w/Report.DocX'), 'docx', 'a mixed-case one still names a document')
  assert.equal(previewKind('C:/docs/Guide.MD'), 'markdown', 'and markdown too')
  assert.equal(previewKind('C:/w/SHOT.PNG'), 'image', 'the image list is folded the same way')
  assert.equal(previewKind('C:\\w\\legacy\\Report.DOC'), 'doc', 'a backslash path reads the same')
  results.push('every kind is recognised whatever case the extension is spelled in')
}

function namesWithNoExtensionAreOther() {
  assert.equal(previewKind('C:/w/Makefile'), 'other', 'a name with no dot names nothing')
  assert.equal(previewKind('C:/w/.gitignore'), 'other', 'a dot that only leads the name is not an extension')
  assert.equal(previewKind(''), 'other', 'and an empty name is not one either')
  // The directory above is never consulted: a folder named like a document cannot make the files inside
  // it documents.
  assert.equal(previewKind('C:/reports.pdf/notes.txt'), 'other', 'only the last segment decides')
  results.push('no extension, a leading dot and a dotted directory all read as other')
}

function theDocumentExtensionsDoNotOverlapTheOtherKinds() {
  // `.doc` beside `.docx` rather than folded into it: the two are different containers, and Turn 2's
  // fallback for the legacy one branches on exactly this difference.
  assert.notEqual(previewKind('C:/w/a.doc'), previewKind('C:/w/a.docx'), 'doc and docx are two kinds')
  // A workbook written by a legacy binary format is not a document, and a `.doc` is not a workbook.
  assert.equal(previewKind('C:/w/a.xls'), 'spreadsheet', 'the legacy workbook is still a workbook')
  results.push('doc, docx and the neighbouring kinds stay distinct')
}

// ---------------------------------------------------------------- the bytes decide

function aPdfStartsWithItsOwnSignature() {
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1')), true, 'a modern header')
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.4', 'latin1')), true, 'a bare one, with nothing after it')
  results.push('a buffer that starts with %PDF is a pdf')
}

function bytesThatAreNotAPdfAreRefused() {
  assert.equal(looksLikePdf(Buffer.from('PK\u0003\u0004word/document.xml')), false, 'a zip is not a pdf')
  assert.equal(looksLikePdf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), false, 'nor is markup')
  assert.equal(looksLikePdf(Buffer.alloc(0)), false, 'nor is nothing at all')
  // A header further in does not count: the rule is a prefix, so a file that merely mentions a pdf is
  // refused rather than handed to a parser that would fail with its own wording.
  assert.equal(looksLikePdf(Buffer.from('notes about %PDF files')), false, 'nor is a mention of one')
  assert.equal(looksLikePdf(Buffer.from('%PD')), false, 'nor a prefix of the signature')
  results.push('bytes that do not start with %PDF are refused')
}

function aDocxStartsWithTheZipSignature() {
  assert.equal(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), true, 'a zip local header')
  assert.equal(looksLikeZip(Buffer.from('not a container')), false, 'plain text is not a container')
  assert.equal(looksLikeZip(Buffer.alloc(0)), false, 'nor is an empty buffer')
  results.push('a buffer that starts with the zip signature is a container')
}

// ---------------------------------------------------------------- the cap

function theDocumentCapIsItsOwnNumber() {
  // Larger than the workbook cap, because a pdf is a container of already-compressed streams: a scanned
  // document is megabytes of images that cannot be trimmed without destroying the file.
  assert.equal(MAX_DOCUMENT_BYTES, 16 * 1024 * 1024, 'the document cap is sixteen megabytes')
  // Inclusive at the boundary, like every other cap here: exactly the cap is readable and one byte more
  // is refused, stated as a function so the off-by-one has somewhere to fail.
  assert.equal(documentOverCap(MAX_DOCUMENT_BYTES), false, 'a file of exactly the cap is readable')
  assert.equal(documentOverCap(MAX_DOCUMENT_BYTES + 1), true, 'one byte past it is not')
  results.push('the cap is sixteen megabytes and is inclusive at the boundary')
}

// ---------------------------------------------------------------- harness

async function main() {
  await step('names: kinds', everyKindAMeaningfulNameMapsTo)
  await step('names: case', theExtensionIsReadInWhateverCaseItArrived)
  await step('names: absent', namesWithNoExtensionAreOther)
  await step('names: overlap', theDocumentExtensionsDoNotOverlapTheOtherKinds)
  await step('bytes: pdf', aPdfStartsWithItsOwnSignature)
  await step('bytes: not pdf', bytesThatAreNotAPdfAreRefused)
  await step('bytes: zip', aDocxStartsWithTheZipSignature)
  await step('cap: rule', theDocumentCapIsItsOwnNumber)

  console.log(`preview kind: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('PREVIEW KIND TEST FAILED:', err)
  process.exit(1)
})
