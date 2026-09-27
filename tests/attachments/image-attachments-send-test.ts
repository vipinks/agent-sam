/**
 * The send side of the attachment store: a reference turned back into bytes, and the data URL a reader
 * of one gets.
 *
 * The store's own suite covers what a save writes. This one covers the two reads the feature closes
 * with, and they are different questions with different callers:
 *
 * - the send path resolves a turn's references at request time, so that the provider is handed the
 *   image rather than a name for it;
 * - a transcript's chip asks for one image by id, through the capped read the renderer is allowed.
 *
 * The cap is asserted at its boundary in both directions, because the direction that is wrong in
 * silence is the one that ships: a file exactly at 8 MB is a file the composer accepted and the store
 * wrote, so a read that refused it would break a conversation that was legal when it was made — while a
 * byte more is the case the cap exists for. The miss is asserted by code, never by sentence, because
 * that is what the app branches on.
 *
 * Every case works in a private temp root. `resolveStoredAttachment` reads the root the running app
 * uses, which the suite's electron double points at `SAM_TEST_USER_DATA` — the same directory the
 * runner hands each suite, so no case can reach the real user's app data.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  readAttachmentBytes,
  readAttachmentDataUrl,
  resolveStoredAttachment,
  saveAttachment,
} from '../../conveyor/modules/image-attachments'
import {
  IMAGE_ATTACH_NOT_FOUND,
  IMAGE_ATTACH_REFUSED,
  MAX_ATTACHMENT_BYTES,
  attachmentMimeForStoredName,
  type ImageAttachmentRef,
} from '../../conveyor/protocol/image-attachments'

const results: string[] = []
const roots: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
  results.push(label)
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-attach-send-'))
  roots.push(root)
  return root
}

const SESSION = '11111111-2222-4333-8444-555555555555'
const ABSENT_ID = '99999999-8888-4777-8666-555555555555'

/** A PNG's first bytes, distinguishable between cases. */
const PAYLOAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7])

/** The data URL the given bytes must become, written out here so the store is not its own witness. */
function expectedDataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

/** The code a rejected promise carried, or a description of why it was not rejected. */
async function refusalCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    return err instanceof ConveyorError ? err.code : `not a ConveyorError: ${String(err)}`
  }
  return 'resolved'
}

/** One image already in a session's folder, written directly so a case can pick its own size. */
function storeFile(root: string, sessionId: string, name: string, bytes: Uint8Array): void {
  const dir = join(root, 'attachments', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), bytes)
}

async function storedRef(root: string, name: string, bytes = PAYLOAD, mimeType = 'image/png') {
  return saveAttachment(root, { sessionId: SESSION, name, mimeType, bytes })
}

// ---------------------------------------------------------------------------------------------
// The capped read a transcript's chip makes
// ---------------------------------------------------------------------------------------------

async function testReadDataUrl(): Promise<void> {
  await step('a stored image reads back as the data URL of the same bytes', async () => {
    const root = makeRoot()
    const ref = await storedRef(root, 'shot.png')

    const url = await readAttachmentDataUrl(root, SESSION, ref.id)

    assert.equal(url, expectedDataUrl('image/png', PAYLOAD))
    // And the same bytes the other read hands over, so the two readers cannot disagree about an image.
    assert.deepEqual(new Uint8Array(await readAttachmentBytes(root, SESSION, ref.id)), PAYLOAD)
  })

  await step('the media type comes from the name this store wrote, not from the caller', async () => {
    const root = makeRoot()
    const png = await storedRef(root, 'shot.png', PAYLOAD, 'image/png')
    const jpeg = await storedRef(root, 'photo.jpeg', PAYLOAD, 'image/jpeg')

    // `jpeg` is stored as `jpg`, and that is the name the read is given: the type is recovered from
    // what the store wrote rather than from anything the reader claims.
    assert.equal(await readAttachmentDataUrl(root, SESSION, png.id), expectedDataUrl('image/png', PAYLOAD))
    assert.equal(await readAttachmentDataUrl(root, SESSION, jpeg.id), expectedDataUrl('image/jpeg', PAYLOAD))
    assert.equal(attachmentMimeForStoredName('whatever.webp'), 'image/webp')
    // A name this app's store would never have written names no media type at all.
    assert.equal(attachmentMimeForStoredName('shot.bmp'), null)
    assert.equal(attachmentMimeForStoredName('shot'), null)
  })

  await step('a read of an image that is not stored raises the miss', async () => {
    const root = makeRoot()
    await storedRef(root, 'shot.png')

    assert.equal(await refusalCodeOf(() => readAttachmentDataUrl(root, SESSION, ABSENT_ID)), IMAGE_ATTACH_NOT_FOUND)
    // A session that never stored an image is the same answer: there is nothing there to name.
    assert.equal(
      await refusalCodeOf(() => readAttachmentDataUrl(root, '22222222-3333-4444-8555-666666666666', ABSENT_ID)),
      IMAGE_ATTACH_NOT_FOUND
    )
  })

  await step('a read of a file this store did not write raises the miss rather than guessing a type', async () => {
    const root = makeRoot()
    // The file exists under an id-shaped name, and its extension is one no media type maps to: the
    // bytes are not nothing, and what they are is unknown, so this is refused as a miss rather than
    // shipped under a type the reader made up.
    storeFile(root, SESSION, `${ABSENT_ID}.bmp`, PAYLOAD)

    assert.equal(await refusalCodeOf(() => readAttachmentDataUrl(root, SESSION, ABSENT_ID)), IMAGE_ATTACH_NOT_FOUND)
  })

  await step('a read one byte over the cap is refused, and one exactly at it is not', async () => {
    const root = makeRoot()
    const atCap = '12121212-3434-4545-8686-777777777777'
    const overCap = '13131313-3535-4646-8787-888888888888'
    storeFile(root, SESSION, `${atCap}.png`, new Uint8Array(MAX_ATTACHMENT_BYTES))
    storeFile(root, SESSION, `${overCap}.png`, new Uint8Array(MAX_ATTACHMENT_BYTES + 1))

    // The boundary the store's own rule sets: exactly the cap is an image the composer took and the
    // write accepted, so the read has to hand it over.
    const url = await readAttachmentDataUrl(root, SESSION, atCap)
    assert.ok(url.startsWith('data:image/png;base64,'), 'an image exactly at the cap must still read')

    assert.equal(await refusalCodeOf(() => readAttachmentDataUrl(root, SESSION, overCap)), IMAGE_ATTACH_REFUSED)
  })
}

// ---------------------------------------------------------------------------------------------
// The read the send path makes
// ---------------------------------------------------------------------------------------------

async function testSendResolver(): Promise<void> {
  await step('the send resolver hands back the reference and the bytes it names', async () => {
    const root = makeRoot()
    process.env.SAM_TEST_USER_DATA = root
    const ref = await storedRef(root, 'shot.png')

    // No root argument: this is the function a run calls, and it reads the root the running app uses.
    const resolved = await resolveStoredAttachment(SESSION, ref)

    assert.deepEqual(resolved.ref, ref)
    assert.equal(resolved.dataUrl, expectedDataUrl('image/png', PAYLOAD))
  })

  await step('a reference the store no longer holds fails, so a send can abort rather than go without it', async () => {
    const root = makeRoot()
    process.env.SAM_TEST_USER_DATA = root
    const ref = await storedRef(root, 'shot.png')

    // The folder swept, the conversation's images gone: a turn that names this image must fail with the
    // code rather than being sent with its text alone.
    rmSync(join(root, 'attachments', SESSION), { recursive: true, force: true })

    assert.equal(await refusalCodeOf(() => resolveStoredAttachment(SESSION, ref)), IMAGE_ATTACH_NOT_FOUND)
    assert.equal(
      await refusalCodeOf(() => resolveStoredAttachment(SESSION, { ...(ref as ImageAttachmentRef), id: ABSENT_ID })),
      IMAGE_ATTACH_NOT_FOUND
    )
  })
}

async function main(): Promise<void> {
  try {
    await testReadDataUrl()
    await testSendResolver()
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }

  console.log(`\nATTACHMENT SEND PASSED: ${results.length}`)
}

main().catch((err) => {
  console.error('ATTACHMENT SEND FAILED:', err)
  process.exit(1)
})
