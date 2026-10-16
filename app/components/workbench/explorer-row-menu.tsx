import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ConveyorError } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { PATH_GONE, ROOT_UNREMOVABLE } from '@/conveyor/protocol/path-actions'
import { documentHandoffKind } from '@/conveyor/protocol/preview-kind'
import { Separator } from '../ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'

/**
 * The explorer row's own menu: what a row can be asked to do without a second control beside it.
 *
 * Opened at the pointer rather than anchored to the row, because a tree is a stack of rows of the same
 * width — an anchored menu would draw in the same place for every row and say nothing about which one
 * was clicked.
 *
 * The items are grouped by what they do to the row: the removal, then the view act, then the app's
 * existing hand-off. That third group is the one the trace had to *find* rather than invent — a
 * file or folder row has exactly one other action in this app, `workspace.openDocument`, the document
 * hand-off the viewers already dispatch — and it is offered only for the names that command accepts,
 * because an item whose only possible answer is a refusal is worse than no item at all.
 *
 * Nothing here is a new capability: every item reaches a command the app already had, with the two
 * exceptions the trace found missing entirely — the removal and the OS file-manager hand-off, which had
 * no boundary in the app at all. The open folder itself is not a row — it heads the tree as a path line,
 * so it cannot be right-clicked at all — and the removal refuses it anyway, for a caller that names it.
 */
export interface RowMenuRequest {
  /** The row's absolute path, which every act is dispatched with. */
  path: string
  /** The row's own name, for the question's title. */
  name: string
  /** Whether the row is a folder: it changes the question's wording, and what may be offered. */
  isDirectory: boolean
  /** Where the pointer was, in viewport pixels. */
  x: number
  y: number
}

/** How much room the menu leaves between itself and the window's edge. */
const EDGE_MARGIN = 8

/**
 * The wording for a refusal, chosen by main's code.
 *
 * Branched on the code and not on the sentence: main's wording is written for whoever reads the log, and
 * a reworded refusal must not become a new state here.
 */
export function rowRefusalMessage(code: string): string {
  if (code === PATH_GONE) return 'That row is no longer there, so nothing was done. The folder has been read again.'
  if (code === ROOT_UNREMOVABLE) return 'The open folder cannot be removed from its own tree.'
  return 'That could not be done.'
}

export function ExplorerRowMenu({
  request,
  rootPath,
  onDone,
  onRefused,
}: {
  request: RowMenuRequest
  /** The open folder, which the removal is resolved against. */
  rootPath: string
  /** The menu is finished: put it away and leave nothing behind. */
  onDone: () => void
  /** Main refused the act, under this code — the pane says so and reads the folder again. */
  onRefused: (code: string) => void
}) {
  const popup = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: request.x, top: request.y })
  const [confirming, setConfirming] = useState(false)

  const removePath = conveyor.workspace.deletePath.useMutation()
  const revealPath = conveyor.workspace.revealPath.useMutation()
  const openDocument = conveyor.workspace.openDocument.useMutation()

  /**
   * Where the menu lands: the pointer, pulled back inside the window once its own size is known.
   *
   * Measured rather than guessed, because the height follows how many groups this row turned out to
   * have — a row at the bottom of a tall tree would otherwise open its menu off the bottom of the
   * screen, where the items beyond the fold are exactly the ones that cannot be clicked.
   */
  useLayoutEffect(() => {
    const node = popup.current
    if (node === null) return

    const { width, height } = node.getBoundingClientRect()
    setAt({
      left: Math.max(EDGE_MARGIN, Math.min(request.x, window.innerWidth - width - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(request.y, window.innerHeight - height - EDGE_MARGIN)),
    })
  }, [request.x, request.y])

  /**
   * Dismissed by an outside click or Escape, the way the session row's own menus are.
   *
   * Suspended while the question is up, and that is not a nicety: the dialog is Radix's, it already owns
   * both gestures, and a second listener closing the whole menu underneath it would dismiss the question
   * through a door of its own.
   */
  useEffect(() => {
    if (confirming) return

    const onDown = (event: MouseEvent) => {
      if (popup.current !== null && !popup.current.contains(event.target as Node)) onDone()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [confirming, onDone])

  /**
   * Run one act, then let the menu go.
   *
   * The menu closes either way: it was a question about what to do, and the answer has been given. A
   * refusal arrives as the code it was refused under, which is what the wording is chosen from.
   */
  const run = async (act: () => Promise<unknown>) => {
    onDone()
    try {
      await act()
    } catch (error) {
      if (error instanceof ConveyorError) onRefused(error.code)
    }
  }

  /** The removal, once its question has been answered: the menu is already gone, the dialog closes now. */
  const remove = async () => {
    setConfirming(false)
    await run(() => removePath.mutateAsync({ path: request.path, rootPath }))
  }

  // The groups, in the order the menu draws them, with a rule between each pair. The hand-off is
  // offered only where it can be taken — a pdf, a docx or a doc, and never a folder — and the rule
  // for that is `documentHandoffKind`, the same one main's command refuses under.
  const groups: Array<Array<{ label: string; run: () => void }>> = [
    [{ label: 'Delete', run: () => setConfirming(true) }],
    [{ label: 'Show in folder', run: () => void run(() => revealPath.mutateAsync({ path: request.path })) }],
  ]
  if (!request.isDirectory && documentHandoffKind(request.path) !== null) {
    groups.push([
      { label: 'Open in default app', run: () => void run(() => openDocument.mutateAsync({ path: request.path })) },
    ])
  }

  return (
    <>
      {!confirming && (
        <div
          ref={popup}
          role="menu"
          aria-label="File actions"
          className="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 shadow-lg"
          style={{ left: at.left, top: at.top }}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0].label}>
              {/* Named as a separator rather than left decorative: inside this menu it is what tells the
                  removal apart from the two view acts. */}
              {index > 0 && <Separator decorative={false} className="my-1" />}
              {group.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={item.run}
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                >
                  {item.label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}

      {/* The removal asks first, and asks about the path rather than about the click: the path is what
          goes, and the cost is stated rather than left to be read off the confirm button. */}
      <AlertDialog open={confirming} onOpenChange={(open) => !open && onDone()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Delete ${request.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`${request.path} will be removed from disk${
                request.isDirectory ? ', with everything inside it' : ''
              }. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
