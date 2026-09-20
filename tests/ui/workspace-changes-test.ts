/**
 * Verifies the renderer half: what a burst of workspace changes makes the cache do.
 *
 * No React and no real cache — the coalescer takes its clock and its event source as parameters, so
 * a burst can be driven deterministically rather than waited on, and the invalidation calls are
 * recorded by a fake client. Use `flush()` rather than advancing real time, so the assertions do not
 * depend on how fast the machine is.
 */
import { strict as assert } from 'node:assert'
import {
  COALESCE_MS,
  createChangeCoalescer,
  createWorkspaceChangeHandlers,
  subscribeToWorkspaceChanges,
  type ChangeHandlers,
} from '../../app/components/workbench/workspace-changes'
import type { WorkspaceChanged } from '../../conveyor/events'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** Records what the handlers asked the cache to do. */
class FakeCache {
  listingInvalidations = 0
  fileInvalidations: string[] = []
  /** The roots git's reads were invalidated for, in order. */
  gitStatusInvalidations: string[] = []
  gitDiffInvalidations: string[] = []
  /** The open file, as the viewer would report it. */
  openFile: string | null = null
  /** The open folder, as the workspace store would report it. */
  rootPath: string | null = '/w'

  handlers(): ChangeHandlers {
    return createWorkspaceChangeHandlers(
      this.client(),
      () => this.openFile,
      () => this.rootPath
    )
  }

  client() {
    return {
      workspace: {
        listDirectory: {
          invalidate: async () => {
            this.listingInvalidations += 1
          },
        },
        readFile: {
          invalidate: async (input: { path: string }) => {
            this.fileInvalidations.push(input.path)
          },
        },
      },
      git: {
        status: {
          invalidate: async (input: { rootPath: string }) => {
            this.gitStatusInvalidations.push(input.rootPath)
          },
        },
        branch: { invalidate: async () => {} },
        log: { invalidate: async () => {} },
        diff: {
          invalidate: async (input: { rootPath: string; path: string }) => {
            this.gitDiffInvalidations.push(input.path)
          },
        },
      },
    }
  }
}

/** An event source the test drives by hand. */
function fakeSource() {
  let listener: ((payload: WorkspaceChanged) => void) | null = null
  return {
    subscribe: (next: (payload: WorkspaceChanged) => void) => {
      listener = next
      return () => {
        listener = null
      }
    },
    emit: (payload: WorkspaceChanged) => listener?.(payload),
    get isSubscribed() {
      return listener !== null
    },
  }
}

/**
 * A coalescer whose window never elapses on its own, so a burst is exactly what the test fed it.
 * The timer is captured rather than fired, which is what makes "3 events in 100ms" deterministic.
 */
function queuedTime() {
  const pending = new Set<() => void>()
  return {
    schedule: ((fn: () => void) => {
      pending.add(fn)
      return fn as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    cancel: ((handle: unknown) => {
      pending.delete(handle as () => void)
    }) as unknown as typeof clearTimeout,
    /** Fire every pending timer, as the event loop would once the window closed. */
    advance: () => {
      const fns = [...pending]
      pending.clear()
      for (const fn of fns) fn()
    },
    get pendingCount() {
      return pending.size
    },
  }
}

// ---------------------------------------------------------------- coalescing

function oneBurstInvalidatesOnce() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // One agent turn: three writes inside the window, as the report describes.
  coalescer.handle({ kind: 'written', path: '/w/a.py' })
  coalescer.handle({ kind: 'written', path: '/w/b.py' })
  coalescer.handle({ kind: 'written', path: '/w/c.py' })

  // Nothing has fired yet — the burst is still open, and exactly one timer is pending.
  assert.equal(cache.listingInvalidations, 0, 'the burst must not flush before its window closes')
  assert.equal(clock.pendingCount, 1, 'the three events must share one timer')

  clock.advance()

  assert.equal(cache.listingInvalidations, 1, 'three events within the window must invalidate listings once')
  assert.equal(clock.pendingCount, 0, 'the burst must be closed after flushing')

  results.push('three events inside one window produce a single listing invalidation')
}

function eachWrittenPathIsInvalidatedOnce() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  cache.openFile = '/w/b.py'
  coalescer.handle({ kind: 'written', path: '/w/a.py' })
  coalescer.handle({ kind: 'written', path: '/w/b.py' })
  // The same file twice in one burst is one refetch, not two.
  coalescer.handle({ kind: 'written', path: '/w/b.py' })
  clock.advance()

  assert.deepEqual(
    cache.fileInvalidations,
    ['/w/b.py'],
    'only the open file is refetched, and only once even if written twice'
  )
  results.push('the open file is refetched once; other writes are not refetched')
}

function aWriteToAnotherFileDoesNotRefetchTheOpenOne() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  cache.openFile = '/w/mine.py'
  coalescer.handle({ kind: 'written', path: '/w/other.py' })
  clock.advance()

  assert.deepEqual(cache.fileInvalidations, [], 'an unrelated write must not refetch the open file')
  assert.equal(cache.listingInvalidations, 1, 'but the listing may still have changed')
  results.push('a write to another file does not refetch the open one')
}

function nothingOpenMeansNoFileInvalidation() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  cache.openFile = null
  coalescer.handle({ kind: 'written', path: '/w/a.py' })
  clock.advance()

  assert.deepEqual(cache.fileInvalidations, [], 'with nothing open there is nothing to refetch')
  results.push('with no file open, only the listings are invalidated')
}

function theOpenFileIsReadAtFlushTime() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // The file is written while nothing is open, then opened before the burst flushes. Reading the
  // open file at flush time is what makes the refetch happen; a captured value would have missed it.
  cache.openFile = null
  coalescer.handle({ kind: 'written', path: '/w/a.py' })
  cache.openFile = '/w/a.py'
  clock.advance()

  assert.deepEqual(cache.fileInvalidations, ['/w/a.py'], 'the open file must be read at flush time')
  results.push('the open file is decided at flush time, not when the event arrived')
}

// ---------------------------------------------------------------- command exits

function aCommandExitInvalidatesListings() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // No path: a command can create anything, so the listings are the only thing to invalidate.
  coalescer.handle({ kind: 'command-exited' })
  clock.advance()

  assert.equal(cache.listingInvalidations, 1)
  assert.deepEqual(cache.fileInvalidations, [])
  results.push('a command exit invalidates the listings without a file refetch')
}

// ---------------------------------------------------------------- git

function oneBurstRefetchesGitOnce() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // The whole point of doing this inside the coalescer rather than at each call site: a turn that
  // writes several files must produce one status call, not one per file.
  coalescer.handle({ kind: 'written', path: '/w/a.py' })
  coalescer.handle({ kind: 'written', path: '/w/b.py' })
  coalescer.handle({ kind: 'command-exited' })
  assert.deepEqual(cache.gitStatusInvalidations, [], 'git must not be asked before the burst closes')

  clock.advance()

  assert.deepEqual(cache.gitStatusInvalidations, ['/w'], 'one burst, one status read, for the open root')
  results.push('a burst refetches the git status once, for the open folder')
}

function withoutAFolderThereIsNoGitRead() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // No folder open: a null root would be answered "not a repository", which is a round trip to say
  // nothing. The root is read at flush time, so opening a folder mid-burst is still honoured.
  cache.rootPath = null
  coalescer.handle({ kind: 'command-exited' })
  clock.advance()

  assert.deepEqual(cache.gitStatusInvalidations, [], 'with no folder open git is not asked')
  assert.equal(cache.listingInvalidations, 1, 'while the listings still are')
  results.push('with no folder open, the git reads are skipped')
}

function aChangedOpenFileRefetchesItsDiff() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  cache.openFile = '/w/b.py'
  coalescer.handle({ kind: 'written', path: '/w/b.py' })
  clock.advance()

  // The file on screen changed, so its diff is stale as well as its contents.
  assert.deepEqual(cache.gitDiffInvalidations, ['/w/b.py'], 'the open file\u2019s diff is refetched')
  results.push('a write to the open file refetches its diff as well as its contents')
}

function separateBurstsInvalidateSeparately() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  coalescer.handle({ kind: 'command-exited' })
  clock.advance()
  coalescer.handle({ kind: 'written', path: '/w/a.py' })
  clock.advance()

  // Two turns, two bursts: coalescing must not swallow a later change.
  assert.equal(cache.listingInvalidations, 2, 'a new burst after a flush must invalidate again')
  results.push('a burst after a flush invalidates again')
}

function aBurstDoesNotExtendForever() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const coalescer = createChangeCoalescer(cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // A long stream of writes: the window opens with the first event and does not move, so the burst
  // is bounded rather than postponed until the writes stop.
  for (let i = 0; i < 50; i += 1) coalescer.handle({ kind: 'written', path: `/w/${i}.py` })
  assert.equal(clock.pendingCount, 1, 'later events must join the open burst, not restart it')

  clock.advance()
  assert.equal(cache.listingInvalidations, 1)
  results.push('a long stream of writes is still one bounded burst')
}

// ---------------------------------------------------------------- subscription

function theSourceIsSubscribedAndUnsubscribed() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const source = fakeSource()

  const stop = subscribeToWorkspaceChanges(source.subscribe, cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  assert.equal(source.isSubscribed, true, 'subscribing must reach the source')

  source.emit({ kind: 'written', path: '/w/a.py' })
  clock.advance()
  assert.equal(cache.listingInvalidations, 1, 'an event must invalidate')

  stop()
  assert.equal(source.isSubscribed, false, 'unsubscribing must reach the source')

  // A late event after unsubscribe must not invalidate.
  source.emit({ kind: 'command-exited' })
  clock.advance()
  assert.equal(cache.listingInvalidations, 1, 'nothing happens after unsubscribe')
  results.push('the source is subscribed on mount and released on unmount')
}

function unmountFlushesAPendingBurst() {
  const cache = new FakeCache()
  const clock = queuedTime()
  const source = fakeSource()

  const stop = subscribeToWorkspaceChanges(source.subscribe, cache.handlers(), {
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  // A change arrives, then the panel goes away before the window closes. The cache outlives the
  // component, so the pending change must still be applied.
  source.emit({ kind: 'written', path: '/w/a.py' })
  stop()

  assert.equal(cache.listingInvalidations, 1, 'a burst pending at unmount must still be applied')
  assert.equal(clock.pendingCount, 0, 'and its timer must not be left behind')
  results.push('a burst pending at unmount is flushed, not dropped')
}

function theWindowIsTheDocumentedLength() {
  assert.equal(COALESCE_MS, 150, 'the burst window is the documented 150ms')
  results.push('the coalescing window is 150ms')
}

function main() {
  step('burst coalescing', oneBurstInvalidatesOnce)
  step('per-path invalidation', eachWrittenPathIsInvalidatedOnce)
  step('unrelated write', aWriteToAnotherFileDoesNotRefetchTheOpenOne)
  step('nothing open', nothingOpenMeansNoFileInvalidation)
  step('flush-time open file', theOpenFileIsReadAtFlushTime)
  step('command exit', aCommandExitInvalidatesListings)
  step('git: one read per burst', oneBurstRefetchesGitOnce)
  step('git: no folder', withoutAFolderThereIsNoGitRead)
  step('git: open file', aChangedOpenFileRefetchesItsDiff)
  step('separate bursts', separateBurstsInvalidateSeparately)
  step('bounded burst', aBurstDoesNotExtendForever)
  step('subscription lifecycle', theSourceIsSubscribedAndUnsubscribed)
  step('unmount flush', unmountFlushesAPendingBurst)
  step('window length', theWindowIsTheDocumentedLength)

  console.log(`workspace change invalidation: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
