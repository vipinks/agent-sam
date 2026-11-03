import { useEffect, useState } from 'react'
import { Brain } from 'lucide-react'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import { MEMORY_PAGES, type MemoryPageId } from '@/conveyor/protocol/memory'
import { memoryStore } from '@/conveyor/stores/memory'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ScrollArea } from '../ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Textarea } from '../ui/textarea'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { PaneHeader } from './pane-header'
import { PanelCollapseControl, PanelExpandControl } from './right-rail'

/**
 * Memory: the right rail's fifth resident, and the panel its dock holds.
 *
 * The panel is the quick surface for the project's four standing notes — read them, edit them, search
 * them, and bring a pasted handoff in. The list of pages is the store's (durable view state, mirrored
 * from main), while which page is open, the search term and the edit buffer are the panel's own
 * `useState` — they live and die with the dock, exactly like the Tools panel's narrowing.
 *
 * Every read and write goes through `conveyor.memory.*`: the renderer holds no path, no fs, and no
 * notion of where the notes live. Writing an existing page supersedes it (the prior revision is kept),
 * and Restore reverts to that prior revision — which is why Restore asks before it acts.
 */

const PAGE_TITLES: Record<MemoryPageId, string> = {
  handoff: 'Handoff',
  decisions: 'Decisions',
  parked: 'Parked',
  quirks: 'Quirks',
}

/** The sentence a failure is worded as, branched on the code rather than on the message. */
function failureSentence(error: unknown): string {
  if (error instanceof ConveyorError && error.code === 'MEMORY_NOT_FOUND') return 'Nothing to restore yet.'
  if (error instanceof ConveyorError && error.code === 'MEMORY_CONFLICT') return 'Some sections already exist.'
  if (error instanceof ConveyorError && error.code === 'MEMORY_IMPORT_FAILED')
    return 'The pasted handoff had no sections.'
  return 'The memory could not be written. Nothing was changed.'
}

export function MemoryPanel() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const storedPages = useConveyorStore(memoryStore, (s) => s.pages)

  const [page, setPage] = useState<MemoryPageId>('handoff')
  const [buffer, setBuffer] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // The listPages read refreshes the store's mirror of the disk whenever the panel mounts or the folder
  // changes; the durable view it refreshes is what the tab row renders.
  const list = conveyor.memory.listPages.useQuery({
    input: { rootPath: rootPath ?? '' },
    enabled: rootPath !== null,
    retry: false,
  })
  const pages = list.data ?? storedPages

  const searching = searchTerm.trim().length >= 2
  const read = conveyor.memory.readPage.useQuery({
    input: { rootPath: rootPath ?? '', page },
    enabled: rootPath !== null && !searching,
    retry: false,
  })
  const search = conveyor.memory.search.useQuery({
    input: { rootPath: rootPath ?? '', term: searchTerm.trim() },
    enabled: rootPath !== null && searching,
    retry: false,
  })
  const write = conveyor.memory.writePage.useMutation()
  const restore = conveyor.memory.restorePage.useMutation()
  const importHandoff = conveyor.memory.importHandoff.useMutation()

  // The buffer tracks the page on screen, so an edit is not lost to a re-read of the same page.
  useEffect(() => {
    setBuffer(read.data?.content ?? '')
  }, [read.data?.content])

  const summary = pages.find((p) => p.page === page)

  async function save(): Promise<void> {
    if (!rootPath) return
    try {
      await write.mutateAsync({ rootPath, page, content: buffer })
      setNotice('Saved.')
      await read.refetch()
    } catch (error) {
      setNotice(failureSentence(error))
    }
  }

  async function doRestore(): Promise<void> {
    if (!rootPath) return
    try {
      await restore.mutateAsync({ rootPath, page })
      setConfirmRestore(false)
      setNotice('Restored the previous revision.')
      await read.refetch()
    } catch (error) {
      setConfirmRestore(false)
      setNotice(failureSentence(error))
    }
  }

  async function submitImport(force: boolean): Promise<void> {
    if (!rootPath) return
    try {
      await importHandoff.mutateAsync({ rootPath, markdown: importText, ...(force ? { force: true } : {}) })
      setImportOpen(false)
      setConflictOpen(false)
      setImportText('')
      setNotice('Imported.')
      await list.refetch()
    } catch (error) {
      if (error instanceof ConveyorError && error.code === 'MEMORY_CONFLICT') {
        setConflictOpen(true)
        return
      }
      setNotice(failureSentence(error))
    }
  }

  return (
    <div data-slot="memory-panel" className="flex h-full flex-col bg-background">
      <PaneHeader icon={Brain} title="Memory">
        <PanelExpandControl />
        <PanelCollapseControl />
      </PaneHeader>

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Input
          aria-label="Search memory"
          data-slot="memory-search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search memory"
          className="h-7 min-w-0 flex-1 text-[12.5px]"
        />
        <Button type="button" variant="outline" data-slot="memory-import" onClick={() => setImportOpen(true)}>
          Import
        </Button>
      </div>

      {searching ? (
        <ScrollArea className="min-h-0 flex-1">
          <div data-slot="memory-results" className="flex flex-col gap-2 p-3">
            {search.data?.length === 0 && (
              <p data-slot="memory-search-empty" className="px-1 py-2 text-[12.5px] text-muted-foreground">
                No page matches “{searchTerm.trim()}”.
              </p>
            )}
            {search.data?.map((result) => (
              <div
                key={result.page}
                data-slot="memory-result"
                className="rounded-md border border-border bg-card px-2.5 py-2"
              >
                <p className="text-[12.5px] font-medium leading-tight">{PAGE_TITLES[result.page]}</p>
                {result.snippets.map((snippet, index) => (
                  <p key={index} className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {snippet}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : (
        <Tabs
          value={page}
          onValueChange={(value) => setPage(value as MemoryPageId)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="shrink-0 border-b border-border px-3 py-2">
            <TabsList data-slot="memory-tabs">
              {MEMORY_PAGES.map((id) => (
                <TabsTrigger key={id} value={id} data-slot={`memory-tab-${id}`}>
                  {PAGE_TITLES[id]}
                  {summary && id === page && summary.revisions > 0 && (
                    <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[10px] font-normal tabular-nums">
                      {summary.revisions}
                    </Badge>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-3">
              <Textarea
                aria-label={`${PAGE_TITLES[page]} content`}
                data-slot="memory-editor"
                value={buffer}
                onChange={(event) => setBuffer(event.target.value)}
                placeholder={read.isPending ? 'Reading…' : 'Nothing written yet.'}
                className="min-h-48 text-[12.5px] leading-relaxed"
              />
              <div className="flex items-center gap-2">
                <Button type="button" data-slot="memory-save" onClick={() => void save()}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  data-slot="memory-restore"
                  disabled={(summary?.revisions ?? 0) === 0}
                  onClick={() => setConfirmRestore(true)}
                >
                  Restore
                </Button>
                {notice && (
                  <span data-slot="memory-notice" className="text-[11.5px] text-muted-foreground">
                    {notice}
                  </span>
                )}
              </div>
            </div>
          </ScrollArea>
        </Tabs>
      )}

      {/*
       * The import dialog: a Textarea rather than a file picker, because a handoff is pasted, not chosen.
       */}
      <AlertDialog open={importOpen} onOpenChange={setImportOpen}>
        <AlertDialogContent data-slot="memory-import-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Import a handoff</AlertDialogTitle>
            <AlertDialogDescription>
              Paste the handoff markdown. Each section lands on its page; a section that already exists is never
              overwritten silently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="Handoff markdown"
            data-slot="memory-import-text"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder="# Handoff …"
            className="min-h-40 text-[12.5px] leading-relaxed"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" onClick={() => void submitImport(false)}>
              Import
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
       * The conflict choice: an existing section is never silently overwritten, so the import asks here
       * whether to supersede (keeping the prior revision) or leave it alone.
       */}
      <AlertDialog open={conflictOpen} onOpenChange={setConflictOpen}>
        <AlertDialogContent data-slot="memory-conflict-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Some sections already exist</AlertDialogTitle>
            <AlertDialogDescription>
              Overwriting supersedes them — the current text becomes the prior revision, and Restore brings it back.
              Choose whether to supersede or leave them alone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" onClick={() => void submitImport(true)}>
              Supersede
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
       * The restore confirm: reverting is an undo of a write, so it asks before it acts — and Restore is
       * the only way back, which is why the button is disabled when there is nothing to revert to.
       */}
      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent data-slot="memory-restore-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore the previous revision?</AlertDialogTitle>
            <AlertDialogDescription>
              The current text of {PAGE_TITLES[page]} is replaced by the revision before it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={() => void doRestore()}>
              Restore
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
