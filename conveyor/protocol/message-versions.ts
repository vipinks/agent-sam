import { z } from 'zod'
import { imageAttachmentRefSchema, type ImageAttachmentRef } from './image-attachments'

/**
 * The versions a message has been through, and the rule that reads them back.
 *
 * A conversation used to have one shape per message. Editing a message cut the transcript back to just
 * before it and sent what was left again, so the words the user changed were gone — and everything
 * written after them went with them, because it had been an answer to the old ones. A regenerate did the
 * same to a reply. Both are in place now: the message keeps its place and its id, and what the user had
 * *was* the message, so it is kept beside the new one rather than in place of it.
 *
 * Two arrays, one per role, because a turn is one message: `userVersions` on something the user sent,
 * `replyVersions` on an answer, each holding the versions that are *not* live, oldest first. What is
 * live is the turn's own `content` and `mentionPaths`, exactly as it always was — which is the whole of
 * why this shape is additive. Every reader of a message's text reads the field that holds the version in
 * force; every stored file stays valid; and no caller has to learn a new way of saying what a message
 * says.
 *
 * A turn with no array has been through one version, and that version is its content. An empty array is
 * never written, because absence is how "one version" is spelled — which is why `messageVersions` below
 * is the one place a count is derived rather than each caller counting for itself.
 *
 * Kept free of imports beyond the shape of an image reference, like the transcript protocol it is part
 * of, so a file written by either process is read the same way by both.
 */

/**
 * One version of a message: the text it said, and the chips it was carrying at the time.
 *
 * The chips are stored with the version rather than read from the turn because they are part of what the
 * version *was*: an edit that removed a file changed the message as much as the words did, and a reader
 * that showed the old text with the new chips would be showing a message that never existed. Images are
 * references for the reason they are references everywhere else — a transcript records the conversation,
 * not a copy of what it pointed at.
 *
 * Both chip fields are optional and additive. A version with no chips carries no key rather than an empty
 * array, the same rule every optional field in this app follows: `null` and `[]` would both be a second
 * way to say "none", and there is only one.
 */
export const messageVersionSchema = z.object({
  content: z.string(),
  mentionPaths: z.array(z.string()).optional(),
  imageRefs: z.array(imageAttachmentRefSchema).optional(),
})

export type MessageVersion = z.infer<typeof messageVersionSchema>

/** The parts of a turn the version rule reads: its role, its live message, and its archive. */
export interface VersionedMessage {
  role: 'user' | 'assistant'
  content: string
  mentionPaths?: string[]
  imageRefs?: ImageAttachmentRef[]
  userVersions?: MessageVersion[]
  replyVersions?: MessageVersion[]
}

/**
 * The versions this turn's message has been through, oldest first, with the live one last.
 *
 * The live one is derived from the turn rather than stored beside it, so there is exactly one place a
 * message's current text lives and no way for a stored copy to disagree with it. That is also why a turn
 * with no archive comes back as a single version here: "one version" and "no versions" are not two
 * states, and a caller that had to tell them apart would be inventing a third.
 */
export function messageVersions(turn: VersionedMessage): MessageVersion[] {
  const archived = turn.role === 'user' ? turn.userVersions : turn.replyVersions
  return [...(archived ?? []), liveMessageVersion(turn)]
}

/** The version in force, as a version entry: what the turn says, and the chips it is holding. */
export function liveMessageVersion(turn: VersionedMessage): MessageVersion {
  return {
    content: turn.content,
    ...(turn.mentionPaths && turn.mentionPaths.length > 0 ? { mentionPaths: [...turn.mentionPaths] } : {}),
    ...(turn.imageRefs && turn.imageRefs.length > 0
      ? { imageRefs: turn.imageRefs.map((image) => ({ ...image })) }
      : {}),
  }
}

/**
 * Whether two versions of one message say the same thing: the text, and the chips it carried.
 *
 * The one thing this is for is the click that changes nothing. An editor opened and saved without an edit
 * commits no new version — a second one that says exactly what the first said would leave the pager
 * offering a walk between two identical messages, which is a control with nothing to show. Images are
 * left out of the comparison because an editor has no image controls: nothing it can do changes them, so
 * they cannot be the difference between one version and two.
 */
export function saysTheSameVersion(one: MessageVersion, other: MessageVersion): boolean {
  if (one.content !== other.content) return false
  const paths = one.mentionPaths ?? []
  const others = other.mentionPaths ?? []
  return paths.length === others.length && paths.every((path, index) => path === others[index])
}
