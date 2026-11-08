/**
 * Relative timestamps for the session list, e.g. "2h ago".
 *
 * The rule itself lives in `./time` now, beside the duration and the wall-clock stamp it shares a
 * subject with. This file is kept — not deleted, and not moved — because it is the name two call sites
 * and one node pin already import: keeping the export here is what let the rule change home without a
 * rename rippling through the UI, and it costs one line.
 */
export { formatRelativeTime } from './time'
