/**
 * The image parts a send actually carries, at the two places that matter: the pure builder that turns a
 * history into provider content, and the loop's request, which is where that builder is consumed.
 *
 * Failing-first: `withResolvedImages` and the loop's image resolution do not exist yet, so this suite
 * cannot even bundle. What it pins is the shape the provider sees — text part first, images in attach
 * order, a plain string for a turn that carries none — and the one failure that must never be silent:
 * a reference whose bytes are gone aborts the send with a code rather than sending the text alone.
 *
 * The store is the real one, in a private temp root, and the loop's own resolver is what reads it: the
 * resolver is the production path, so a suite that stubbed it would prove nothing about the send.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import { runAgentLoop } from '../../conveyor/modules/agent'
import { withResolvedImages, type HistoryMessage } from '../../conveyor/modules/llm-engine'
import { saveAttachment, sweepAttachmentFolders } from '../../conveyor/modules/image-attachments'
import {
  IMAGE_ATTACH_NOT_FOUND,
  type ImageAttachmentRef,
  type ResolvedAttachment,
} from '../../conveyor/protocol/image-attachments'

const results: string[] = []
const roots: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
  results.push(label)
}

/** The root the electron stub points `app.getPath('userData')` at, which the loop's resolver reads. */
function storedRoot(): string {
  return process.env.SAM_TEST_USER_DATA ?? join(tmpdir(), 'sam-ai-images-request')
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-images-workspace-'))
  roots.push(root)
  return root
}

const SESSION = '11111111-2222-4333-8444-555555555555'
const PAYLOAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7])
const PAYLOAD_URL = `data:image/png;base64,${Buffer.from(PAYLOAD).toString('base64')}`

/** One attachment in a history, as a turn that carried it hands it over. */
async function storeImage(name: string): Promise<ImageAttachmentRef> {
  return saveAttachment(storedRoot(), { sessionId: SESSION, name, mimeType: 'image/png', bytes: PAYLOAD })
}

/** A resolver that answers with a distinct URL per reference, and counts how often it is asked. */
function countingResolver(seen: string[]): (image: ImageAttachmentRef) => Promise<ResolvedAttachment> {
  return async (image) => {
    seen.push(image.id)
    return { ref: image, dataUrl: `data:image/png;base64,${image.name}` }
  }
}

/** Build a Response whose body is the given SSE frames. */
function sseResponse(frames: string[]): Response {
  const payload = frames.map((frame) => `data: ${frame}\n\n`).join('')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}

/** The prose ending, which is how a round-trip that asks for nothing finishes a turn. */
function proseFetch(log: Array<Record<string, unknown>>): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    log.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Seen.' } }] }), '[DONE]'])
  }
}

/**
 * A provider that asks for one read, so the turn takes two round-trips.
 *
 * The point of the second round-trip is the second request body: a history resolved per request could
 * read the store twice for one run, and this is the shape that would expose it.
 */
function toolThenProseFetch(
  log: Array<Record<string, unknown>>
): (url: string, init: RequestInit) => Promise<Response> {
  let call = 0
  return async (_url, init) => {
    call += 1
    log.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    if (call === 1) {
      return sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
            },
          ],
        }),
        '[DONE]',
      ])
    }
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Read.' } }] }), '[DONE]'])
  }
}

async function collect(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of iter) {
    // Drained: the assertions are on the requests the run made, not on its chunks.
  }
}

/** The code a rejected run carried, or a description of why it did not reject. */
async function rejectionCodeOf(run: () => Promise<void>): Promise<string> {
  try {
    await run()
  } catch (err) {
    return err instanceof ConveyorError ? err.code : `not a ConveyorError: ${String(err)}`
  }
  return 'resolved'
}

/** The one message of a request body whose content is the dialect's part array. */
function partMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>
  return messages.filter((message) => Array.isArray(message.content))
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

async function testBuilder(): Promise<void> {
  await step('a turn with images becomes the dialect parts, text first in attach order', async () => {
    const history: HistoryMessage[] = [
      {
        role: 'user',
        content: 'the second one is the bug',
        images: [
          { id: 'a', name: 'one.png', mimeType: 'image/png', size: 9 },
          { id: 'b', name: 'two.png', mimeType: 'image/png', size: 9 },
        ],
      },
    ]

    const parts = await withResolvedImages(history, countingResolver([]))
    const content = parts[0].content

    assert.ok(Array.isArray(content), 'a turn with images must go out as parts')
    assert.deepEqual(content, [
      { type: 'text', text: 'the second one is the bug' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,one.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,two.png' } },
    ])
    // The references are a transport, not a wire field: an unknown key on a message is how a request
    // gets refused by a provider that validates its input.
    assert.ok(!('images' in parts[0]), 'the references must not survive onto the wire message')
  })

  await step('a text-only turn keeps the plain string it has always been sent as', async () => {
    const history: HistoryMessage[] = [{ role: 'user', content: 'just words' }]

    const sent = await withResolvedImages(history, countingResolver([]))

    // Asserted as equality against the message itself: the regression rule is that every conversation
    // with no image in it goes out byte-for-byte as it did before this feature existed.
    assert.deepEqual(sent, [{ role: 'user', content: 'just words' }])
    assert.equal(typeof sent[0].content, 'string')
  })

  await step('the references are resolved in attach order, once each', async () => {
    const seen: string[] = []
    const history: HistoryMessage[] = [
      { role: 'user', content: 'look', images: [{ id: 'one', name: 'a.png', mimeType: 'image/png', size: 1 }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and this', images: [{ id: 'two', name: 'b.png', mimeType: 'image/png', size: 1 }] },
    ]

    await withResolvedImages(history, countingResolver(seen))

    // The user's order, which is what the model reads the parts in.
    assert.deepEqual(seen, ['one', 'two'])
  })
}

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

async function testLoopRequest(): Promise<void> {
  await step('the request body the loop sends carries the parts, and the text stays a string', async () => {
    const workspace = makeWorkspace()
    const first = await storeImage('first.png')
    const second = await storeImage('second.png')

    const history: HistoryMessage[] = [
      { role: 'user', content: 'just words' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'what is wrong here', images: [first, second] },
    ]

    const log: Array<Record<string, unknown>> = []
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: workspace,
        sessionId: SESSION,
        messages: history,
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: proseFetch(log) as never,
      })
    )

    assert.equal(log.length, 1, 'a turn with no tool call is one request')
    const body = log[0]
    const messages = (body.messages ?? []) as Array<Record<string, unknown>>

    // The text-only turn is untouched, and that is the regression rule seen from the request side.
    const plain = messages.find((message) => message.content === 'just words')
    assert.ok(plain, 'the text-only turn must still be sent as a string')

    // The image turn is the parts array, resolved from the store this run was told about.
    const withImages = partMessages(body)
    assert.equal(withImages.length, 1, 'exactly one turn carries images')
    assert.deepEqual(withImages[0].content, [
      { type: 'text', text: 'what is wrong here' },
      { type: 'image_url', image_url: { url: PAYLOAD_URL } },
      { type: 'image_url', image_url: { url: PAYLOAD_URL } },
    ])

    // And nothing on the wire mentions a reference: no message carries the transport field.
    assert.ok(!messages.some((message) => 'images' in message), 'no reference field may reach the provider')
  })

  await step('a reference is read once per run, not once per round-trip', async () => {
    const workspace = makeWorkspace()
    const first = await storeImage('counted.png')
    const second = await storeImage('counted-again.png')

    const seen: string[] = []
    const log: Array<Record<string, unknown>> = []
    await collect(
      runAgentLoop({
        providerId: 'deepseek',
        apiKey: 'test-key',
        model: 'test-model',
        workspaceRoot: workspace,
        sessionId: SESSION,
        messages: [{ role: 'user', content: 'look', images: [first, second] }],
        autoApprove: false,
        signal: new AbortController().signal,
        fetchImpl: toolThenProseFetch(log) as never,
        resolveImage: countingResolver(seen),
      })
    )

    // Two round-trips, two references, two reads: the bytes are resolved per run and remembered for
    // the run rather than re-encoded on every request it makes.
    assert.equal(log.length, 2, 'the tool call must have produced a second request')
    assert.deepEqual(seen, [first.id, second.id])
    // And both requests carried the same parts, because both were built from the same history.
    assert.equal(partMessages(log[1]).length, 1)
  })

  await step('a turn whose reference is gone aborts with the code, sending nothing', async () => {
    const workspace = makeWorkspace()
    const ref = await storeImage('vanishing.png')

    // Swept before the send: the reference the transcript recorded points at bytes that are no longer
    // stored, which is the one case where sending the text alone would put a lie in the conversation.
    rmSync(join(storedRoot(), 'attachments', SESSION), { recursive: true, force: true })

    const log: Array<Record<string, unknown>> = []
    const code = await rejectionCodeOf(() =>
      collect(
        runAgentLoop({
          providerId: 'deepseek',
          apiKey: 'test-key',
          model: 'test-model',
          workspaceRoot: workspace,
          sessionId: SESSION,
          messages: [{ role: 'user', content: 'what is wrong here', images: [ref] }],
          autoApprove: false,
          signal: new AbortController().signal,
          fetchImpl: proseFetch(log) as never,
        })
      )
    )

    assert.equal(code, IMAGE_ATTACH_NOT_FOUND)
    assert.equal(log.length, 0, 'nothing may be sent once a reference cannot be resolved')
  })

  await step('a run told no session cannot resolve its references and says so', async () => {
    const workspace = makeWorkspace()
    const ref: ImageAttachmentRef = {
      id: '11111111-2222-4333-8444-999999999999',
      name: 'x.png',
      mimeType: 'image/png',
      size: 9,
    }

    const code = await rejectionCodeOf(() =>
      collect(
        runAgentLoop({
          providerId: 'deepseek',
          apiKey: 'test-key',
          model: 'test-model',
          workspaceRoot: workspace,
          messages: [{ role: 'user', content: 'look', images: [ref] }],
          autoApprove: false,
          signal: new AbortController().signal,
          fetchImpl: proseFetch([]) as never,
        })
      )
    )

    assert.equal(code, IMAGE_ATTACH_NOT_FOUND)
  })
}

async function main(): Promise<void> {
  try {
    await testBuilder()
    await testLoopRequest()
    // Housekeeping from the runs above: the same sweep the app performs at startup.
    await sweepAttachmentFolders([])
    console.log(`\nIMAGE REQUEST PARTS SUITE PASSED: ${results.length} checks`)
  } catch (err) {
    console.error('\nIMAGE REQUEST PARTS SUITE FAILED:', err)
    process.exit(1)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main()
