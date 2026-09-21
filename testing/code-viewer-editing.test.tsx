import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkspaceChangeInvalidation } from '@/app/components/workbench/use-workspace-changes'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The code viewer's editing, as wiring rather than as rules.
 *
 * Every rule this exercises — what a conflict is, what dirty means, what Tab inserts, what a failed
 * save says — is tested directly in `editing-rules.test.ts`. What is left here is the part a rule test
 * cannot see: whether the toggle reaches the textarea, whether Ctrl+S reaches the bridge with the
 * path and content main expects, and whether the two banners appear for the right event.
 *
 * The suite renders under the app's own `queryClient`, because the conveyor client captures that
 * instance at construction and `invalidate()` targets the captured one — a fresh client here would
 * observe no refetch at all. It is cleared between tests.
 */

const PATH = 'src/app.ts'
const ROOT = 'C:/w'
const ON_DISK = 'const a = 1\n'
/** An mtime for the open file. Distinct from `DISK_MTIME_2` so a stale baseline can be staged. */
const DISK_MTIME = 1_700_000_000_000
const DISK_MTIME_2 = 1_700_000_000_999

/** The form the viewer opens in: a repository with one file, already selected. */
function stubViewer(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    readFile: () => ({ path: PATH, content: ON_DISK, baselineMtime: DISK_MTIME }),
    writeFile: () => ({ path: PATH, bytes: ON_DISK.length, mtimeMs: DISK_MTIME_2 }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    ...overrides,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT })
  setActiveStub(stub)
  return stub
}

/**
 * The viewer plus the workspace-change subscription.
 *
 * The subscription is registered at the workbench in the app, not inside the viewer, so a suite that
 * rendered the viewer alone would have no listener at all and could never observe an external change.
 * Mounting the same hook here is the honest arrangement: it is the wiring under test — an event for the
 * open path reaching the viewer's decision — rather than a stand-in for it.
 */
function ViewerUnderChangeSubscription() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  useWorkspaceChangeInvalidation(selectedFile)
  return <CodeViewer />
}

function renderViewer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ViewerUnderChangeSubscription />
    </QueryClientProvider>
  )
}

/**
 * The read view's text, whatever the highlighting wrapped it in.
 *
 * The viewer tokenizes a `.ts` file, so the source arrives as spans rather than as one text node and a
 * `getByText` query no longer matches it — the content is still on screen, it is just no longer a
 * single node. Reading the element's `textContent` asserts what these cases are actually about (the
 * disk's content is what is shown), without depending on how many elements it was split into.
 */
function readText(container: HTMLElement): string {
  return container.querySelector('code')?.textContent ?? ''
}

/** Open the viewer with a file selected, and wait for its contents to land. */
async function openFile() {
  const view = renderViewer()
  await waitFor(() => expect(readText(view.container)).toContain('const a = 1'))
  return view
}

/** Enter edit mode and hand back the textarea. */
async function startEditing(): Promise<HTMLTextAreaElement> {
  await userEvent.click(await screen.findByLabelText('Edit this file'))
  return (await screen.findByLabelText(`Edit ${PATH.split('/').pop()}`)) as HTMLTextAreaElement
}

beforeEach(() => {
  useWorkbenchStore.setState({
    selectedFile: PATH,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
  queryClient.clear()
})

describe('edit mode', () => {
  it('swaps the read-only render for a textarea, and back', async () => {
    stubViewer()
    await openFile()

    // Read-only to begin with: the viewer opens as a viewer.
    expect(screen.queryByLabelText('Edit app.ts')).toBeNull()

    const area = await startEditing()
    expect(area.tagName).toBe('TEXTAREA')
    expect(area.getAttribute('wrap')).toBe('off')

    await userEvent.click(screen.getByLabelText('Stop editing'))
    await waitFor(() => expect(screen.queryByLabelText('Edit app.ts')).toBeNull())
  })

  it('inserts two spaces when Tab is pressed, keeping the caret after them', async () => {
    stubViewer()
    await openFile()
    const area = await startEditing()

    area.setSelectionRange(0, 0)
    await userEvent.keyboard('{Tab}')

    // Two spaces, not a focused field: the caret moved instead of leaving the textarea.
    await waitFor(() =>
      expect((screen.getByLabelText('Edit app.ts') as HTMLTextAreaElement).value).toBe('  ' + ON_DISK)
    )
  })

  it('keeps unsaved edits when edit mode is left', async () => {
    stubViewer()
    await openFile()
    const area = await startEditing()

    await userEvent.type(area, '// mine\n')
    await userEvent.click(screen.getByLabelText('Stop editing'))

    // Re-entering finds the same text — the spec's "leaving with unsaved changes keeps them".
    await userEvent.click(screen.getByLabelText('Edit this file'))
    const again = (await screen.findByLabelText('Edit app.ts')) as HTMLTextAreaElement
    expect(again.value).toContain('// mine')
    // And the dirty dot is still there, because the file is still unsaved.
    expect(screen.getByLabelText('app.ts has unsaved changes')).toBeTruthy()
  })

  it('shows the dirty dot only once something is typed', async () => {
    stubViewer()
    await openFile()

    expect(screen.queryByLabelText('app.ts has unsaved changes')).toBeNull()

    const area = await startEditing()
    await userEvent.type(area, 'x')

    expect(await screen.findByLabelText('app.ts has unsaved changes')).toBeTruthy()
  })

  it('leaves a file over the read cap read-only, with no toggle', async () => {
    stubViewer({
      readFile: () => {
        throw new ConveyorError('FILE_TOO_LARGE', 'too big')
      },
    })
    renderViewer()

    expect(await screen.findByText(/too large to preview/)).toBeTruthy()
    // No way in: the buffer would be empty, and saving it would overwrite a file nobody has seen.
    expect(screen.queryByLabelText('Edit this file')).toBeNull()
    expect(screen.getByText('read-only')).toBeTruthy()
  })
})

describe('saving', () => {
  it('sends the path and the buffer through the bridge, and clears the dirty dot', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()

    await userEvent.type(area, '// edited\n')
    await userEvent.click(screen.getByLabelText('Save file'))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))
    const written = stub.callsTo('workspace').find((call) => call.method === 'writeFile')
    // The payload the existing main command validates: path, content, the open root, and the mtime the
    // buffer is based on. The text is appended because the caret is at the end when edit mode focuses
    // the field.
    expect(written?.args[0]).toEqual({
      path: PATH,
      content: ON_DISK + '// edited\n',
      rootPath: ROOT,
      baselineMtime: DISK_MTIME,
    })

    await waitFor(() => expect(screen.queryByLabelText('app.ts has unsaved changes')).toBeNull())
  })

  it('saves on Ctrl+S', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()

    await userEvent.type(area, 'x')
    await userEvent.keyboard('{Control>}s{/Control}')

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))
    const written = stub.callsTo('workspace').find((call) => call.method === 'writeFile')
    expect((written?.args[0] as { content: string }).content).toBe(ON_DISK + 'x')
  })

  it('reports a refused save as a banner naming the code, and keeps the edits', async () => {
    stubViewer({
      writeFile: () => {
        throw new ConveyorError('PATH_TRAVERSAL', 'refused')
      },
    })
    await openFile()
    const area = await startEditing()

    await userEvent.type(area, 'x')
    await userEvent.keyboard('{Control>}s{/Control}')

    // The wording is ours, chosen by the code; the code rides along because it does not move.
    expect(await screen.findByText(/outside the open folder/i)).toBeTruthy()
    expect(screen.getByText('(PATH_TRAVERSAL)')).toBeTruthy()
    expect(screen.getByText(/Your edits are still here/)).toBeTruthy()
    // Still dirty, because nothing was written.
    expect(screen.getByLabelText('app.ts has unsaved changes')).toBeTruthy()
  })
})

describe('a change on disk', () => {
  /** Push an external write for the open path, as main would. */
  async function externalWrite(stub: BridgeStub, content: string) {
    stub.on('readFile', () => ({ path: PATH, content }))
    // The channel conveyor builds for an event, spelled out rather than guessed — the stub delivers to
    // every subscriber, so this is documentation of what the app subscribes to as much as it is routing.
    stub.emit('conveyor:event:workspace:onChanged', { kind: 'written', path: PATH })
    // The burst is coalesced, so give the window a chance to close before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  it('refetches exactly as before when the buffer is clean', async () => {
    const stub = stubViewer()
    const view = await openFile()

    const before = stub.callsTo('workspace').filter((call) => call.method === 'readFile').length
    await externalWrite(stub, 'const a = 2\n')

    // Adopted, with nothing said: the user had no edits to lose.
    await waitFor(() => expect(readText(view.container)).toContain('const a = 2'))
    expect(stub.callsTo('workspace').filter((call) => call.method === 'readFile').length).toBeGreaterThan(before)
    expect(screen.queryByText(/changed on disk/)).toBeNull()
  })

  it('renders the conflict banner when the buffer has edits', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, '// mine\n')

    await externalWrite(stub, 'const a = 99\n')

    expect(await screen.findByText(/changed on disk while you have unsaved edits/)).toBeTruthy()
    // The buffer is untouched: the user's text is the thing at stake.
    expect((screen.getByLabelText('Edit app.ts') as HTMLTextAreaElement).value).toContain('// mine')
  })

  it('says nothing when an event arrives but the disk still holds what was loaded', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, '// mine\n')

    // The same bytes: a touch, or a save of identical content. There is no conflict to report.
    await externalWrite(stub, ON_DISK)

    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull())
    expect((screen.getByLabelText('Edit app.ts') as HTMLTextAreaElement).value).toContain('// mine')
  })

  it('Reload takes the disk and drops the local buffer', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, '// mine\n')
    await externalWrite(stub, 'const a = 99\n')

    await userEvent.click(await screen.findByRole('button', { name: 'Reload' }))

    // The disk's content is what the buffer holds now, and the banner is gone. Asserted on the buffer
    // rather than on the read view, because edit mode was never left: after a reload the arriving read
    // refills the buffer, so the textarea is what is on screen and its value is the thing Reload
    // changed. (The read view's own text is covered in `code-viewer-highlight.test.tsx`.)
    await waitFor(() =>
      expect((screen.getByLabelText('Edit app.ts') as HTMLTextAreaElement).value).toContain('const a = 99')
    )
    expect(screen.queryByText(/changed on disk/)).toBeNull()
    expect(screen.queryByLabelText('app.ts has unsaved changes')).toBeNull()
  })

  it('Keep mine dismisses the banner and keeps editing, so the next save overwrites', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, '// mine\n')
    await externalWrite(stub, 'const a = 99\n')

    await userEvent.click(await screen.findByRole('button', { name: 'Keep mine' }))

    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull())
    // Still editing, still dirty, with the local text intact.
    const still = (await screen.findByLabelText('Edit app.ts')) as HTMLTextAreaElement
    expect(still.value).toContain('// mine')
    expect(screen.getByLabelText('app.ts has unsaved changes')).toBeTruthy()

    await userEvent.click(screen.getByLabelText('Save file'))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))
    const written = stub.callsTo('workspace').find((call) => call.method === 'writeFile')
    // The local text overwrites what was on disk, which is what "Keep mine" promises.
    expect((written?.args[0] as { content: string }).content).toContain('// mine')
  })

  it('does not raise its own banner after a save', async () => {
    // The self-write case: saving raises a workspace event for the file that was just written, and the
    // read it triggers carries the bytes the baseline already holds.
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, '// mine\n')
    await userEvent.click(screen.getByLabelText('Save file'))
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))

    // What main broadcasts after the write, and the read that follows it.
    stub.on('readFile', () => ({ path: PATH, content: ON_DISK + '// mine\n' }))
    stub.emit('conveyor:event:workspace:onChanged', { kind: 'written', path: PATH })
    await new Promise((resolve) => setTimeout(resolve, 200))

    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull())
    expect(screen.queryByLabelText('app.ts has unsaved changes')).toBeNull()
  })
})

describe('the write baseline', () => {
  it('sends the mtime it loaded as the baseline', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, 'x')

    await userEvent.click(screen.getByLabelText('Save file'))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))
    const written = stub.callsTo('workspace').find((call) => call.method === 'writeFile')
    // The baseline travels with the content, which is the whole guard: main compares it with the disk
    // immediately before writing.
    expect((written?.args[0] as { baselineMtime?: number }).baselineMtime).toBe(DISK_MTIME)
    // And no force on an ordinary save: forcing is a decision the user has not made yet.
    expect((written?.args[0] as { force?: boolean }).force).toBeUndefined()
  })

  it('uses the mtime the previous save returned for the next save', async () => {
    const stub = stubViewer()
    await openFile()
    const area = await startEditing()

    await userEvent.type(area, 'one')
    await userEvent.click(screen.getByLabelText('Save file'))
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('writeFile'))

    await userEvent.type(area, 'two')
    await userEvent.click(screen.getByLabelText('Save file'))

    await waitFor(() => {
      const writes = stub.callsTo('workspace').filter((call) => call.method === 'writeFile')
      expect(writes.length).toBe(2)
    })
    const writes = stub.callsTo('workspace').filter((call) => call.method === 'writeFile')
    // The second save is guarded against what the first one wrote — `DISK_MTIME_2` — not against the
    // mtime that was loaded. Guarding against the stale one would refuse the user's own second save.
    expect((writes[1].args[0] as { baselineMtime?: number }).baselineMtime).toBe(DISK_MTIME_2)
  })

  it('renders the conflict banner when main refuses a stale-baseline save', async () => {
    stubViewer({
      writeFile: () => {
        throw new ConveyorError('WRITE_CONFLICT', 'changed on disk')
      },
    })
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, '// mine\n')

    await userEvent.click(screen.getByLabelText('Save file'))

    // Its own banner, not the generic save failure: the buffer is still the user's and the disk still
    // holds the other version, so the ways out are different.
    expect(await screen.findByText(/changed on disk since you opened it, so your save was not written/)).toBeTruthy()
    // The edits are kept and the file is still unsaved.
    expect((screen.getByLabelText('Edit app.ts') as HTMLTextAreaElement).value).toContain('// mine')
    expect(screen.getByLabelText('app.ts has unsaved changes')).toBeTruthy()
  })

  it('Keep mine re-sends with an explicit force', async () => {
    const stub = stubViewer({
      writeFile: (input) => {
        const forced = (input as { force?: boolean }).force === true
        // The first attempt is refused; the second, forced one goes through. That is the whole
        // two-click contract: the refusal never retries itself.
        if (!forced) throw new ConveyorError('WRITE_CONFLICT', 'changed on disk')
        return { path: PATH, bytes: 1, mtimeMs: DISK_MTIME_2 }
      },
    })
    await openFile()
    const area = await startEditing()
    await userEvent.type(area, 'mine')

    await userEvent.click(screen.getByLabelText('Save file'))
    expect(await screen.findByText(/your save was not written/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }))

    await waitFor(() => {
      const writes = stub.callsTo('workspace').filter((call) => call.method === 'writeFile')
      expect(writes.length).toBe(2)
    })
    const writes = stub.callsTo('workspace').filter((call) => call.method === 'writeFile')
    expect((writes[0].args[0] as { force?: boolean }).force).toBeUndefined()
    expect((writes[1].args[0] as { force?: boolean }).force).toBe(true)
    // The same baseline goes again: the guard is still told what the buffer is based on, and force is
    // what overrides the mismatch rather than a dropped baseline.
    expect((writes[1].args[0] as { baselineMtime?: number }).baselineMtime).toBe(DISK_MTIME)

    // Saved, so the banner is gone and the file is no longer dirty.
    await waitFor(() => expect(screen.queryByText(/your save was not written/)).toBeNull())
    expect(screen.queryByLabelText('app.ts has unsaved changes')).toBeNull()
  })

  it('Reload refetches the content and the mtime', async () => {
    const stub = stubViewer({
      writeFile: () => {
        throw new ConveyorError('WRITE_CONFLICT', 'changed on disk')
      },
      listDirectory: () => [],
    })
    const view = await openFile()
    const area = await startEditing()
    await userEvent.type(area, 'mine')
    await userEvent.click(screen.getByLabelText('Save file'))
    expect(await screen.findByText(/your save was not written/)).toBeTruthy()

    // What the disk holds now, with its own mtime.
    stub.on('readFile', () => ({ path: PATH, content: 'const a = 99\n', baselineMtime: DISK_MTIME_2 }))
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

    // Both are taken: the disk's content replaces the buffer, and the banner is gone because the
    // question it asked has been answered. Read off the buffer, which is what is on screen — edit mode
    // was never left, so the textarea is showing and its value is what the reload replaced.
    await waitFor(() =>
      expect((screen.getByLabelText('Edit app.ts') as HTMLTextAreaElement).value).toContain('const a = 99')
    )
    expect(screen.queryByText(/your save was not written/)).toBeNull()
    expect(screen.queryByLabelText('app.ts has unsaved changes')).toBeNull()
    // The read view is still the pane's other half, so the refetched content is there to be shown when
    // edit mode is left — which also keeps `view` meaningful rather than incidental.
    await userEvent.click(screen.getByLabelText('Stop editing'))
    await waitFor(() => expect(readText(view.container)).toContain('const a = 99'))
    await userEvent.click(screen.getByLabelText('Edit this file'))
    await screen.findByLabelText('Edit app.ts')

    // And the refetched mtime is what the next save is guarded against. Edit mode was never left, so
    // the textarea is already there — only the buffer had been dropped.
    await userEvent.type(await screen.findByLabelText('Edit app.ts'), 'z')
    await userEvent.click(screen.getByLabelText('Save file'))
    await waitFor(() => {
      const writes = stub.callsTo('workspace').filter((call) => call.method === 'writeFile')
      expect(writes.length).toBe(2)
    })
    const writes = stub.callsTo('workspace').filter((call) => call.method === 'writeFile')
    expect((writes[1].args[0] as { baselineMtime?: number }).baselineMtime).toBe(DISK_MTIME_2)
  })
})
