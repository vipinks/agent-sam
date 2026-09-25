/**
 * What a skills surface says when something failed.
 *
 * Two surfaces now draw the same read and make one of the same writes: the settings screen's Skills
 * section, which is where a skill is created, copied, deleted and edited, and the tools panel, which is
 * where one is switched on or off. A failure is a fact about the read or the write rather than about the
 * surface that asked for it, so the sentences live here and both import them — a second wording map would
 * be a second chance for the two to explain one code differently.
 *
 * Every sentence is chosen by `error.code` and never by its message text: the code is a fact about which
 * part of the operation failed, and the message is main's to reword.
 */
import { ConveyorError } from 'electron-conveyor/react'
import type { SkillScope } from '@/conveyor/protocol/skills'

/**
 * What a failure of the whole listing says.
 *
 * A code is a fact about which part of the read failed, and each part has a different answer for the
 * reader: an unreadable folder is something they can fix and try again, and a folder that has gone is
 * something only reopening the project can settle. The per-skill codes are listed rather than left to a
 * default because none of them should arrive here at all — a read of the whole library does not raise one
 * — so if one does, main's own sentence about it is more use than this module's guess. A failure that is
 * not one of ours is the one case with nothing to say beyond the plain fact.
 */
export function listingFailure(error: unknown): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'SKILL_IO_ERROR':
        return 'The skill folders could not be opened. Check that they are readable, then reopen this screen.'
      case 'SKILL_NOT_FOUND':
        return 'A folder this screen was reading is gone. Reopen the project, then try again.'
      case 'SKILL_PARSE_INVALID':
      case 'SKILL_MANIFEST_INVALID':
      case 'SKILL_TOO_LARGE':
      case 'SKILL_LIMIT_EXCEEDED':
      case 'SKILL_ID_TAKEN':
        return error.message
    }
    return error.message
  }
  return 'The skill folders could not be read.'
}

/**
 * What a failed write says beside the control that started it.
 *
 * The one code worth its own words is the one the user can act on without knowing anything about files: a
 * name that is already taken, which they change by editing an id.
 */
export function writeFailure(error: unknown): string {
  if (error instanceof ConveyorError) {
    if (error.code === 'SKILL_ID_TAKEN') return 'A skill with that id is already in the project.'
    return error.message
  }
  return 'That change could not be written.'
}

/** How a scope reads in a sentence, said once so every surface that names one agrees. */
export function scopeLabel(scope: SkillScope): string {
  return scope === 'project' ? 'this project' : 'your skills folder'
}
