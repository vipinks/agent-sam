import type { ImageAttachmentRef } from './image-attachments'

/**
 * A message as it stands, and the rule that says whether a rewrite changed it.
 *
 * The app used to keep every version a message had been through beside it, one array per role, and a
 * pager walked them. Those arrays are gone: an edit and a regenerate are branch points now, and what
 * they keep is the conversation the message was written in rather than its former wording. What is
 * left here is the version in force — the turn's own text and chips — and the comparison that decides
 * whether a rewrite is a rewrite at all.
 *
 * Kept free of imports beyond the shape of an image reference, like the transcript protocol it is part
 * of, so a file written by either process is read the same way by both.
 */

/** One message as it stands: the text it says, and the chips it is carrying. */
export interface MessageVersion {
  content: string
  mentionPaths?: string[]
  imageRefs?: ImageAttachmentRef[]
}

/** The parts of a turn this rule reads. */
export interface VersionedMessage {
  content: string
  mentionPaths?: string[]
  imageRefs?: ImageAttachmentRef[]
}

/**
 * The version in force, as a value: what the turn says, and the chips it is holding.
 *
 * Derived from the turn rather than stored beside it, so there is exactly one place a message's text
 * lives and no way for a copy to disagree with it.
 */
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
 * The one thing this is for is the click that changes nothing. An editor opened and saved without an
 * edit commits no branch — a second trail that said exactly what the first said would leave the
 * switcher offering a walk between two identical conversations. Images are left out of the comparison
 * because an editor has no image controls: nothing it can do changes them.
 */
export function saysTheSameVersion(one: MessageVersion, other: MessageVersion): boolean {
  if (one.content !== other.content) return false
  const paths = one.mentionPaths ?? []
  const others = other.mentionPaths ?? []
  return paths.length === others.length && paths.every((path, index) => path === others[index])
}
