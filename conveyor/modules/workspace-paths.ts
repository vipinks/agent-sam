import { dirname, isAbsolute, resolve, sep } from 'path'
import { existsSync, realpathSync } from 'fs'
import { ConveyorError } from 'electron-conveyor/main'

/**
 * Where a workspace-relative path is allowed to land.
 *
 * Split out from `workspace.ts` for two reasons: `workspace.ts` imports electron for the folder
 * dialog, and this needs to be exercised without an app; and containment is the kind of logic that
 * deserves to be read on its own rather than buried in a command body.
 */

/** Codes this module can raise, so callers branch on them rather than on wording. */
export type PathErrorCode = 'NO_WORKSPACE' | 'INVALID_PATH' | 'PATH_TRAVERSAL'

/** Reject a NUL byte: the OS truncates a path there, which would let the tail be anything at all. */
function assertNoNul(requested: string): void {
  if (requested.includes('\0')) {
    throw new ConveyorError('INVALID_PATH', 'That path contains a null byte.')
  }
}

/**
 * Resolve a requested path against the workspace root, refusing anything that escapes it.
 *
 * Two checks, because they catch different things. The lexical one rejects `../../etc/passwd`
 * before any disk access. The realpath one rejects a path that *looks* contained but reaches
 * outside through a symlink — `workspace/link -> /etc` — which is the case a string comparison
 * alone cannot see, because the string is genuinely fine.
 *
 * The target itself is allowed not to exist, since `write_file` creates intermediate directories,
 * so containment is checked against the nearest ancestor that does exist.
 */
export function resolveWorkspacePath(rootPath: string | null, requested: string): string {
  if (!rootPath) {
    throw new ConveyorError('NO_WORKSPACE', 'Open a folder before writing files.')
  }

  const trimmed = requested.trim()
  if (!trimmed) {
    throw new ConveyorError('INVALID_PATH', 'A file path is required.')
  }
  assertNoNul(trimmed)

  const root = resolve(rootPath)
  // An absolute request is accepted only if it already points inside; `resolve` collapses `..`
  // segments, so the comparison below sees the real destination.
  const target = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)

  if (target !== root && !target.startsWith(root + sep)) {
    throw new ConveyorError(
      'PATH_TRAVERSAL',
      `Refused: ${requested} is outside the open folder. Files can only be written inside the workspace.`
    )
  }

  assertRealPathInside(root, target, requested)
  return target
}

/**
 * Follow symlinks and confirm the destination still lands inside the workspace.
 *
 * The nearest existing ancestor is what gets resolved: for a new file the leaf does not exist yet,
 * but its parent chain does, and that is where a link would have to sit to redirect the write.
 */
function assertRealPathInside(root: string, target: string, requested: string): void {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    throw new ConveyorError('NO_WORKSPACE', 'The open folder no longer exists.')
  }

  let probe = target
  for (;;) {
    if (existsSync(probe)) break
    const parent = dirname(probe)
    // Reached the filesystem root without finding anything that exists.
    if (parent === probe) break
    probe = parent
  }

  let realProbe: string
  try {
    realProbe = realpathSync(probe)
  } catch {
    // Unreadable rather than absent — refuse instead of guessing.
    throw new ConveyorError('INVALID_PATH', `The location for ${requested} could not be inspected.`)
  }

  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
    throw new ConveyorError('PATH_TRAVERSAL', `Refused: ${requested} resolves outside the open folder through a link.`)
  }
}
