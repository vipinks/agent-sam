/**
 * What the composer will take, and the order it will take it in.
 *
 * Three of the four things here are the *same* rules Turn 1 wrote, asked at the moment the user is still
 * choosing rather than at the moment main writes: which media types may be attached, how large one image
 * may be, and how many one message may carry. What is asserted is not only that each refuses, but that it
 * refuses with the sentence the store would use — the rule is composed out of `attachmentRefusal` and
 * `attachmentCountRefusal` rather than restated, and a copy that drifted by one megabyte would be a
 * composer that accepted an image the write then refused.
 *
 * The fourth is the capability gate, which is not a refusal rule at all: a provider record either says it
 * takes images or it does not, and absence has to mean no.
 *
 * The last section is the order. Attach order is the user's, it is what the chips show, and it is what the
 * saves are dispatched in — so the array's order is asserted through the functions that build it and
 * through the turn record that commits it, rather than left as a comment on a `for` loop.
 *
 * No Electron, no filesystem and no DOM: the rules are pure, and the draft is an array of bytes the suite
 * makes up. Nothing to clean up.
 */
import { strict as assert } from 'node:assert'
import {
  IMAGE_ATTACH_REFUSED,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  attachmentCaptureRefusal,
  attachmentCountRefusal,
  attachmentRefusal,
  providerAcceptsImages,
  type ImageAttachmentRef,
} from '../../conveyor/protocol/image-attachments'
import {
  ATTACHMENT_ACCEPT_ATTRIBUTE,
  addDraftAttachment,
  attachmentRefusalNotice,
  attachmentSaveRequests,
  attachmentSizeLabel,
  composerAcceptsImages,
  draftAttachmentFrom,
  filesIn,
  imageCapabilityNotice,
  removeDraftAttachment,
  type DraftAttachment,
} from '../../app/components/workbench/attachments'
import { startUserTurn } from '../../app/components/workbench/agent-session'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
  results.push(label)
}

/** A draft attachment with as many bytes as the case needs, from no file at all. */
function image(name: string, bytes = 8): DraftAttachment {
  return draftAttachmentFrom(`draft-${name}`, name, 'image/png', new Uint8Array(bytes))
}

function ref(id: string, name: string): ImageAttachmentRef {
  return { id, name, mimeType: 'image/png', size: 8 }
}

// -----------------------------------------------------------------------------------------------
// The capability gate
// -----------------------------------------------------------------------------------------------

function testCapabilityGate(): void {
  step('a provider that has said nothing does not take images', () => {
    assert.equal(providerAcceptsImages(undefined), false)
    assert.equal(providerAcceptsImages(null), false)
    assert.equal(providerAcceptsImages({}), false)
  })

  step('a provider that has said no does not take them either', () => {
    // The same answer as an absent key, which is the point: `false` is not a second state a caller has to
    // handle, it is the default said out loud.
    assert.equal(providerAcceptsImages({ supportsImages: false }), false)
  })

  step('only an explicit yes opens the gate', () => {
    assert.equal(providerAcceptsImages({ supportsImages: true }), true)
    // A record with the rest of its fields present and the flag absent still answers no, and so does one
    // whose flag is present but not a `true` — the rule reads one field and asks only whether it is the
    // boolean `true`, so a truthy look-alike from a hand-edited file does not open the gate.
    assert.equal(providerAcceptsImages({ enabledModels: ['a'], fetchedModels: [], supportsImages: true }), true)
    assert.equal(providerAcceptsImages({ enabledModels: ['a'], fetchedModels: [] }), false)
    assert.equal(providerAcceptsImages({ supportsImages: 'yes' }), false)
    assert.equal(providerAcceptsImages('deepseek'), false)
  })

  step('the composer reads the gate and nothing of its own', () => {
    assert.equal(composerAcceptsImages(undefined), false)
    assert.equal(composerAcceptsImages({ supportsImages: true }), true)
  })

  step('the refusal is said in the renderer’s words and names the provider', () => {
    // No new error code and no message in the protocol: the gate is a preference, so what the composer
    // shows is its own sentence, and the one fact it needs from outside is which provider is selected.
    const notice = imageCapabilityNotice('DeepSeek')
    assert.match(notice, /DeepSeek/)
    assert.match(notice, /Settings/)
  })
}

// -----------------------------------------------------------------------------------------------
// Capture-time validation, and that it is the shared rules
// -----------------------------------------------------------------------------------------------

function testCaptureValidation(): void {
  step('a media type nothing can send is refused at capture', () => {
    for (const mimeType of ['image/svg+xml', 'image/bmp', 'image/tiff', 'application/pdf', '']) {
      const refusal = attachmentCaptureRefusal({ mimeType, bytes: 1024, attached: 0 })
      assert.equal(refusal?.code, IMAGE_ATTACH_REFUSED, `${mimeType} should be refused`)
    }
    assert.equal(attachmentCaptureRefusal({ mimeType: 'image/png', bytes: 1024, attached: 0 }), null)
  })

  step('the size cap is inclusive at the boundary', () => {
    assert.equal(attachmentCaptureRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES, attached: 0 }), null)
    assert.equal(
      attachmentCaptureRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES + 1, attached: 0 })?.code,
      IMAGE_ATTACH_REFUSED
    )
  })

  step('the sentences are the store’s own, word for word', () => {
    // Asked through the rules rather than written again. A drift here would be a composer promising a
    // different number than the schema refuses — which is the failure this whole suite exists to catch.
    const size = attachmentCaptureRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES + 1, attached: 0 })
    assert.equal(size?.message, attachmentRefusal({ mimeType: 'image/png', bytes: MAX_ATTACHMENT_BYTES + 1 })?.message)

    const type = attachmentCaptureRefusal({ mimeType: 'image/tiff', bytes: 8, attached: 0 })
    assert.equal(type?.message, attachmentRefusal({ mimeType: 'image/tiff', bytes: 8 })?.message)

    const count = attachmentCaptureRefusal({
      mimeType: 'image/png',
      bytes: 8,
      attached: MAX_ATTACHMENTS_PER_MESSAGE,
    })
    assert.equal(count?.message, attachmentCountRefusal(MAX_ATTACHMENTS_PER_MESSAGE + 1)?.message)
  })

  step('the file’s own rules are answered before the count', () => {
    // An unusable file is unusable wherever it would sit, so the sentence worth reading is about the file.
    // Over the cap *and* the wrong type answers about the type.
    const refusal = attachmentCaptureRefusal({
      mimeType: 'application/pdf',
      bytes: MAX_ATTACHMENT_BYTES + 1,
      attached: MAX_ATTACHMENTS_PER_MESSAGE,
    })
    assert.equal(refusal?.message, attachmentRefusal({ mimeType: 'application/pdf', bytes: 0 })?.message)
  })

  step('a refusal names the file in front of the rule', () => {
    const refusal = attachmentCaptureRefusal({ mimeType: 'image/tiff', bytes: 8, attached: 0 })
    assert.ok(refusal)
    const notice = attachmentRefusalNotice('scan.tiff', refusal)
    assert.match(notice, /^scan\.tiff: /)
    assert.match(notice, /scan\.tiff|image\/tiff/)
  })
}

// -----------------------------------------------------------------------------------------------
// The per-message cap, through the draft
// -----------------------------------------------------------------------------------------------

function testMessageCap(): void {
  step('the fourth image is taken and the fifth is refused', () => {
    let draft: DraftAttachment[] = []
    for (let index = 1; index <= MAX_ATTACHMENTS_PER_MESSAGE; index += 1) {
      const applied = addDraftAttachment(draft, {
        name: `shot-${index}.png`,
        mimeType: 'image/png',
        bytes: new Uint8Array(8),
      })
      assert.equal(applied.notice, null, `image ${index} should have been taken`)
      draft = applied.draft
    }
    assert.equal(draft.length, MAX_ATTACHMENTS_PER_MESSAGE)

    const refused = addDraftAttachment(draft, {
      name: 'one-too-many.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(8),
    })
    assert.equal(refused.draft.length, MAX_ATTACHMENTS_PER_MESSAGE, 'nothing was added')
    assert.match(String(refused.notice), new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} images`))
  })

  step('a refused image leaves the draft exactly as it was', () => {
    const draft = [image('first.png'), image('second.png')]
    const refused = addDraftAttachment(draft, {
      name: 'huge.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
    })
    assert.deepEqual(refused.draft, draft)
    assert.equal(draft.length, 2, 'the input array is not mutated either')
  })

  step('the picker offers exactly the whitelist', () => {
    // Built from the whitelist rather than written out, so a browser that filters its dialog and a rule
    // that refuses at capture cannot come to offer different types.
    assert.equal(ATTACHMENT_ACCEPT_ATTRIBUTE, 'image/png,image/jpeg,image/webp,image/gif')
  })

  step('a chip has a size a person can read', () => {
    assert.equal(attachmentSizeLabel(1), '1 byte')
    assert.equal(attachmentSizeLabel(900), '900 bytes')
    assert.equal(attachmentSizeLabel(1024), '1 KB')
    assert.equal(attachmentSizeLabel(412 * 1024), '412 KB')
    assert.equal(attachmentSizeLabel(8 * 1024 * 1024), '8.0 MB')
  })
}

// -----------------------------------------------------------------------------------------------
// Attach order
// -----------------------------------------------------------------------------------------------

function testAttachOrder(): void {
  step('the saves a send dispatches are in attach order', () => {
    const draft = [image('first.png'), image('second.png'), image('third.png')]
    const requests = attachmentSaveRequests('aaaaaaaa-1111-4111-8111-111111111111', draft)

    // Positional, one per image, in the draft's own order — which is what makes the references come back
    // in the user's order, since the send awaits them one at a time.
    assert.deepEqual(
      requests.map((request) => request.name),
      ['first.png', 'second.png', 'third.png']
    )
    assert.deepEqual(
      requests.map((request) => request.sessionId),
      [
        'aaaaaaaa-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
      ]
    )
    assert.deepEqual(requests[1].bytes, draft[1].bytes)
  })

  step('a send with no images dispatches no saves', () => {
    assert.deepEqual(attachmentSaveRequests('aaaaaaaa-1111-4111-8111-111111111111', []), [])
  })

  step('removing one image keeps the order of the rest', () => {
    const draft = [image('first.png'), image('second.png'), image('third.png')]
    const kept = removeDraftAttachment(draft, 'draft-second.png')
    assert.deepEqual(
      kept.map((attachment) => attachment.name),
      ['first.png', 'third.png']
    )
  })

  step('the turn records the references in the order it was handed them', () => {
    // The commit point: whatever order the saves came back in, this is where it becomes the transcript's.
    // Nothing here sorts, keys or de-duplicates, which is the property being pinned.
    const first = ref('aaaaaaaa-1111-4111-8111-111111111111', 'first.png')
    const second = ref('bbbbbbbb-2222-4222-8222-222222222222', 'second.png')
    const turn = startUserTurn('look at these', [], [first, second])

    assert.deepEqual(turn.imageRefs, [first, second])
    assert.equal(turn.content, 'look at these', 'the message is still the string the user typed')
  })

  step('a turn with no images carries no key at all', () => {
    // The additive rule the whole transcript follows: a message with nothing attached is stored exactly as
    // it was before images existed, rather than with an empty list a reader would have to interpret.
    const none = startUserTurn('just words')
    assert.equal('imageRefs' in none, false)
    assert.equal('imageRefs' in startUserTurn('just words', [], []), false)
  })

  step('the references are copied, not referenced', () => {
    const source = ref('aaaaaaaa-1111-4111-8111-111111111111', 'first.png')
    const turn = startUserTurn('look', [], [source])
    source.name = 'mutated.png'
    assert.equal(turn.imageRefs?.[0].name, 'first.png')
  })
}

// -----------------------------------------------------------------------------------------------
// What a capture path hands over
// -----------------------------------------------------------------------------------------------

function testFileSources(): void {
  step('a paste carrying only prose hands over nothing', () => {
    // The property the composer rests on when it leaves a text paste alone: no files, no interception.
    assert.deepEqual(filesIn(null), [])
    assert.deepEqual(filesIn(undefined), [])
    assert.deepEqual(filesIn({}), [])
    assert.deepEqual(filesIn({ files: null }), [])
    assert.deepEqual(filesIn({ files: [] }), [])
  })

  step('the lists a paste, a drop and an input expose are all read the same way', () => {
    // An input's `FileList` and a transfer's `files` are both array-likes; this reads either, and reads
    // them in the order they were listed.
    const one = new File([new Uint8Array(4)], 'one.png', { type: 'image/png' })
    const two = new File([new Uint8Array(4)], 'two.png', { type: 'image/png' })
    assert.deepEqual(
      filesIn({ files: [one, two] }).map((file) => file.name),
      ['one.png', 'two.png']
    )
  })
}

// -----------------------------------------------------------------------------------------------

function main(): void {
  testCapabilityGate()
  testCaptureValidation()
  testMessageCap()
  testAttachOrder()
  testFileSources()
  console.log(`\nIMAGE ATTACHMENT CAPTURE PASSED: ${results.length} checks`)
}

main()
