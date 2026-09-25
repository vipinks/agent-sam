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
 * Load errors are drawn beside the skills that did load, in their own group, with the code the module
 * named: a folder that could not be read is worth knowing about, and it is not a reason to hide the
 * rest of the list or to take the control away.
 */
import { BookOpen, Check, Search, TriangleAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'
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
 */
function SkillRow({
  skill,
  active,
  disabled,
  onToggle,
}: {
  skill: SkillSummary
  active: boolean
  disabled: boolean
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-slot="skill-picker-row"
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onToggle(skill.id)}
      className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
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
  disabled,
  onToggle,
}: {
  label: string
  emptyNote: string
  skills: readonly SkillSummary[]
  activeSkillIds: readonly string[]
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

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Cleared on the way out: the box is how the list is *narrowed now*, and reopening onto a stale
        // query would make a skill look missing until the user remembered they had typed something.
        if (!next) setFilter('')
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
      <PopoverContent align="start" className="w-80 p-1">
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          {/*
            Skills are instructions rather than code, and the cap is stated where the switches are
            rather than only when one is refused: a row that will not move needs a reason on screen.
          */}
          Skills are guidance, not code.{' '}
          {skillLimitReached(activeSkillIds)
            ? `${activeCount} of ${MAX_ACTIVE_SKILLS} active — turn one off to add another.`
            : `Up to ${MAX_ACTIVE_SKILLS} can be active in one conversation.`}
        </p>

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

        <SkillGroup
          label="Project"
          emptyNote="No skills in this project's .sam/skills folder."
          skills={filtered.project}
          activeSkillIds={activeSkillIds}
          disabled={disabled}
          onToggle={onToggle}
        />
        <SkillGroup
          label="User"
          emptyNote="No skills in your user skills folder."
          skills={filtered.user}
          activeSkillIds={activeSkillIds}
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
      </PopoverContent>
    </Popover>
  )
}
