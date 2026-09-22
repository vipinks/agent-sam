import { ConveyorError } from 'electron-conveyor/react'

/**
 * What a failed provider call says to the user, branched on the code main sent and never on its
 * message.
 *
 * Main answers with codes (`PROVIDER_UNREACHABLE`, `PROVIDER_LIST_FAILED`, `UNKNOWN_PROVIDER`) because a
 * code is what a caller can act on, and this is the one place each code becomes a sentence. Reading the
 * message instead would make the wording main's business, which is how a status number ends up inside
 * prose that has to be parsed back out to be shown.
 */

/**
 * The HTTP status main carried beside a code, or null when it carried none.
 *
 * Beside the code rather than in the message, so it is read from the error's issues — and read as data:
 * anything that is not a number is treated as absent rather than rendered.
 */
function httpStatus(error: ConveyorError): number | null {
  const issues = error.issues
  if (!issues || typeof issues !== 'object') return null
  const status = (issues as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

/** The sentence under a custom provider's box after a failed fetch. */
export function fetchNotice(error: unknown, name: string): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'PROVIDER_UNREACHABLE':
        return `${name} could not be reached. Check that the server is running and that the URL is right.`
      case 'PROVIDER_LIST_FAILED': {
        const status = httpStatus(error)
        return status === null
          ? `${name} answered with a catalogue this app could not read.`
          : `${name} refused to list its models (HTTP ${status}).`
      }
      case 'INVALID_INPUT':
        return `The URL saved for ${name} is not one this app can call.`
      default:
        return `${name} did not list its models.`
    }
  }
  return `${name} did not list its models.`
}

/** The sentence beside a key that main would not store. */
export function keySaveErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'ENCRYPTION_UNAVAILABLE':
        return 'No OS keychain is available, so this key was not saved.'
      case 'UNKNOWN_PROVIDER':
        return 'That provider is not supported.'
      case 'INVALID_INPUT':
        return 'That key does not look valid. Check it and try again.'
      default:
        return 'The key could not be saved.'
    }
  }
  return 'The key could not be saved.'
}
