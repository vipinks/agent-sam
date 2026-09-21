/**
 * The image half of the read path, against real bytes on a real disk.
 *
 * Two things are being checked, and only one of them can be faked. Which names are images is a
 * function of the file name, so that half is exercised directly, including the cases a case-sensitive
 * map gets wrong (an uppercase extension) and the ones a naive split gets wrong (no extension at all,
 * a leading dot). The other half is the data URL, and there the bytes are the point: a base64 prefix
 * asserted against a hand-written string would pass even if the encoder were reading the wrong file,
 * so a real PNG is seeded and its data URL is decoded back and compared with what was written.
 *
 * No electron: `electron` is stubbed for the whole node run (see `tests/stubs/`), and the registered
 * query is invoked the way the router invokes it, so the tested path is the app's own rather than a
 * reimplementation of it.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import { MAX_FILE_BYTES, workspaceModule } from '../../conveyor/modules/workspace'
import { MAX_IMAGE_BYTES, imageKindForPath, imageOverCap } from '../../conveyor/protocol/image'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-image-'))
  roots.push(root)
  return root
}

/**
 * A read result as this suite sees it: every field any shape can carry, all optional.
 *
 * Deliberately not the union the app narrows on. The claims being made here are about *which* fields
 * came back — that an image result carries no `content`, that a text result carries no `dataUrl` — and
 * a type that admitted only one shape could not state either.
 */
interface ReadResult {
  content?: string
  kind?: string
  mime?: string
  dataUrl?: string
  bytes?: number
  path: string
  baselineMtime?: number
}

/** The registered query, as the router reaches it. */
function readFileQuery(): { resolver: (opts: { input: unknown }) => Promise<ReadResult> } {
  return workspaceModule.record.readFile as unknown as {
    resolver: (opts: { input: unknown }) => Promise<ReadResult>
  }
}

function read(path: string): Promise<ReadResult> {
  return readFileQuery().resolver({ input: { path } })
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
 * A real one-pixel PNG, byte for byte.
 *
 * Written from this constant rather than from a fixture file so the suite carries its own evidence,
 * and asserted to be a PNG by its signature below: a typo in the constant would make every claim
 * downstream vacuous, which is exactly the kind of silent pass this pins.
 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** An svg carrying both a script and an inline handler — the two things that must never run. */
const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script>' +
  '<rect width="1" height="1"/></svg>'

// ---------------------------------------------------------------- the name decides

function knownExtensionsAreImages() {
  const expected: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
  }

  for (const [extension, mime] of Object.entries(expected)) {
    assert.equal(imageKindForPath(`C:/w/logo.${extension}`), mime, `${extension} is ${mime}`)
  }
  // `.jpg` and `.jpeg` are one media type; a separate branch for either would be a place to disagree.
  assert.equal(imageKindForPath('C:/w/logo.jpg'), imageKindForPath('C:/w/logo.jpeg'), 'and they agree')
  results.push('every image extension the viewer renders maps to its media type')
}

function uppercaseAndMixedCaseExtensionsAreImages() {
  // The disk on Windows is case-insensitive and the disk on Linux is not, but neither has anything to
  // do with this: the extension is a fact about the name, and a camera writes `IMG_0001.PNG`.
  assert.equal(imageKindForPath('C:/w/SHOT.PNG'), 'image/png', 'an uppercase extension is an image')
  assert.equal(imageKindForPath('C:/w/Svg/Icon.SvG'), 'image/svg+xml', 'and so is a mixed-case one')
  // The directory above it is not consulted, so a folder named like an image cannot make a text file
  // render as one.
  assert.equal(imageKindForPath('C:/pics.png/notes.txt'), null, 'only the name decides')
  results.push('an uppercase or mixed-case extension still names an image')
}

function unknownAndAbsentExtensionsAreNotImages() {
  assert.equal(imageKindForPath('C:/w/src/app.ts'), null, 'source is not an image')
  assert.equal(imageKindForPath('C:/w/notes.rst'), null, 'nor is a text file the viewer has no grammar for')
  // Absent extension: a Makefile has no dot, and a file whose only dot leads the name has no extension
  // either — `.gitignore` is not a gitignore-format image.
  assert.equal(imageKindForPath('C:/w/Makefile'), null, 'a name with no dot is not an image')
  assert.equal(imageKindForPath('C:/w/.gitignore'), null, 'nor is a dot that only leads the name')
  assert.equal(imageKindForPath(''), null, 'and an empty name is not one either')
  results.push('an unknown extension, no extension, and a leading dot are all text')
}

// ---------------------------------------------------------------- the cap

function theImageCapIsTwiceTheTextCap() {
  assert.equal(MAX_IMAGE_BYTES, 2 * 1024 * 1024, 'the image cap is 2 MB')
  assert.equal(MAX_FILE_BYTES, 1024 * 1024, 'and the text cap is unchanged at 1 MB')

  // The boundary itself is included and one byte over is not: an off-by-one here would refuse a file
  // that fits, or ship one that does not.
  assert.equal(imageOverCap(MAX_IMAGE_BYTES), false, 'a file at the cap is readable')
  assert.equal(imageOverCap(MAX_IMAGE_BYTES + 1), true, 'one byte over it is not')
  assert.equal(imageOverCap(0), false, 'an empty file is not over anything')
  results.push('the cap is 2 MB, inclusive at the boundary and exclusive one byte past it')
}

// ---------------------------------------------------------------- the bytes

async function aTinyPngComesBackAsADataUrlOfItsOwnBytes() {
  const root = makeRoot()
  const path = join(root, 'pixel.png')
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64')
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'the fixture really is a png')
  writeFileSync(path, bytes)

  const read_ = await read(path)

  assert.equal(read_.kind, 'image', 'the result says what it is')
  assert.equal(read_.mime, 'image/png', 'with its media type')
  assert.equal(read_.dataUrl, `data:image/png;base64,${TINY_PNG_BASE64}`, 'and the bytes, base64 encoded')
  assert.equal(read_.bytes, bytes.length, 'the byte count is the file’s, not the data URL’s length')

  // The decisive assertion: what the renderer would show decodes back to exactly what was seeded.
  const decoded = Buffer.from(read_.dataUrl.slice(read_.dataUrl.indexOf(',') + 1), 'base64')
  assert.ok(decoded.equals(bytes), 'and it decodes to the same bytes')
  // An image result has no text half — `content` would be mojibake of a binary file.
  assert.equal(read_.content, undefined, 'an image carries no text content')
  assert.equal(typeof read_.baselineMtime, 'number', 'and still reports the mtime it read')
  results.push('a tiny png returns a data URL that decodes to the seeded bytes')
}

async function anImageOverTheCapIsRefusedWithoutShippingBytes() {
  const root = makeRoot()
  const path = join(root, 'huge.png')
  // The size is all that matters to the cap, so a real encoder is not needed to prove the refusal.
  writeFileSync(path, Buffer.alloc(3 * 1024 * 1024, 7))

  const err = await errorOf(() => read(path))

  assert.equal(err.code, 'IMAGE_TOO_LARGE', 'the refusal has a code of its own')
  // The point of the refusal: the bytes never reach IPC. A data URL would be a third larger again.
  assert.equal((err as unknown as { dataUrl?: unknown }).dataUrl, undefined, 'and no data URL is attached')
  results.push('a 3 MB image is refused as IMAGE_TOO_LARGE, with no data URL')
}

async function anImageBetweenTheCapsIsStillAnImage() {
  const root = makeRoot()
  const path = join(root, 'shot.png')
  const bytes = Buffer.alloc(1_500_000, 3)
  writeFileSync(path, bytes)

  // The kind is decided before the size is compared, which is the whole reason this passes: under the
  // text cap this file would be FILE_TOO_LARGE, and an image the viewer can show would be refused.
  assert.ok(bytes.length > MAX_FILE_BYTES, 'the fixture is over the text cap')
  assert.ok(bytes.length < MAX_IMAGE_BYTES, 'and under the image cap')

  const read_ = await read(path)
  assert.equal(read_.kind, 'image', 'over the text cap is still an image')
  assert.equal(read_.bytes, bytes.length, 'with all of its bytes')
  results.push('an image over the text cap but under the image cap is read as an image')
}

async function anSvgIsServedAsItsOwnMediaTypeAndNeverAsMarkup() {
  const root = makeRoot()
  const path = join(root, 'icon.svg')
  writeFileSync(path, SVG_SOURCE, 'utf8')

  const read_ = await read(path)

  assert.equal(read_.mime, 'image/svg+xml', 'an svg has its own media type')
  assert.ok(read_.dataUrl?.startsWith('data:image/svg+xml;base64,'), 'and arrives base64 encoded')

  // The security half, asserted on the wire rather than in the renderer: the script is in there as
  // bytes, and no markup is. A data URL the renderer cannot parse as a document is what makes the
  // decision to render it in an `img` sufficient on its own.
  assert.equal(read_.dataUrl?.includes('<'), false, 'no raw markup crosses the boundary')
  assert.equal(read_.dataUrl?.includes('script'), false, 'so no script tag does either')
  const decoded = Buffer.from(read_.dataUrl?.slice(read_.dataUrl.indexOf(',') + 1) ?? '', 'base64').toString('utf8')
  assert.equal(decoded, SVG_SOURCE, 'while the file’s own bytes are what is carried')
  results.push('an svg keeps its media type and its script stays bytes in a data URL')
}

async function aMissingImageIsTheExistingUnavailableCode() {
  const root = makeRoot()
  const path = join(root, 'deleted.png')

  // The kind is decided from the name, and nothing is asked of the disk until it is known — so a
  // deleted image takes the same branch an unreadable text file always has, rather than a new one.
  const err = await errorOf(() => read(path))
  assert.equal(err.code, 'FILE_UNAVAILABLE', 'a deleted image is the existing not-found code')
  results.push('a deleted image fails as FILE_UNAVAILABLE, the code the pane already branches on')
}

// ---------------------------------------------------------------- the text path is untouched

async function textOverTheTextCapIsStillRefusedTheOldWay() {
  const root = makeRoot()
  const path = join(root, 'big.txt')
  writeFileSync(path, 'x'.repeat(1_500_000), 'utf8')

  const err = await errorOf(() => read(path))
  // The image cap must not have moved this: a text file over 1 MB is still FILE_TOO_LARGE.
  assert.equal(err.code, 'FILE_TOO_LARGE', 'a text file over 1 MB is refused as before')
  results.push('the text cap and its code are unchanged')
}

async function aTextResultIsExactlyTheShapeItAlwaysWas() {
  const root = makeRoot()
  const path = join(root, 'app.ts')
  writeFileSync(path, 'const a = 1\n', 'utf8')

  const read_ = await read(path)

  assert.equal(read_.content, 'const a = 1\n', 'the contents are still returned as text')
  // Byte for byte: no `kind` was added to this branch, so every existing caller — and every shape
  // already on the wire — keeps working without a field it does not know about.
  assert.deepEqual(Object.keys(read_).sort(), ['baselineMtime', 'content', 'path'], 'and the shape is unchanged')
  results.push('a text read returns exactly the fields it returned before this turn')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('names: known', knownExtensionsAreImages)
    await step('names: case', uppercaseAndMixedCaseExtensionsAreImages)
    await step('names: absent', unknownAndAbsentExtensionsAreNotImages)
    await step('cap: rule', theImageCapIsTwiceTheTextCap)
    await step('bytes: png', aTinyPngComesBackAsADataUrlOfItsOwnBytes)
    await step('bytes: over cap', anImageOverTheCapIsRefusedWithoutShippingBytes)
    await step('bytes: mid', anImageBetweenTheCapsIsStillAnImage)
    await step('bytes: svg', anSvgIsServedAsItsOwnMediaTypeAndNeverAsMarkup)
    await step('bytes: deleted', aMissingImageIsTheExistingUnavailableCode)
    await step('text: cap', textOverTheTextCapIsStillRefusedTheOldWay)
    await step('text: shape', aTextResultIsExactlyTheShapeItAlwaysWas)

    console.log(`image read: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('IMAGE READ TEST FAILED:', err)
  process.exit(1)
})
