import { open } from 'fs/promises'
import { join } from 'path'
import { INSTRUCTIONS_CANDIDATES, MAX_INSTRUCTIONS_BYTES, TRUNCATION_NOTE } from '../protocol/context'

/**
 * Reading the project's instructions off the disk.
 *
 * Main-only, and separate from `agent.ts` so it has no electron import: that is what lets the node
 * suites exercise the real reader — the candidate order, the byte budget, the truncation marker —
 * rather than a reimplementation of it that could pass while the shipped code disagrees.
 *
 * Not a conveyor module of its own: the renderer never asks for the instructions. The agent loop
 * reads them per send, so they are recomputed from the file rather than stored anywhere.
 */

/** What was found, if anything. */
export interface ProjectInstructions {
  /**
   * The file that was read, as it was resolved against the workspace root.
   *
   * The path rather than the name: the caller records the *name*, because a transcript must stay
   * portable, and `instructionsFileName` is the one place that decides how a path becomes one.
   */
  path: string
  text: string
  /** True when the file was longer than the budget and only its head was read. */
  truncated: boolean
}

/**
 * The first existing instructions file at the workspace root, capped.
 *
 * The candidates are tried in order and the first one that exists wins — not the first that has
 * content, because a present-but-empty `SAMAI.md` is a deliberate statement that this project has no
 * instructions, and falling through to `AGENTS.md` would override that with something the author
 * chose to shadow.
 *
 * Only the budget's worth is ever read. The file is opened, `stat`ed and then read for exactly the
 * bytes wanted — the whole budget when it fits, and precisely the budget when it does not — so an
 * enormous instructions file cannot be pulled into memory whole. A file at or under the budget is
 * returned exactly as it is. `stat` is what decides which of those two applies, and it is taken on
 * the open handle so the size and the read describe the same file rather than racing a write.
 */
export async function readProjectInstructions(rootPath: string | null): Promise<ProjectInstructions | null> {
  if (!rootPath) return null

  for (const name of INSTRUCTIONS_CANDIDATES) {
    const path = join(rootPath, name)

    // Held open across the stat and the read, so nothing can swap the file between the two.
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, 'r')
    } catch {
      // Absent, or unreadable. Either way it is not this project's instructions, and the next
      // candidate is worth trying — an unreadable file must not abort the search.
      continue
    }

    try {
      const size = (await handle.stat()).size
      const wanted = Math.min(size, MAX_INSTRUCTIONS_BYTES)

      // Read only what will be kept. The buffer is allocated at the wanted length, so a 10 MB
      // instructions file costs the budget in memory rather than its own size — which is the whole
      // point of a byte cap, and was not true of the read-everything-then-slice version.
      const buffer = Buffer.alloc(wanted)
      let filled = 0
      while (filled < wanted) {
        const { bytesRead } = await handle.read(buffer, filled, wanted - filled, filled)
        // A short read that stops making progress means the file shrank underneath us; the bytes
        // already read are the honest answer, so this stops rather than spinning.
        if (bytesRead <= 0) break
        filled += bytesRead
      }
      const head = buffer.subarray(0, filled)

      if (size <= MAX_INSTRUCTIONS_BYTES) {
        return { path, text: head.toString('utf8'), truncated: false }
      }

      // Cut on the byte budget and mark it. `toString` stops at the boundary and drops any trailing
      // partial sequence, so the result is valid UTF-8 rather than a replacement character that reads
      // as corruption in the file.
      return { path, text: `${head.toString('utf8')}\n\n${TRUNCATION_NOTE}`, truncated: true }
    } catch {
      // Opened but not readable, or gone between the open and the stat. Same outcome as absent.
      continue
    } finally {
      await handle.close()
    }
  }

  return null
}
