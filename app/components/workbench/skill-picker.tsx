/**
 * The Skills control: what the composer offers beside the approval chip, and what a conversation shows
 * it is working from.
 *
 * A popover of two scopes and a row of chips, built from the primitives this app already has — Badge,
 * Button and Popover — because there is nothing here that needs a new one. The rows are toggle buttons
 * (`aria-pressed`) rather than a new checkbox: a skill is on or off for one conversation, and that is
 * what a toggle button states.
 *
 * The picker reports and asks; it decides nothing. What is active, how many are allowed, and what a
 * toggle does to the record are the rules' answers, held one level up in the sessions layer, and the
 * component is handed the outcome so that the disabled state and the store can never disagree.
 *
 * The filter box is what makes the control usable over a large library. It narrows against the id, the
 * title and the summary through `filterSkillSummaries`, so a rule rather than a rendering decides what
 * matches; and it narrows the *list*, which is what the rows are drawn from — a hidden row is not
 * clickable, so a filtered-out skill cannot be activated from behind a query.
 *
 * The list is bounded rather than the popover. Radix's collision avoidance is on and left alone: it can
 * move content that does not fit the window, but it cannot make it fit, and a library of hundreds of
 * skills drew a popover taller than the screen that then hung off the top of it with its own controls.
 * So the rows scroll inside a viewport-relative region, and the filter box and the cap copy sit outside
 * it — one above, one below — where no scroll can carry them off screen. Nothing is virtualized or
 * paged: the region is what makes the whole library reachable.
 *
 * Load errors are drawn beside the skills that did load, in their own group, with the code the module
 * named: a folder that could not be read is worth knowing about, and it is not a reason to hide the
 * rest of the list or to take the control away.
 */
import { BookOpen, Check, Search, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  filterSkillSummaries,
  MAX_ACTIVE_SKILLS,
  skillLimitReached,
  type SkillLoadError,
  type SkillSummary,
} from '@/conveyor/protocol/skills'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** One skill the composer knows the name of, for the chip row. */
export interface SkillChip {
  id: string
  title: string
}

/**
 * The active skills, as chips that can be taken off again.
 *
 * Rendered above the composer rather than inside the picker, because what a conversation runs with is a
 * fact about the message being written, not a detail behind a button. The id is the chip's tooltip: a
 * title is what the user reads, and the id is what the session actually stores.
 */
export function SkillChipRow({
  skills,
  disabled,
  onRemove,
  className,
}: {
  skills: readonly SkillChip[]
  disabled: boolean
  onRemove: (id: string) => void
  /** Placement only — the composer decides where the row sits, this decides how it looks. */
  className?: string
}) {
  if (skills.length === 0) return null

  return (
    <div className={cn('flex flex-wrap gap-1', className)} aria-label="Active skills">
      {skills.map((skill) => (
        <Badge key={skill.id} variant="secondary" className="max-w-56 min-w-0 gap-1 pr-0.5 pl-1.5" title={skill.id}>
          <BookOpen className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate font-normal">{skill.title}</span>
          <button
            type="button"
            aria-label={`Remove skill ${skill.id}`}
            disabled={disabled}
            onClick={() => onRemove(skill.id)}
            className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}
    </div>
  )
}

/**
 * One toggleable skill row.
 *
 * Disabled for two different reasons, worded apart: the control as a whole is unavailable while a run
 * or a decision is in flight, and a skill that is not on cannot be turned on while the conversation is
 * already at the cap. The second is offered as a state rather than a refusal, so the user sees why the
 * row will not move instead of clicking a row that does nothing.
 *
 * `highlighted` is where the arrow keys are standing, which is not what `active` means: a skill is active
 * for the conversation, and the highlight is only this moment's keyboard position. It is carried as
 * `data-active` — the composer's own marker for that row, the one the mention picker already uses — so
 * the scroll request can find it without a second kind of reference.
 */
function SkillRow({
  skill,
  active,
  highlighted,
  disabled,
  onToggle,
}: {
  skill: SkillSummary
  active: boolean
  highlighted: boolean
  disabled: boolean
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-slot="skill-picker-row"
      data-active={highlighted ? 'true' : undefined}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onToggle(skill.id)}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50',
        highlighted && 'bg-accent'
      )}
    >
      <Check className={cn('mt-0.5 size-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-foreground">{skill.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{skill.summary || skill.id}</span>
      </span>
    </button>
  )
}

/** A scope's row heading, and the note that stands in for its skills when it has none. */
function SkillGroup({
  label,
  emptyNote,
  skills,
  activeSkillIds,
  highlightedId,
  disabled,
  onToggle,
}: {
  label: string
  emptyNote: string
  skills: readonly SkillSummary[]
  activeSkillIds: readonly string[]
  /** The row the arrow keys are on, which may be in either scope's group. */
  highlightedId: string | null
  disabled: boolean
  onToggle: (id: string) => void
}) {
  const atCap = skillLimitReached(activeSkillIds)

  return (
    <div className="pt-1">
      <p className="px-2 py-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      {skills.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">{emptyNote}</p>
      ) : (
        skills.map((skill) => {
          const active = activeSkillIds.includes(skill.id)
          return (
            <SkillRow
              key={skill.id}
              skill={skill}
              active={active}
              highlighted={skill.id === highlightedId}
              disabled={disabled || (atCap && !active)}
              onToggle={onToggle}
            />
          )
        })
      )}
    </div>
  )
}

/**
 * The picker itself.
 *
 * Project and user skills are drawn as the two separate things they are, and the load errors after
 * them. Nothing here is destructive: a scope with nothing in it says so, a file that would not parse
 * gets a line of its own, and the skills that did load are still switchable.
 */
export function SkillPicker({
  project,
  user,
  errors,
  activeSkillIds,
  disabled,
  loading,
  onToggle,
}: {
  project: readonly SkillSummary[]
  user: readonly SkillSummary[]
  errors: readonly SkillLoadError[]
  activeSkillIds: readonly string[]
  disabled: boolean
  loading: boolean
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  // Which row the arrow keys are on, held by id rather than by position: the filter narrows the list
  // under the highlight, and a remembered position would then name whichever row moved into it.
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeCount = activeSkillIds.length

  // Derived rather than stored: the filter is a view of the listing, and a second copy of the rows in
  // state is a second thing that can go stale when main rescans the folders.
  const filtered = useMemo(
    () => ({
      project: filterSkillSummaries(project, filter),
      user: filterSkillSummaries(user, filter),
    }),
    [project, user, filter]
  )
  // What the rows would be if they were drawn, which is what the empty note is about.
  const shown = filtered.project.length + filtered.user.length
  const listingIsEmpty = project.length === 0 && user.length === 0 && errors.length === 0
  // The rows in the order they are drawn, which is the order the arrow keys walk them: project first,
  // then user, because that is the order the two groups appear in.
  const rowIds = useMemo(() => [...filtered.project, ...filtered.user].map((skill) => skill.id), [filtered])

  // Keep the highlighted row in view while the arrow keys walk a list longer than the region shows.
  // Guarded because jsdom has no `scrollIntoView`, and a test must not fail on a scroll it cannot do.
  useEffect(() => {
    const highlighted = scrollRef.current?.querySelector('[data-active="true"]')
    if (highlighted && typeof highlighted.scrollIntoView === 'function') {
      highlighted.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedId, rowIds])

  /**
   * The arrow keys walk the rows, and the ends wrap.
   *
   * Focus stays where the user put it — in the filter box, almost always — and what moves is the
   * highlight, so a keystroke that walks the list does not take the query being typed away from the user.
   * The wrap is the mention picker's rule, one list over in the same composer.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (rowIds.length === 0) return
    // Prevented because the popover is drawn into a portal on the body, where an arrow key nothing
    // handles would scroll the page behind the popover out from under it.
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const at = highlightedId === null ? -1 : rowIds.indexOf(highlightedId)
    const next = at === -1 ? (step === 1 ? 0 : rowIds.length - 1) : (at + step + rowIds.length) % rowIds.length
    setHighlightedId(rowIds[next])
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Cleared on the way out: the box is how the list is *narrowed now*, and reopening onto a stale
        // query would make a skill look missing until the user remembered they had typed something. The
        // highlight goes with it, so reopening lands on a list with nothing already chosen in it.
        if (!next) {
          setFilter('')
          setHighlightedId(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={activeCount > 0 ? `Skills, ${activeCount} active` : 'Skills'}
          className="h-7 gap-1.5 px-2 text-[11.5px] text-muted-foreground"
        >
          <BookOpen className="size-3.5" aria-hidden="true" />
          Skills
          {activeCount > 0 && <span className="text-foreground">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1" onKeyDown={onKeyDown}>
        <div className="relative px-1 pt-1 pb-1.5">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter skills"
            placeholder="Filter skills"
            className="h-7 pl-7 text-[12px]"
          />
        </div>

        {/*
          The rows in a region of their own, bounded by a share of the viewport rather than a pixel count
          so the bound holds on a short window too.

          Bounded here and not on the popover: the box above and the cap line below are the two things
          that have to stay put while a long list scrolls between them, and a bound on their common parent
          would have scrolled them along with the rows. The notes that stand in for rows are inside it, for
          the same reason the rows are: a listing with nothing in it, and a folder that would not parse,
          are as long as what they are made of.
        */}
        <div ref={scrollRef} data-slot="skill-picker-scroll" className="max-h-[45vh] overflow-y-auto">
          <SkillGroup
            label="Project"
            emptyNote="No skills in this project's .sam/skills folder."
            skills={filtered.project}
            activeSkillIds={activeSkillIds}
            highlightedId={highlightedId}
            disabled={disabled}
            onToggle={onToggle}
          />
          <SkillGroup
            label="User"
            emptyNote="No skills in your user skills folder."
            skills={filtered.user}
            activeSkillIds={activeSkillIds}
            highlightedId={highlightedId}
            disabled={disabled}
            onToggle={onToggle}
          />

          {/* Said once, in the middle, when nothing at all matches: two per-group notes for the same query
            would read as two separate misses. */}
          {filter.trim() !== '' && shown === 0 && (
            <p className="px-2 pb-1 text-[11px] text-muted-foreground">No skills match “{filter.trim()}”.</p>
          )}
          {(errors.length > 0 || loading) && (
            <div className="pt-1">
              <p className="px-2 py-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                {loading ? 'Reading' : 'Load errors'}
              </p>
              {loading ? (
                <p className="px-2 pb-1 text-[11px] text-muted-foreground">Reading the skill folders…</p>
              ) : (
                errors.map((error) => (
                  <div key={`${error.scope}:${error.id}`} className="flex items-start gap-2 px-2 py-1">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] text-foreground">{error.id || error.scope}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {error.message} ({error.code})
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          {!loading && listingIsEmpty && filter.trim() === '' && (
            <p className="px-2 pb-1 text-[11px] text-muted-foreground">
              No skills found. A skill is a folder with a SKILL.md in it, under .sam/skills in a project or the user
              skills folder.
            </p>
          )}
        </div>

        {/*
          The cap, below the region rather than above the box: it is the sentence that explains why a row
          will not move, so it has to be on screen at the moment the row is — and the border says which
          part of the popover is the list, now that the list can scroll under it.
        */}
        <p className="mt-1 border-t border-border px-2 pt-1.5 text-[11px] text-muted-foreground">
          Skills are guidance, not code.{' '}
          {skillLimitReached(activeSkillIds)
            ? `${activeCount} of ${MAX_ACTIVE_SKILLS} active — turn one off to add another.`
            : `Up to ${MAX_ACTIVE_SKILLS} can be active in one conversation.`}
        </p>
      </PopoverContent>
    </Popover>
  )
}
