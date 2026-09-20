import type { WorkspaceChanged } from '@/conveyor/events'

/**
 * Keeping the explorer and the open file honest when main changes something on disk.
 *
 * Directory listings and file contents are cached per path, and every mutation now happens in main
 * — an agent's `write_file`, a shell command — so the renderer has no mutation of its own to
 * invalidate from. Main pushes `workspace.onChanged` instead, and this turns those pushes into
 * invalidations.
 *
 * The coalescing is the part worth reading. One agent turn can write several files and run several
 * commands, each raising its own event; invalidating per event would fire a refetch per file and
 * thrash the tree. Events are therefore collected into a burst, and one flush invalidates the
 * listings once and each written path once.
 *
 * Deliberately free of React and of the conveyor client, so the logic can be exercised directly —
 * the client is created at import time and needs a `window`, so importing it here would make this
 * untestable. `use-workspace-changes.ts` is the React binding.
 */

/** How long a burst may keep growing. Long enough to span one turn, short enough to feel immediate. */
export const COALESCE_MS = 150

/** What a burst does when it flushes. */
export interface ChangeHandlers {
  /** Called at most once per burst: every listing is stale now. */
  invalidateListings: () => void
  /**
   * Called at most once per burst: whatever changed may have changed git's reading of it too.
   *
   * A write alters a file's status, a command can stage or commit, and the changes panel is showing
   * both — so its reads are refetched on the same burst that refetches the tree, rather than waiting
   * for the user to press refresh in a panel they are already looking at. Coalesced with everything
   * else, because a turn that writes six files must not run six status calls.
   */
  invalidateGit: () => void
  /** Called once per burst, with the distinct paths written during it. */
  onWrites: (paths: readonly string[]) => void
}

export interface ChangeCoalescer {
  /** Feed one event. */
  handle: (payload: WorkspaceChanged) => void
  /** Flush now, without waiting for the window to close. */
  flush: () => void
  /** Drop a pending burst and stop its timer. */
  dispose: () => void
}

/**
 * Collect change events into bursts, and hand each burst to `handlers` exactly once.
 *
 * The clock is injected so a burst can be driven from a test rather than waited on.
 */
export function createChangeCoalescer(
  handlers: ChangeHandlers,
  options: { delayMs?: number; schedule?: typeof setTimeout; cancel?: typeof clearTimeout } = {}
): ChangeCoalescer {
  const delayMs = options.delayMs ?? COALESCE_MS
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout

  // A burst's state. `timer` doubles as the "a burst is open" flag, which is what stops a burst
  // being flushed twice.
  let timer: ReturnType<typeof setTimeout> | null = null
  const written = new Set<string>()

  const flush = () => {
    if (timer === null) return
    cancel(timer)
    timer = null

    const paths = [...written]
    written.clear()

    // Runs even when no path was written: a command exiting means the listings may have moved.
    handlers.invalidateListings()
    handlers.invalidateGit()
    if (paths.length > 0) handlers.onWrites(paths)
  }

  return {
    handle(payload) {
      if (payload.kind === 'written' && payload.path) written.add(payload.path)
      // The first event of a burst opens the window; later ones join it rather than extending it,
      // so a long stream of writes cannot postpone the flush indefinitely.
      if (timer === null) timer = schedule(flush, delayMs)
    },
    flush,
    dispose() {
      if (timer !== null) cancel(timer)
      timer = null
      written.clear()
    },
  }
}

/**
 * Subscribe to workspace changes and hand each burst to `handlers`.
 *
 * `subscribe` is a parameter rather than a direct call to conveyor, so the wiring can be exercised
 * with a fake source. Returns the unsubscribe function.
 */
export function subscribeToWorkspaceChanges(
  subscribe: (listener: (payload: WorkspaceChanged) => void) => () => void,
  handlers: ChangeHandlers,
  options: { delayMs?: number; schedule?: typeof setTimeout; cancel?: typeof clearTimeout } = {}
): () => void {
  const coalescer = createChangeCoalescer(handlers, options)
  const unsubscribe = subscribe((payload) => coalescer.handle(payload))

  return () => {
    // Flush before dropping: a burst that arrived just before unmount is still a real change, and
    // the caches outlive this component.
    coalescer.flush()
    coalescer.dispose()
    unsubscribe()
  }
}

/** The conveyor surface the handlers need — narrowed, so a fake can stand in for it in a test. */
export interface WorkspaceChangeClient {
  workspace: {
    listDirectory: { invalidate: () => Promise<void> }
    readFile: { invalidate: (input: { path: string }) => Promise<void> }
  }
  git: {
    status: { invalidate: (input: { rootPath: string }) => Promise<void> }
    branch: { invalidate: (input: { rootPath: string }) => Promise<void> }
    log: { invalidate: (input: { rootPath: string }) => Promise<void> }
    diff: { invalidate: (input: { rootPath: string; path: string }) => Promise<void> }
  }
}

/**
 * Build the handlers that turn a burst of changes into invalidations.
 *
 * `getOpenFile` is a getter rather than a value: the subscription outlives any single render, so
 * reading the open file at flush time keeps the handler correct without it being re-created — and
 * therefore without the event channel being re-subscribed — on every render. `getRootPath` is a getter
 * for the same reason, and the git reads need it because they take the workspace root as an input.
 *
 * `editor` is how the handler reaches the open buffer's dirty flag, which lives in a React store it
 * cannot read directly. It is asked *at flush time* for the same reason the open file is: the user may
 * have started typing between the event arriving and the burst closing, and it is the state when the
 * refetch happens that decides whether a banner is warranted.
 */
export function createWorkspaceChangeHandlers(
  client: WorkspaceChangeClient,
  getOpenFile: () => string | null,
  getRootPath: () => string | null,
  editor?: {
    /** Whether the open buffer holds unsaved edits. */
    isDirty: (path: string) => boolean
    /** Report that the open path changed from outside, so the viewer can weigh it against the buffer. */
    noteExternalChange: (path: string) => void
  }
): ChangeHandlers {
  return {
    invalidateListings: () => {
      // Bare: every cached listing, so expanded folders refetch now and collapsed ones refetch on
      // their next expansion.
      void client.workspace.listDirectory.invalidate()
    },
    invalidateGit: () => {
      const rootPath = getRootPath()
      // With no folder open there is nothing to ask about, and a null root would be a query main
      // answers with "not a repository" — a wasted round trip to say nothing.
      if (!rootPath) return

      // The three reads a change can move: a write alters a status, and a command can also commit or
      // switch a branch. The log travels with them because a commit made from the terminal would
      // otherwise leave the panel's recent list stale until it was manually refreshed.
      void client.git.status.invalidate({ rootPath })
      void client.git.branch.invalidate({ rootPath })
      void client.git.log.invalidate({ rootPath })
    },
    onWrites: (paths) => {
      // Only the file on screen: editing a file nobody is looking at does not need a refetch, and
      // its next open would read through the invalidated entry anyway.
      const open = getOpenFile()
      if (open && paths.includes(open)) {
        // The branch that matters. A clean buffer is refetched and the new content adopted, which is
        // what happened before the viewer could edit anything. A dirty buffer must not be silently
        // replaced under the user's hands, so the change is reported and the viewer weighs the fresh
        // bytes against the unsaved ones before deciding whether to say anything.
        //
        // The refetch happens either way, and deliberately: it is the arriving content that tells the
        // two apart. A write of the bytes we already had — a touch, or our own save racing its event —
        // is not a conflict, and a flag saying "an external write happened" could not tell the user
        // that. `decideConflict` can.
        if (editor?.isDirty(open)) editor.noteExternalChange(open)

        void client.workspace.readFile.invalidate({ path: open })
        // A file that changed may now differ from the index, so the diff on screen is stale too.
        const rootPath = getRootPath()
        if (rootPath) void client.git.diff.invalidate({ rootPath, path: open })
      }
    },
  }
}
