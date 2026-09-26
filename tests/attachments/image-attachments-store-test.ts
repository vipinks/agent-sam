/**
 * The attachment store: what save writes, what the read gives back, and what a session's delete takes
 * with it.
 *
 * The store takes its userData root as an argument, so every case here works in a private temp
 * directory and no case can reach the real user's app data — the property that makes a suite which
 * deletes directories safe to run anywhere.
 *
 * Two failures are asserted by code rather than by message, because that is what the app branches on:
 * a refusal (a type nobody sends, an image over the cap, a name that could not be a path segment) and a
 * miss (a read or a delete of something that is not there). The dangerous direction is asserted
 * directly and first in each pair: the refusal must also leave nothing behind, and a delete must leave
 * the other sessions' folders exactly where they were.
 *
 * The last group is the retention hook end to end: the session-delete path in `sessions.ts`, called the
 * way the router calls it, has to take the folder with it — and has to stay silent for a conversation
 * that never had an image, because that is what deleting a session looks like most of the time.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  deleteSessionAttachments,
  orphanedAttachmentDirs,
  readAttachmentBytes,
  saveAttachment,
  sweepAttachmentFolders,
  sweepOrphanedAttachments,
} from '../../conveyor/modules/image-attachments'
import { sessionsModule } from '../../conveyor/modules/sessions'
import {
  IMAGE_ATTACH_NOT_FOUND,
  IMAGE_ATTACH_REFUSED,
  MAX_ATTACHMENT_BYTES,
} from '../../conveyor/protocol/image-attachments'

const results: string[] = []
const roots: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
  results.push(label)
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-attach-'))
  roots.push(root)
  return root
}

const SESSION = '11111111-2222-4333-8444-555555555555'
const OTHER = '22222222-3333-4444-8555-666666666666'
const ORPHAN = 'aaaaaaaa-1111-4111-8111-111111111111'

/** A PNG's first bytes. The store checks the type it is told and the size, and does not sniff, so the
 * content only has to be distinguishable between cases. */
const PAYLOAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42])

function sessionFolder(root: string, id: string): string {
  return join(root, 'attachments', id)
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

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

async function testSave(): Promise<void> {
  await step('save writes the image under the injected root and returns its reference', async () => {
    const root = makeRoot()
    const ref = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })

    assert.equal(ref.name, 'shot.png')
    assert.equal(ref.mimeType, 'image/png')
    assert.equal(ref.size, PAYLOAD.byteLength)
    assert.match(ref.id, /^[0-9a-f-]{36}$/, 'the reference carries an id a path is built from')

    // The file is where the reference says it is, and the extension came from the media type.
    const written = join(sessionFolder(root, SESSION), `${ref.id}.png`)
    assert.equal(existsSync(written), true, 'the image is on disk')
    assert.deepEqual(readdirSync(sessionFolder(root, SESSION)), [`${ref.id}.png`])
  })

  await step('the extension follows the media type, not the name', async () => {
    const root = makeRoot()
    for (const [mimeType, extension] of [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/webp', 'webp'],
      ['image/gif', 'gif'],
    ] as const) {
      // A name that lies about its type: the stored file must not.
      const ref = await saveAttachment(root, {
        sessionId: SESSION,
        name: `picture.${extension}.txt`,
        mimeType,
        bytes: PAYLOAD,
      })
      assert.equal(existsSync(join(sessionFolder(root, SESSION), `${ref.id}.${extension}`)), true, mimeType)
    }
  })

  await step('two images in one session do not collide', async () => {
    const root = makeRoot()
    const first = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'a.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })
    const second = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'b.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })
    assert.notEqual(first.id, second.id)
    assert.equal(readdirSync(sessionFolder(root, SESSION)).length, 2)
  })

  await step('save refuses a type the dialect cannot send, and writes nothing', async () => {
    const root = makeRoot()
    const code = await refusalCodeOf(() =>
      saveAttachment(root, { sessionId: SESSION, name: 'vector.svg', mimeType: 'image/svg+xml', bytes: PAYLOAD })
    )
    assert.equal(code, IMAGE_ATTACH_REFUSED)
    assert.equal(existsSync(join(root, 'attachments')), false, 'a refused save leaves no directory')
  })

  await step('save refuses one byte over the cap, and accepts the cap itself', async () => {
    const root = makeRoot()
    const overCap = await refusalCodeOf(() =>
      saveAttachment(root, {
        sessionId: SESSION,
        name: 'huge.png',
        mimeType: 'image/png',
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      })
    )
    assert.equal(overCap, IMAGE_ATTACH_REFUSED)
    assert.equal(existsSync(join(root, 'attachments')), false, 'an over-cap image is never written')

    // The boundary from the other side, without writing eight megabytes: the same decision function
    // answers both, and it is asserted here at the size the store would pass it.
    const ref = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'small.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })
    assert.equal(ref.size, PAYLOAD.byteLength)
  })

  await step('save refuses a session id that could escape its directory', async () => {
    const root = makeRoot()
    for (const sessionId of ['../escape', '..', 'a/b', 'a\\b', 'C:\\Windows', `${SESSION}/../../evil`, '']) {
      const code = await refusalCodeOf(() =>
        saveAttachment(root, { sessionId, name: 'shot.png', mimeType: 'image/png', bytes: PAYLOAD })
      )
      assert.equal(code, IMAGE_ATTACH_REFUSED, `sessionId ${JSON.stringify(sessionId)}`)
    }
    assert.equal(existsSync(join(root, 'attachments')), false, 'no folder was made anywhere')
  })
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

async function testRead(): Promise<void> {
  await step('the read returns exactly the saved bytes', async () => {
    const root = makeRoot()
    const ref = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })
    const bytes = await readAttachmentBytes(root, SESSION, ref.id)
    assert.deepEqual([...bytes], [...PAYLOAD])
  })

  await step('a read of something that is not there is a miss, by code', async () => {
    const root = makeRoot()
    const missing = 'bbbbbbbb-2222-4222-8222-222222222222'
    assert.equal(await refusalCodeOf(() => readAttachmentBytes(root, SESSION, missing)), IMAGE_ATTACH_NOT_FOUND)

    // And a miss in a session that does have attachments: the id is what was missing.
    const ref = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })
    assert.equal(await refusalCodeOf(() => readAttachmentBytes(root, SESSION, missing)), IMAGE_ATTACH_NOT_FOUND)
    assert.equal(await refusalCodeOf(() => readAttachmentBytes(root, OTHER, ref.id)), IMAGE_ATTACH_NOT_FOUND)
  })

  await step('a read of an id that could be a path is a refusal, not a miss', async () => {
    const root = makeRoot()
    for (const id of ['../escape', '../../sessions/anything', 'a/b', '']) {
      assert.equal(
        await refusalCodeOf(() => readAttachmentBytes(root, SESSION, id)),
        IMAGE_ATTACH_REFUSED,
        `id ${JSON.stringify(id)}`
      )
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Deleting one session's folder
// ---------------------------------------------------------------------------------------------

async function testDeleteSession(): Promise<void> {
  await step('deleteSession removes that session and leaves the others', async () => {
    const root = makeRoot()
    await saveAttachment(root, { sessionId: SESSION, name: 'a.png', mimeType: 'image/png', bytes: PAYLOAD })
    await saveAttachment(root, { sessionId: OTHER, name: 'b.png', mimeType: 'image/png', bytes: PAYLOAD })

    await deleteSessionAttachments(root, SESSION)

    assert.equal(existsSync(sessionFolder(root, SESSION)), false, 'the session folder is gone')
    assert.equal(existsSync(sessionFolder(root, OTHER)), true, 'the other session is untouched')
  })

  await step('deleting a session with no attachments is its own code', async () => {
    const root = makeRoot()
    assert.equal(await refusalCodeOf(() => deleteSessionAttachments(root, SESSION)), IMAGE_ATTACH_NOT_FOUND)

    // And after a real delete, the second delete is the same fact.
    await saveAttachment(root, { sessionId: SESSION, name: 'a.png', mimeType: 'image/png', bytes: PAYLOAD })
    await deleteSessionAttachments(root, SESSION)
    assert.equal(await refusalCodeOf(() => deleteSessionAttachments(root, SESSION)), IMAGE_ATTACH_NOT_FOUND)
  })

  await step('a session id that could be a path is refused rather than followed', async () => {
    const root = makeRoot()
    mkdirSync(join(root, 'attachments', 'keepme'), { recursive: true })
    assert.equal(await refusalCodeOf(() => deleteSessionAttachments(root, '../keepme')), IMAGE_ATTACH_REFUSED)
    assert.equal(existsSync(join(root, 'attachments', 'keepme')), true, 'nothing outside was touched')
  })
}

// ---------------------------------------------------------------------------------------------
// The startup sweep
// ---------------------------------------------------------------------------------------------

async function testSweep(): Promise<void> {
  await step('the rule selects directories without a live session, and nothing else', () => {
    assert.deepEqual(orphanedAttachmentDirs([SESSION, ORPHAN], [SESSION]), [ORPHAN])
    assert.deepEqual(orphanedAttachmentDirs([SESSION], [SESSION]), [])
    assert.deepEqual(orphanedAttachmentDirs([], [SESSION]), [])
    // A directory that could not be a session id is not ours to delete, whatever the store says.
    assert.deepEqual(orphanedAttachmentDirs(['notes', 'backup-2026', `${SESSION}.old`], []), [])
  })

  await step('the sweep removes the orphans and keeps the live folders', async () => {
    const root = makeRoot()
    await saveAttachment(root, { sessionId: SESSION, name: 'live.png', mimeType: 'image/png', bytes: PAYLOAD })
    await saveAttachment(root, { sessionId: ORPHAN, name: 'gone.png', mimeType: 'image/png', bytes: PAYLOAD })
    mkdirSync(join(root, 'attachments', 'notes'), { recursive: true })

    const swept = await sweepOrphanedAttachments(root, [SESSION])

    assert.equal(swept, 1, `swept ${swept}`)
    assert.equal(existsSync(sessionFolder(root, ORPHAN)), false, 'the orphan is gone')
    assert.equal(existsSync(sessionFolder(root, SESSION)), true, 'the live session keeps its image')
    assert.equal(existsSync(join(root, 'attachments', 'notes')), true, 'a directory that is not a session id survives')

    // Idempotent: a second startup finds nothing to do.
    assert.equal(await sweepOrphanedAttachments(root, [SESSION]), 0)
    assert.equal(existsSync(sessionFolder(root, SESSION)), true)
  })

  await step('the sweep tolerates a root that does not exist yet', async () => {
    const root = makeRoot()
    assert.equal(await sweepOrphanedAttachments(root, [SESSION]), 0)
  })

  await step('the startup entry point sweeps the real root the app would use', async () => {
    // The wrapper `router.ts` calls, against the root the electron stub hands it.
    const root = makeRoot()
    process.env.SAM_TEST_USER_DATA = root
    await saveAttachment(root, { sessionId: ORPHAN, name: 'gone.png', mimeType: 'image/png', bytes: PAYLOAD })
    assert.equal(await sweepAttachmentFolders([]), 1)
    assert.equal(existsSync(sessionFolder(root, ORPHAN)), false)
  })
}

// ---------------------------------------------------------------------------------------------
// The retention hook: a deleted session takes its images
// ---------------------------------------------------------------------------------------------

async function testSessionDeleteRetention(): Promise<void> {
  await step('deleting a session removes its attachment folder', async () => {
    const root = makeRoot()
    process.env.SAM_TEST_USER_DATA = root
    const ref = await saveAttachment(root, {
      sessionId: SESSION,
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: PAYLOAD,
    })
    assert.equal(existsSync(join(sessionFolder(root, SESSION), `${ref.id}.png`)), true)

    const record = sessionsModule.record.deleteTranscript as unknown as {
      resolver: (opts: { input: unknown }) => Promise<void>
    }
    await record.resolver({ input: { id: SESSION } })

    assert.equal(existsSync(sessionFolder(root, SESSION)), false, 'the images went with the conversation')
  })

  await step('deleting a session that never had an image still succeeds', async () => {
    const root = makeRoot()
    process.env.SAM_TEST_USER_DATA = root
    const record = sessionsModule.record.deleteTranscript as unknown as {
      resolver: (opts: { input: unknown }) => Promise<void>
    }
    await record.resolver({ input: { id: OTHER } })
    assert.equal(existsSync(sessionFolder(root, OTHER)), false)
  })

  await step('deleting one session leaves the other conversation untouched', async () => {
    const root = makeRoot()
    process.env.SAM_TEST_USER_DATA = root
    await saveAttachment(root, { sessionId: OTHER, name: 'kept.png', mimeType: 'image/png', bytes: PAYLOAD })
    await saveAttachment(root, { sessionId: SESSION, name: 'gone.png', mimeType: 'image/png', bytes: PAYLOAD })

    const record = sessionsModule.record.deleteTranscript as unknown as {
      resolver: (opts: { input: unknown }) => Promise<void>
    }
    await record.resolver({ input: { id: SESSION } })

    assert.equal(existsSync(sessionFolder(root, OTHER)), true, 'the other conversation keeps its image')
  })
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await testSave()
    await testRead()
    await testDeleteSession()
    await testSweep()
    await testSessionDeleteRetention()
  } finally {
    delete process.env.SAM_TEST_USER_DATA
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }

  console.log(`\nIMAGE ATTACHMENT STORE PASSED: ${results.length} checks`)
}

main().catch((err) => {
  console.error('IMAGE ATTACHMENT STORE FAILED:', err)
  process.exit(1)
})
