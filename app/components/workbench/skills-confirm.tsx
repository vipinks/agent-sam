/**
 * The confirm a skills write asks for, shared by the two surfaces that offer one.
 *
 * A skills write is rarely reversible and sometimes reaches past the window: switching a skill off takes
 * it away from every conversation holding it, deleting one takes the folder with it, and copying one
 * writes into the project. So each write is confirmed, and the confirm says what it is about — the source
 * and destination, the folder, and how many conversations are implicated — because a confirm a user cannot
 * check against the screen is one they have to take on trust.
 *
 * One dialog for all four writes, and one home for it. The tools panel toggles availability on exactly the
 * terms the settings card does, and two copies of the same sentence would be two places for the wording to
 * drift; so it lives here rather than in either surface, because neither of them owns it.
 */
import { skillFolderPath, type SkillSummary } from '@/conveyor/protocol/skills'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'

/** What one confirm is about: which skill, and which of the four writes it is. */
export interface PendingConfirm {
  kind: 'copy' | 'delete' | 'disable' | 'enable'
  skill: SkillSummary
}

/**
 * One confirm, for whichever write is waiting.
 *
 * The description is a string rather than markup because its whole job is to name the paths and the cost
 * in words a reader can check against what they are looking at. `holders` is how many conversations the
 * skill is active in, which the caller resolves — the store that knows is not this component's business.
 */
export function WriteConfirm({
  pending,
  failure,
  holders,
  projectDir,
  onOpenChange,
  onConfirm,
}: {
  pending: PendingConfirm | null
  failure: string | null
  holders: number
  projectDir: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const skill = pending?.skill ?? null
  const kind = pending?.kind ?? 'copy'

  return (
    <AlertDialog open={pending !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent data-slot="skill-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{skill ? confirmTitle(kind, skill) : 'Confirm'}</AlertDialogTitle>
          <AlertDialogDescription>{skill ? confirmWords(kind, skill, holders, projectDir) : ''}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure && (
          <p role="alert" data-slot="skill-confirm-failure" className="text-[12.5px] leading-relaxed text-destructive">
            {failure}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button type="button" variant={kind === 'delete' ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmAction(kind)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** What one confirm asks. */
function confirmTitle(kind: PendingConfirm['kind'], skill: SkillSummary): string {
  if (kind === 'copy') return `Copy ${skill.title} into the project?`
  if (kind === 'delete') return `Delete ${skill.title}?`
  if (kind === 'disable') return `Turn ${skill.title} off?`
  return `Turn ${skill.title} back on?`
}

/** What one confirm's button says: the verb, not "OK". */
function confirmAction(kind: PendingConfirm['kind']): string {
  if (kind === 'copy') return 'Copy into project'
  if (kind === 'delete') return 'Delete skill'
  if (kind === 'disable') return 'Turn it off'
  return 'Turn it on'
}

/**
 * What one confirm tells the user before they agree to it.
 *
 * Every sentence names the thing it is about — a folder, a destination — because a confirm a user cannot
 * check against the screen is a confirm they have to take on trust. The conversation count is said only
 * when a skill goes off, and only when there is one: becoming available again takes nothing away from
 * anybody, and saying "0 conversations" would suggest something was about to happen to none of them.
 */
function confirmWords(
  kind: PendingConfirm['kind'],
  skill: SkillSummary,
  holders: number,
  projectDir: string | null
): string {
  const folder = skillFolderPath(skill.sourcePath)
  if (kind === 'copy') {
    const destination = projectDir === null ? 'this project' : `${projectDir}/${skill.id}`
    return `The whole folder ${folder} will be copied to ${destination}, assets and all. A skill already in the project with this id is left alone and the copy is refused.`
  }
  if (kind === 'delete') {
    return `The folder ${folder} and everything in it will be deleted. ${conversationCost(holders)}`
  }
  if (kind === 'disable') {
    return `It disappears from the composer's picker, and stays on disk where it is. ${conversationCost(holders)}`
  }
  return 'It becomes available to the composer again, and stays off in every folder it is already off in. No conversation gets it back: availability is all this restores.'
}

/** How many conversations lose a skill, said in the only two ways it can be true. */
function conversationCost(holders: number): string {
  if (holders === 1) return '1 conversation has this skill active and will drop it.'
  if (holders > 1) return `${holders} conversations have this skill active and will drop it.`
  return 'No conversation has this skill active, so nothing else changes.'
}
