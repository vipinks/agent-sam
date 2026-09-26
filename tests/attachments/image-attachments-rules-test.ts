/**
 * The rules that bound a composer image, and the content a message is sent with.
 *
 * Four decisions, none of which needs a disk: which media types may be attached, how large one image
 * may be, how many one message may carry, and the shape the OpenAI dialect is handed.
 *
 * The last of those is a *regression* rule as much as a new one. A message with no images has to go
 * out as the plain string it has always been — not an array with one text part, not an object with a
 * `content` key — or every conversation in the app changes wire shape at the same moment a feature is
 * added, and the failure would look like a provider rejecting a request rather than like a builder
 * that changed. It is asserted as equality against the string itself, which is the only assertion that
 * can fail when the shape drifts.
 *
 * No Electron and no filesystem: this suite imports the pure rules only, so there is nothing to stub
 * and nothing to clean up.
 */
import { strict as assert } from 'node:assert'
import {
  IMAGE_ATTACHMENT_MIME_TYPES,
  IMAGE_ATTACH_REFUSED,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  acceptedAttachmentMime,
  attachmentCountRefusal,
  attachmentExtensionFor,
  attachmentRefusal,
  buildMessageContent,
  imageAttachmentRefSchema,
  type ImageAttachmentRef,
  type ResolvedAttachment,
} from '../../conveyor/protocol/image-attachments'
import { TRANSCRIPT_VERSION, transcriptSnapshotSchema } from '../../conveyor/protocol/transcript'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
  results.push(label)
}

// ---------------------------------------------------------------------------------------------
// The media types
// ---------------------------------------------------------------------------------------------

async function testMimeWhitelist(): Promise<void> {
  await step('the four sendable types are accepted, canonically', () => {
    for (const mimeType of IMAGE_ATTACHMENT_MIME_TYPES) {
      assert.equal(acceptedAttachmentMime(mimeType), mimeType)
    }
    assert.deepEqual([...IMAGE_ATTACHMENT_MIME_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  })

  await step('a type the dialect cannot send is refused with the code', () => {
    // The viewer's wider list is the interesting set of near-misses: these render in the app and still
    // cannot be attached, which is exactly the pair of facts that must not be confused.
    for (const other of ['image/svg+xml', 'image/bmp', 'image/x-icon', 'text/plain', 'application/pdf', '']) {
      assert.equal(acceptedAttachmentMime(other), null, `${other} should not be accepted`)
      const refusal = attachmentRefusal({ mimeType: other, bytes: 1024 })
      assert.equal(refusal?.code, IMAGE_ATTACH_REFUSED, `${other} should be refused`)
    }
  })

  await step('a type differing only in case is accepted and canonicalised', () => {
    // A camera or a clipboard may hand over `image/JPEG`. A case-sensitive table would refuse it, which
    // is the same mistake the viewer's extension map avoids for the same reason.
    assert.equal(acceptedAttachmentMime('IMAGE/JPEG'), 'image/jpeg')
    assert.equal(acceptedAttachmentMime('Image/Png'), 'image/png')
  })

  await step('the stored extension comes from the media type, never the name', () => {
    assert.equal(attachmentExtensionFor('image/png'), 'png')
    assert.equal(attachmentExtensionFor('image/jpeg'), 'jpg')
    assert.equal(attachmentExtensionFor('image/webp'), 'webp')
    assert.equal(attachmentExtensionFor('image/gif'), 'gif')
  })
}

// ---------------------------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------------------------

async function testByteCap(): Promise<void> {
  await step('one byte past the cap is refused, and the cap itself is accepted', () => {
    assert.equal(MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024)
    assert.equal(attachmentRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES }), null)
    assert.equal(
      attachmentRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES + 1 })?.code,
      IMAGE_ATTACH_REFUSED
    )
  })

  await step('the refusal names the cap rather than the byte count', () => {
    const refusal = attachmentRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES + 1 })
    assert.ok(refusal)
    assert.match(refusal.message, /8 MB/)
  })
}

async function testMessageCap(): Promise<void> {
  await step('a fifth image is refused, and the fourth is accepted', () => {
    assert.equal(MAX_ATTACHMENTS_PER_MESSAGE, 4)
    assert.equal(attachmentCountRefusal(MAX_ATTACHMENTS_PER_MESSAGE), null)
    assert.equal(attachmentCountRefusal(MAX_ATTACHMENTS_PER_MESSAGE + 1)?.code, IMAGE_ATTACH_REFUSED)
  })
}

// ---------------------------------------------------------------------------------------------
// The content the dialect is sent with
// ---------------------------------------------------------------------------------------------

/** One resolved attachment, as the send-time builder receives it. */
function image(id: string, name: string, url: string): ResolvedAttachment {
  return { ref: { id, name, mimeType: 'image/png', size: 12 }, dataUrl: url }
}

async function testContentParts(): Promise<void> {
  await step('a text-only message is the plain string it has always been', () => {
    const content = buildMessageContent('What does this file do?')
    assert.equal(typeof content, 'string')
    assert.equal(content, 'What does this file do?')
    // The wire object is what the assertion above has to hold for: `content` is emitted verbatim.
    assert.deepEqual({ role: 'user', content }, { role: 'user', content: 'What does this file do?' })
  })

  await step('an explicitly empty attachment list is still the plain string', () => {
    assert.equal(buildMessageContent('hello', []), 'hello')
  })

  await step('an empty message with no images is the empty string, not an empty array', () => {
    // The message edit path can save a cleared message; it must stay a string so it stays valid.
    assert.equal(buildMessageContent(''), '')
  })

  await step('images are sent as an array with the text part first, in attach order', () => {
    const content = buildMessageContent('Compare these', [
      image('id-a', 'first.png', 'data:image/png;base64,AAAA'),
      image('id-b', 'second.png', 'data:image/png;base64,BBBB'),
    ])
    assert.deepEqual(content, [
      { type: 'text', text: 'Compare these' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    ])
  })

  await step('an empty message with an image still leads with its text part', () => {
    const content = buildMessageContent('', [image('id-a', 'first.png', 'data:image/png;base64,AAAA')])
    assert.deepEqual(content, [
      { type: 'text', text: '' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })
}

// ---------------------------------------------------------------------------------------------
// The reference a transcript carries
// ---------------------------------------------------------------------------------------------

async function testReferenceShape(): Promise<void> {
  await step('the reference is the four fields the renderer and main agree on', () => {
    const ref: ImageAttachmentRef = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 12,
    }
    const parsed = imageAttachmentRefSchema.safeParse(ref)
    assert.equal(parsed.success, true)
    assert.deepEqual(parsed.success ? parsed.data : null, ref)
  })

  await step('a reference missing a field is not a reference', () => {
    assert.equal(
      imageAttachmentRefSchema.safeParse({ id: 'x', name: 'shot.png', mimeType: 'image/png' }).success,
      false
    )
    assert.equal(
      imageAttachmentRefSchema.safeParse({ id: '', name: 'shot.png', mimeType: 'image/png', size: 1 }).success,
      false
    )
    assert.equal(
      imageAttachmentRefSchema.safeParse({ id: 'x', name: 'shot.png', mimeType: 'image/png', size: -1 }).success,
      false
    )
  })

  await step('the record does not close over the whitelist', () => {
    // A reference is a *record* of what was stored, and the whitelist binds what may be stored. Reading a
    // transcript through the whitelist would turn one unrecognised media type into an unreadable
    // conversation, which is the rule the rest of the transcript shape follows too.
    const widened = { id: 'x', name: 'scan.tiff', mimeType: 'image/tiff', size: 4 }
    assert.equal(imageAttachmentRefSchema.safeParse(widened).success, true)
  })
}

// ---------------------------------------------------------------------------------------------
// The turn record
// ---------------------------------------------------------------------------------------------

async function testTurnRecord(): Promise<void> {
  const base = {
    id: 'turn-user',
    role: 'user' as const,
    content: 'What is in this screenshot?',
    steps: [],
  }
  const ref = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    name: 'shot.png',
    mimeType: 'image/png',
    size: 12,
  }

  await step('a user turn carries its images as references beside a string content', () => {
    const parsed = transcriptSnapshotSchema.safeParse({
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [{ ...base, imageRefs: [ref] }],
    })
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues))
    assert.deepEqual(parsed.success ? parsed.data.turns[0].imageRefs : null, [ref])
    // The content is still the string the user typed. The parts that go on the wire are built from the
    // references at send time, so what is stored is the message rather than a rendering of it.
    assert.equal(parsed.success ? parsed.data.turns[0].content : null, 'What is in this screenshot?')
  })

  await step('a turn with no images has no key at all, rather than an empty list', () => {
    const parsed = transcriptSnapshotSchema.safeParse({
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [base],
    })
    assert.equal(parsed.success, true)
    assert.equal(parsed.success ? 'imageRefs' in parsed.data.turns[0] : true, false)
  })

  await step('the version is not bumped for an additive optional key', () => {
    // The rule the shape has followed since plans landed: nothing a reader has to be told about is a
    // version bump, and a key a reader can strip is not something it has to be told about.
    assert.equal(TRANSCRIPT_VERSION, 3)
    assert.equal(
      transcriptSnapshotSchema.safeParse({ version: 1, interrupted: false, turns: [{ ...base, imageRefs: [ref] }] })
        .success,
      true
    )
  })
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  await testMimeWhitelist()
  await testByteCap()
  await testMessageCap()
  await testContentParts()
  await testReferenceShape()
  await testTurnRecord()
  console.log(`\nIMAGE ATTACHMENT RULES PASSED: ${results.length} checks`)
}

main().catch((err) => {
  console.error('IMAGE ATTACHMENT RULES FAILED:', err)
  process.exit(1)
})
