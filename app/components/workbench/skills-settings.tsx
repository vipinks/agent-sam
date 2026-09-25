/**
 * Skills: the four folders a skill may come from, what is in each, and what the user may do to one.
 *
 * Five controls, and each is offered only where it can be carried out. Create and delete belong to the
 * two folders this app writes; copy is offered on every tier, because reading another agent's folder is
 * the point of a copy; edit opens the file in the explorer's editor, which is the one editor this app
 * has; and the switch is offered everywhere, because availability is a preference this app keeps *about*
 * a folder rather than a change it makes in one.
 *
 * Which tiers those are is read from `protocol/skills` and never from a file, so a card cannot claim to
 * be editable by saying so in its frontmatter, and the compatibility blocks say read-only because their
 * *tier* is read-only. The two tiers that are writable are the same list the create dialog offers, so a
 * screen cannot offer a destination the module would refuse.
 *
 * Every rule the drawing depends on — which tier wins a collision, what the counts are, which tiers are
 * read-only, what a whole-listing failure means — is decided in the protocol or in main, and this file
 * only says it. Load errors are drawn beside the skills that did load, each with the code main named: a
 * folder that could not be read is worth knowing about and is not a reason to hide the rest of the list.
 *
 * Expansions are per card and lazy. The list itself stays metadata-only — one read returns every skill's
 * name, path and summary, and no bodies — so opening this screen over a library of a thousand skills
 * reads one file's worth of frontmatter per skill and nothing else.
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import {
  isReadOnlyTier,
  isSafeSkillId,
  isSkillHidden,
  MAX_ACTIVE_SKILLS,
  MAX_SKILL_ID_CHARS,
  tierById,
  tierKindOf,
  WRITABLE_SKILL_TIERS,
  type DisabledSkillRef,
  type SkillListing,
  type SkillLoadError,
  type SkillScope,
  type SkillSummary,
  type SkillTierId,
  type SkillTierListing,
} from '@/conveyor/protocol/skills'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { MarkdownContent } from './markdown'
import { WriteConfirm, type PendingConfirm } from './skills-confirm'
// The failure sentences and the write confirm used to be defined in this file. They live in
// `./skills-notices` and `./skills-confirm` now, and this screen imports them rather than keeping copies:
// the tools panel draws the same read and makes one of the same writes, so one code has to have one
// sentence and one dialog. Their bodies are unchanged, and the panel imports both modules as well.
import { listingFailure, scopeLabel, writeFailure } from './skills-notices'
import { useWorkbenchStore } from './store'

export function SkillsSection() {
  const listing = conveyor.skills.listSkills.useQuery()

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Skills</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Skills are instructions a conversation can be given. Sam reads them from this project and from your own skills
          folders, and everything below is a folder on disk.
        </p>
        {/* The two axes, said once. A reader who cannot tell whether a switch here affects the open
            conversation or the whole library will read the answer off this line rather than guess. */}
        <p data-slot="skills-axes" className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          This screen decides whether a skill is available. Each conversation attaches up to {MAX_ACTIVE_SKILLS}{' '}
          available skills from the composer.
        </p>
      </header>

      {listing.isPending && <p className="text-[13px] text-muted-foreground">Reading the skill folders…</p>}

      {listing.isError && (
        <p data-slot="skills-read-error" role="status" className="text-[13px] leading-relaxed text-muted-foreground">
          {listingFailure(listing.error)}
        </p>
      )}

      {listing.data && <SkillsList listing={listing.data} onChanged={() => void listing.refetch()} />}
    </>
  )
}

/**
 * The counts, then the tiers.
 *
 * The counts come from the listing rather than from counting what is below, so the two cannot disagree:
 * main already merged the tiers and knows which skills won their collisions, and a screen that recounted
 * could only ever count something else. The hidden count is its own number beside the totals — a skill the
 * user switched off is not a failure, and folding it into the error count would report a healthy library
 * as a broken one.
 *
 * One dialog is drawn for the section rather than one per card: a confirm is about one row at a time, and
 * a state object holding that row is what lets the dialog say which paths it is about.
 */
function SkillsList({ listing, onChanged }: { listing: SkillListing; onChanged: () => void }) {
  const { counts } = listing
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const copy = conveyor.skills.copySkillIntoProject.useMutation()
  const remove = conveyor.skills.deleteSkill.useMutation()
  const availability = conveyor.skills.setSkillAvailability.useMutation()

  /** The project's own folder, as main reported it — absent when no project is open. */
  const projectDir = listing.tiers.find((tier) => tier.tier === 'project-native')?.sourceDir ?? null

  /** How many conversations hold one id, which is what a confirm has to be able to say. */
  const holders = (skillId: string): number => sessions.filter((s) => s.activeSkillIds?.includes(skillId)).length

  /**
   * Run one confirmed write, and say what happened if it fails.
   *
   * The dialog stays open on a refusal rather than closing over it: a copy that lost a race with another
   * window is a `SKILL_ID_TAKEN`, and the user is the one who has to decide what to do about a name that
   * is already taken.
   */
  async function runPending(): Promise<void> {
    if (!pending) return
    const { kind, skill } = pending
    const target = { scope: skill.scope, tier: tierKindOf(skill.tier), skillId: skill.id }
    try {
      if (kind === 'copy') await copy.mutateAsync(target)
      if (kind === 'delete') await remove.mutateAsync(target)
      if (kind === 'disable') await availability.mutateAsync({ ...target, disabled: true })
      if (kind === 'enable') await availability.mutateAsync({ ...target, disabled: false })
      setPending(null)
      setFailure(null)
      onChanged()
    } catch (error) {
      setFailure(writeFailure(error))
    }
  }

  return (
    <>
      <div
        data-slot="skills-counts"
        className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2.5 text-[12.5px] text-muted-foreground"
      >
        <span className="font-medium text-foreground">
          {counts.total} {counts.total === 1 ? 'skill' : 'skills'}
        </span>
        <span>{counts.project} project</span>
        <span>{counts.user} user</span>
        {counts.hidden > 0 && <span data-slot="skills-hidden-count">{counts.hidden} hidden</span>}
        {counts.errors > 0 && (
          <span data-slot="skills-error-count" className="text-destructive">
            {counts.errors} {counts.errors === 1 ? 'error' : 'errors'}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2 text-[11.5px]"
          onClick={() => setCreating(true)}
        >
          New skill
        </Button>
      </div>

      {/* Errors first, above the tiers: a file that would not load is the thing a reader needs to act on,
          and it is not part of any tier's contents. */}
      {listing.errors.length > 0 && (
        <div className="mb-5 flex flex-col gap-1.5">
          {listing.errors.map((error) => (
            <SkillErrorRow key={`${error.tier}:${error.id}`} error={error} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-6">
        {listing.tiers.map((tier) => (
          <TierBlock
            key={tier.tier}
            tier={tier}
            disabled={listing.disabled}
            projectDir={projectDir}
            onAsk={setPending}
          />
        ))}
      </div>

      <CreateSkillDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setCreating(false)
          onChanged()
        }}
      />

      <WriteConfirm
        pending={pending}
        failure={failure}
        holders={pending ? holders(pending.skill.id) : 0}
        projectDir={projectDir}
        onOpenChange={(open) => {
          if (open) return
          setPending(null)
          setFailure(null)
        }}
        onConfirm={() => void runPending()}
      />
    </>
  )
}

/**
 * One folder's worth of skills.
 *
 * A tier with nothing in it is drawn as an empty block rather than omitted: an absent section would read
 * as a folder that had been deleted, and "there is nothing in your user skills folder" is exactly the
 * thing a reader is here to find out. The read-only badge is the tier's own property, read from the tier
 * table, so a file inside `.agents` cannot claim to be editable by saying so in its frontmatter.
 */
function TierBlock({
  tier,
  disabled,
  projectDir,
  onAsk,
}: {
  tier: SkillTierListing
  disabled: readonly DisabledSkillRef[]
  projectDir: string | null
  onAsk: (pending: PendingConfirm) => void
}) {
  const readOnly = isReadOnlyTier(tier.tier)

  return (
    <section data-slot={`skills-tier-${tier.tier}`}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-medium">
          {tier.scope === 'project' ? 'Project' : 'User'} · {tierKindOf(tier.tier)}
        </h2>
        {readOnly && (
          <Badge variant="outline" className="text-[10.5px] text-muted-foreground">
            read-only
          </Badge>
        )}
      </div>
      {/* The muted path is the tier's own folder, so a reader can see where this block came from without
          expanding anything. */}
      {tier.sourceDir && (
        <p className="mb-2 truncate text-[11px] text-muted-foreground" title={tier.sourceDir}>
          {tier.sourceDir}
        </p>
      )}

      {tier.skills.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No skills in this folder.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {tier.skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              hidden={isSkillHidden(disabled, tier.tier, skill.id)}
              projectDir={projectDir}
              onAsk={onAsk}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One skill, and the four things that can be done to it.
 *
 * The body is fetched when the card is opened and not before: `enabled` is what keeps that promise, since
 * the query is declared on every card, as hooks must be, and only the expanded one is ever asked for.
 *
 * Edit selects the file in the workbench store, which is the same thing the explorer's file tree does on
 * a click and therefore opens the same guarded editor on it: clearing the selected change first is part
 * of that, because a card opens a file rather than a diff and a stale change would take the pane.
 */
function SkillCard({
  skill,
  hidden,
  projectDir,
  onAsk,
}: {
  skill: SkillSummary
  hidden: boolean
  projectDir: string | null
  onAsk: (pending: PendingConfirm) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const kind = tierKindOf(skill.tier)
  const readOnly = isReadOnlyTier(skill.tier)
  const body = conveyor.skills.getSkillBody.useQuery({
    input: { scope: skill.scope, tier: kind, skillId: skill.id },
    enabled: expanded,
    retry: false,
  })

  /** Open this skill's file the way the explorer opens a file. */
  function openInEditor(): void {
    const setSelectedFile = useWorkbenchStore.getState().setSelectedFile
    useWorkbenchStore.getState().setSelectedChange(null)
    setSelectedFile(skill.sourcePath)
  }

  return (
    <div data-slot="skill-card" data-skill-id={skill.id} className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{skill.title}</p>
          <p className="truncate text-[11px] text-muted-foreground" title={skill.sourcePath}>
            {skill.sourcePath}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{skill.summary || skill.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Badge variant="secondary" className="text-[10.5px]">
            {skill.scope}
          </Badge>
          <Badge variant="outline" className="text-[10.5px]">
            {kind}
          </Badge>
          {hidden && (
            <Badge variant="outline" className="text-[10.5px] text-muted-foreground" data-slot="skill-hidden-badge">
              hidden
            </Badge>
          )}
          {/* Availability is offered on every tier, a compatibility one included: a switch is a preference
              this app keeps about another agent's folder, not a write into it. */}
          <Switch
            checked={!hidden}
            aria-label={`${skill.title} is available`}
            onCheckedChange={() => onAsk({ kind: hidden ? 'enable' : 'disable', skill })}
          />
          {projectDir !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11.5px]"
              aria-label={`Copy ${skill.title} into the project`}
              onClick={() => onAsk({ kind: 'copy', skill })}
            >
              Copy
            </Button>
          )}
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11.5px]"
              aria-label={`Edit ${skill.title}`}
              onClick={openInEditor}
            >
              Edit
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[11.5px]"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${skill.title}`}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11.5px] text-destructive"
              aria-label={`Delete ${skill.title}`}
              onClick={() => onAsk({ kind: 'delete', skill })}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div data-slot="skill-body" className="mt-3 border-t border-border pt-3">
          {body.isPending && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Reading {skill.id}…
            </p>
          )}
          {body.isError && (
            <p className="text-[12px] text-muted-foreground">This skill&rsquo;s file could not be read.</p>
          )}
          {body.data && (
            /*
              The app's own renderer, the same one the transcript and the file preview use. A second
              markdown view here would be a second set of behaviours to keep in step with this one.
            */
            <div className="max-h-96 overflow-auto text-[12.5px]">
              <MarkdownContent content={body.data.body} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The create dialog: two destinations, and what the new file says.
 *
 * The id is checked twice on purpose. Here with the protocol's own rule, which is what puts a refusal on
 * the field the user is looking at before anything is sent; and again in main, which is the check that
 * counts, because a folder name is about to be built from it. A duplicate id cannot be found out here at
 * all — only main knows what is on disk — so it arrives as `SKILL_ID_TAKEN` and lands on the same field,
 * which is the field the user has to change.
 */
function CreateSkillDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const create = conveyor.skills.createSkill.useMutation()
  const [scope, setScope] = useState<SkillScope>('project')
  const [skillId, setSkillId] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [idError, setIdError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  /** Empty the form, so the next skill starts from nothing rather than from the last one's text. */
  function reset(): void {
    setSkillId('')
    setTitle('')
    setSummary('')
    setBody('')
    setIdError(null)
    setFailure(null)
  }

  async function submit(): Promise<void> {
    const id = skillId.trim()
    if (!isSafeSkillId(id)) {
      setIdError(
        `An id has to be lower-case letters, digits and single hyphens, up to ${MAX_SKILL_ID_CHARS} characters. It becomes the folder name.`
      )
      return
    }
    setIdError(null)
    setFailure(null)
    try {
      await create.mutateAsync({ scope, tier: 'native', skillId: id, title, summary, body })
      reset()
      onCreated()
    } catch (error) {
      if (error instanceof ConveyorError && error.code === 'SKILL_ID_TAKEN') {
        setIdError(
          `A skill with this id already exists in ${scope === 'project' ? 'this project' : 'your skills folder'}. Choose another id.`
        )
        return
      }
      if (error instanceof ConveyorError && error.code === 'SKILL_PARSE_INVALID') {
        setIdError(error.message)
        return
      }
      setFailure(writeFailure(error))
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <AlertDialogContent data-slot="skill-create">
        <AlertDialogHeader>
          <AlertDialogTitle>New skill</AlertDialogTitle>
          <AlertDialogDescription>
            A skill is a folder holding a SKILL.md. Sam writes the file for you; you can edit it afterwards from the
            card.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium">Where</span>
            <div className="flex gap-2">
              {/* Only the two writable tiers are offered, from the same list main refuses everything else
                  by, so this screen cannot name a destination a write would be rejected for. */}
              {WRITABLE_SKILL_TIERS.map((tier: SkillTierId) => (
                <Button
                  key={tier}
                  type="button"
                  size="sm"
                  variant={tierById(tier).scope === scope ? 'secondary' : 'outline'}
                  aria-pressed={tierById(tier).scope === scope}
                  onClick={() => setScope(tierById(tier).scope)}
                >
                  {tierById(tier).scope === 'project' ? 'Project · native' : 'User · native'}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-create-id">Id</Label>
            <Input
              id="skill-create-id"
              value={skillId}
              placeholder="release-notes"
              onChange={(event) => setSkillId(event.target.value)}
            />
            {idError && (
              <p
                role="alert"
                data-slot="skill-create-id-error"
                className="text-[11.5px] leading-relaxed text-destructive"
              >
                {idError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-create-title">Title</Label>
            <Input id="skill-create-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-create-summary">Summary</Label>
            <Input id="skill-create-summary" value={summary} onChange={(event) => setSummary(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-create-body">Body</Label>
            <Textarea id="skill-create-body" rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
          </div>

          {failure && (
            <p role="alert" data-slot="skill-create-failure" className="text-[11.5px] leading-relaxed text-destructive">
              {failure}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* Not an `AlertDialogAction`: that closes the dialog on click, and a refusal has to leave the
              form open with the field the user has to change still in front of them. */}
          <Button type="button" onClick={() => void submit()}>
            Create skill
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A file that could not be read, in the module's own words, with the code it was named. */
function SkillErrorRow({ error }: { error: SkillLoadError }) {
  return (
    <div data-slot="skill-error" className="flex items-start gap-2 rounded-lg border border-destructive/35 px-3 py-2">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[12.5px] text-foreground">{error.id}</span>
        <span className="block text-[11.5px] text-muted-foreground">
          {scopeLabel(error.scope)} · {error.tier} — {error.message} ({error.code})
        </span>
      </span>
    </div>
  )
}
