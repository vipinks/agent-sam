/**
 * The terminal stream's wire protocol, shared by main and the renderer.
 *
 * Pure by necessity: `conveyor/modules/terminal.ts` owns the process and imports `child_process`,
 * so nothing in the renderer may import it — not even for two string constants. Both sides read
 * the markers from here instead, which also means the format is declared in exactly one place.
 *
 * The protocol, as `terminal.ts` emits it:
 *   - stdout arrives verbatim;
 *   - stderr arrives prefixed with `STDERR_MARKER`;
 *   - the final chunk is `EXIT_MARKER` + the code + `]`.
 */

/** Prefixes a stderr chunk so the renderer can colour it without a second channel. */
export const STDERR_MARKER = '[STDERR]'

/** Opens the exit-code chunk, e.g. `[EXIT_CODE:0]`. */
export const EXIT_MARKER = '[EXIT_CODE:'

/** Matches a whole exit chunk. Anchored: a command printing this text must not look like an exit. */
export const EXIT_PATTERN = /^\[EXIT_CODE:(-?\d+)\]$/
