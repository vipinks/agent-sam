/**
 * The narrowing one panel tab keeps: what was typed, which status, and which page.
 *
 * Lifted out of the tabs and held by the panel that owns the tab row, because a tab that is not showing is
 * not in the document — Radix mounts one content pane at a time — so state held inside a pane would be state
 * a reader loses by looking at the other tab. Held here, each tab's own narrowing survives the switch, and
 * the two tabs cannot share or overwrite each other's.
 *
 * `Status` is a parameter rather than a union of the two panels' values because the two tabs filter by
 * different things — a skill is available, hidden or a load error; a server is running, stopped, disabled or
 * needs trust — and what they share is the *shape* of that choice, not its values. The list of values is
 * handed in so the hook can narrow a control's report without knowing which control it was, and so the
 * status a list starts on is the first value that list states rather than a second opinion about it.
 */
import { useState } from 'react'

/** What one tab keeps, and the three ways a reader narrows it. */
export interface PanelNarrowing<Status extends string> {
  /** What is in the search box. */
  query: string
  /** Which status the filter is holding. */
  status: Status
  /** Which page is showing, 1-based and unclamped: the view is what clamps it into range. */
  page: number
  /** Typing starts the list again at the top: a page chosen under one query means nothing under the next. */
  setQuery: (next: string) => void
  /** The same for the status, and for the same reason. */
  setStatus: (next: Status) => void
  /** What the status control reported, narrowed back to the values the list states. */
  setStatusValue: (value: string) => void
  /** The pager's own two moves. */
  setPage: (next: number) => void
}

/**
 * One tab's narrowing, over the values its status list holds.
 *
 * A non-empty tuple rather than an array, so "the list starts on its first value" is a fact the type
 * carries: every list these are asked with is a `const` table, and the first entry is the ordinary one to
 * start on — `all`, in both panels.
 */
export function usePanelNarrowing<Status extends string>(
  values: readonly [Status, ...Status[]]
): PanelNarrowing<Status> {
  const [query, setQueryState] = useState('')
  const [status, setStatusState] = useState<Status>(values[0])
  const [page, setPage] = useState(1)

  function setQuery(next: string): void {
    setQueryState(next)
    setPage(1)
  }

  function selectStatus(next: Status): void {
    setStatusState(next)
    setPage(1)
  }

  return {
    query,
    status,
    page,
    setQuery,
    setStatus: selectStatus,
    // A value the control reported that this list does not know is dropped rather than trusted. Which rows
    // a status keeps is the protocol layer's rule, and asking it for a status it has no case for would
    // quietly keep nothing at all — an empty list that looks like an empty project.
    setStatusValue: (value) => selectStatus(values.find((candidate) => candidate === value) ?? values[0]),
    setPage,
  }
}
